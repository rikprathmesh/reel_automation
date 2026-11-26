import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from "@nestjs/common";
import { Controller, Get } from "@nestjs/common";
import { FlowProducer, Queue, Worker, type FlowJob, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { REDIS } from "../redis/redis.module.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { EventsService } from "../events/events.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import type { GenerationStage, Prisma } from "../generated/prisma/client.ts";

/**
 * Queues:
 *  reference   – reference extraction + analysis
 *  story       – story / script generation (LLM)
 *  production  – full reel production (images → voice → animation → audio → edit → render → validate)
 *  publishing  – uploads to YouTube / Instagram (delayed jobs = scheduled posts)
 *  maintenance – daily schedule tick, analytics refresh
 * Production runs with concurrency 1: this CPU-only machine can run one heavy model at a time.
 */
export const QUEUE_NAMES = ["reference", "story", "production", "publishing", "maintenance"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const CONCURRENCY: Record<QueueName, number> = { reference: 1, story: 1, production: 1, publishing: 1, maintenance: 1 };
/** CPU renders can block a starved machine for a long time; a lock must outlive one slow image so jobs aren't re-run. */
const LOCK_MS: Record<QueueName, number> = { reference: 30 * 60_000, story: 30 * 60_000, production: 90 * 60_000, publishing: 30 * 60_000, maintenance: 10 * 60_000 };

export type Processor = (job: Job) => Promise<unknown>;
export type FailureHandler = (job: Job, error: Error) => Promise<void>;

@Injectable()
export class QueuesService implements OnModuleDestroy {
  private readonly log = new Logger("Queues");
  private readonly queues: Record<QueueName, Queue>;
  private readonly workers: Worker[] = [];
  private flowProducer: FlowProducer | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly activity: ActivityService) {
    this.queues = Object.fromEntries(
      QUEUE_NAMES.map((q) => [q, new Queue(q, { connection: redis.duplicate(), defaultJobOptions: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } } })]),
    ) as Record<QueueName, Queue>;
  }

  async enqueue(queue: QueueName, name: string, data: Record<string, unknown>, opts: JobsOptions = {}): Promise<string> {
    const job = await this.queues[queue].add(name, data, { attempts: 2, backoff: { type: "exponential", delay: 60_000 }, ...opts });
    return job.id!;
  }

  /** Removes a waiting/delayed job; returns false if it already started or finished. */
  async cancel(queue: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queues[queue].getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (!["waiting", "delayed", "prioritized"].includes(state)) return false;
    await job.remove();
    return true;
  }

  /** Registers the worker for a queue. Final failures (all retries used) call onFinalFailure. */
  process(queue: QueueName, processor: Processor, onFinalFailure?: FailureHandler) {
    const w = new Worker(queue, processor, { connection: this.redis.duplicate(), concurrency: CONCURRENCY[queue], lockDuration: LOCK_MS[queue], stalledInterval: 5 * 60_000, maxStalledCount: 1 });
    w.on("failed", (job, err) => {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1);
      void this.activity.record({
        entityType: "job", entityId: job.id ?? null, action: final ? "job_failed" : "job_retry", level: final ? "error" : "warn",
        message: `${queue}/${job.name} attempt ${job.attemptsMade}/${job.opts.attempts ?? 1} failed${final ? "" : " — will retry"}: ${err.message}`,
      });
      if (final && onFinalFailure) void onFinalFailure(job, err).catch((e: unknown) => this.log.error(`failure handler: ${String(e)}`));
    });
    w.on("error", (e) => this.log.error(`[${queue}] ${e.message}`));
    this.workers.push(w);
  }

  /**
   * Adds a job graph: the parent runs only after every child completed (fan-out / fan-in).
   * Children use failParentOnFailure so a scene that fails for good fails its merge too.
   */
  async addFlow(flow: FlowJob) {
    this.flowProducer ??= new FlowProducer({ connection: this.redis.duplicate() });
    return this.flowProducer.add(flow);
  }

  queue(name: QueueName): Queue {
    return this.queues[name];
  }

  async counts() {
    const out: Record<string, Record<string, number>> = {};
    for (const q of QUEUE_NAMES) out[q] = await this.queues[q].getJobCounts("waiting", "active", "delayed", "failed", "completed");
    return out;
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close()));
    await this.flowProducer?.close();
    await Promise.all(QUEUE_NAMES.map((q) => this.queues[q].close()));
  }
}

/**
 * Mirrors production jobs into VideoGenerationJob (status, stage, progress, attempts, error, timestamps)
 * so history survives Redis and the dashboard can show progress.
 */
@Injectable()
export class JobTracker {
  constructor(private readonly prisma: PrismaService, private readonly events: EventsService) {}

  async create(projectId: string, bullJobId: string, maxAttempts: number) {
    return this.prisma.videoGenerationJob.create({ data: { projectId, bullJobId, maxAttempts, status: "queued" } });
  }

  async start(bullJobId: string, attempt: number) {
    const j = await this.prisma.videoGenerationJob.update({ where: { bullJobId }, data: { status: "active", attempt, startedAt: new Date() } });
    this.emit(j);
  }

  async progress(bullJobId: string, stage: GenerationStage, progress: number) {
    const j = await this.prisma.videoGenerationJob.update({ where: { bullJobId }, data: { stage, progress: Math.max(0, Math.min(100, Math.round(progress))) } });
    this.emit(j);
  }

  async complete(bullJobId: string) {
    const j = await this.prisma.videoGenerationJob.update({ where: { bullJobId }, data: { status: "completed", progress: 100, completedAt: new Date() } });
    this.emit(j);
  }

  async fail(bullJobId: string, error: Error, final: boolean) {
    const j = await this.prisma.videoGenerationJob.update({
      where: { bullJobId },
      data: { status: final ? "failed" : "retrying", error: { message: error.message, at: new Date().toISOString() } as Prisma.InputJsonValue, completedAt: final ? new Date() : null },
    });
    this.emit(j);
  }

  private emit(j: { id: string; projectId: string; status: string; stage: string; progress: number; attempt: number; error: unknown }) {
    this.events.emit("job", { id: j.id, projectId: j.projectId, status: j.status, stage: j.stage, progress: j.progress, attempt: j.attempt, error: j.error });
  }
}

@Controller("queues")
class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  @Get()
  counts() {
    return this.queues.counts();
  }
}

@Global()
@Module({ controllers: [QueuesController], providers: [QueuesService, JobTracker], exports: [QueuesService, JobTracker] })
export class QueuesModule {}
