import { Body, Controller, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, type OnApplicationBootstrap } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { SettingsModule, SettingsService } from "../settings/settings.module.ts";
import { StoriesModule, StoryEngine } from "../stories/stories.module.ts";
import { zod } from "../common/zod.pipe.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { CATEGORIES } from "../references/platform.ts";
import { ProductionService } from "./production.service.ts";
import { PublishingModule, PublishingService } from "../publishing/publishing.module.ts";
import type { Language, StoryCategory } from "../generated/prisma/client.ts";

interface NewReelJob { category: StoryCategory; language?: Language; referenceIds?: string[]; scheduleRunId?: string | null }

/**
 * Orchestration: "new-reel" jobs (story → production) and the daily schedule.
 * Both run on the production queue (concurrency 1) so the LLM and the image model never compete for RAM.
 * Nothing here publishes: finished reels wait in the Review Studio.
 */
@Injectable()
export class Orchestrator implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly stories: StoryEngine,
    private readonly production: ProductionService,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
    private readonly publishing: PublishingService,
  ) {}

  onApplicationBootstrap() {
    // heavy AI work is serialized on the production queue (one model in RAM at a time)
    this.production.handlers.set("story", async (job) => (await this.stories.generate(job.data)).id);
    this.production.handlers.set("new-reel", async (job) => {
      const d = job.data as NewReelJob;
      const { id } = await this.stories.generate({ category: d.category, language: d.language, referenceIds: d.referenceIds });
      return this.production.start(id, d.scheduleRunId ?? null);
    });
    // "request changes": revise the story with the creator's feedback, then render a new version
    this.production.handlers.set("revise", async (job) => {
      const d = job.data as { projectId: string; storyId: string; feedback: string };
      const story = await this.prisma.story.findUniqueOrThrow({ where: { id: d.storyId } });
      await this.stories.generate({ category: story.category, language: story.language, reviseStoryId: d.storyId, feedback: d.feedback });
      return this.production.rerender(d.projectId);
    });
    this.queues.process("maintenance", async (job) => {
      if (job.name === "daily-generation") await this.dailyRun();
      if (job.name === "analytics") await this.publishing.refreshAnalytics();
    });
  }

  async newReel(data: NewReelJob): Promise<string> {
    return this.queues.enqueue("production", "new-reel", data as unknown as Record<string, unknown>, { attempts: 2 });
  }

  /** Daily automation: plan today's target, rotate categories, never publish. */
  async dailyRun() {
    const s = await this.settings.schedule();
    if (!s.enabled) return;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const run = await this.prisma.scheduleRun.upsert({ where: { scheduleId_runDate: { scheduleId: s.id, runDate: today } }, create: { scheduleId: s.id, runDate: today, planned: s.targetCount }, update: {} });
    const already = await this.prisma.videoProject.count({ where: { scheduleRunId: run.id } });
    const queued = await this.queues.queue("production").getJobs(["waiting", "active", "delayed"]);
    const pending = queued.filter((j) => j.name === "new-reel" && (j.data as NewReelJob).scheduleRunId === run.id).length;
    const missing = Math.max(0, s.targetCount - already - pending);
    for (let i = 0; i < missing; i++) {
      const category = s.categories[(already + pending + i) % s.categories.length] as StoryCategory;
      await this.newReel({ category, language: s.language, scheduleRunId: run.id });
    }
    await this.activity.record({ entityType: "schedule", entityId: run.id, action: "daily_run", message: `Daily run ${today}: ${missing} new reel(s) queued (target ${s.targetCount}, already ${already + pending})` });
  }
}

const NewReelBody = z.object({ category: z.enum(CATEGORIES), language: z.enum(["en", "hi", "hinglish"]).optional(), referenceIds: z.array(z.string().uuid()).max(5).optional() });

@Controller()
class ProductionController {
  constructor(private readonly orchestrator: Orchestrator, private readonly production: ProductionService, private readonly prisma: PrismaService, private readonly activity: ActivityService) {}

  /** Story + reel in one go (what the daily schedule does, on demand). */
  @Post("reels/generate")
  @Roles("owner", "editor")
  async generate(@Body(zod(NewReelBody)) b: z.infer<typeof NewReelBody>, @CurrentUser() u: SessionUser) {
    const jobId = await this.orchestrator.newReel(b);
    await this.activity.record({ entityType: "project", action: "generation_requested", message: `New reel requested: ${b.category}`, actorUserId: u.id });
    return { jobId };
  }

  /** Produce a reel from an existing story. */
  @Post("stories/:id/produce")
  @Roles("owner", "editor")
  async produce(@Param("id", ParseUUIDPipe) id: string) {
    const s = await this.prisma.story.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw new NotFoundException("Story not found");
    return { projectId: await this.production.start(id) };
  }

  @Post("automation/run-now")
  @Roles("owner")
  async runNow() {
    await this.orchestrator.dailyRun();
    return { ok: true };
  }
}

@Module({ imports: [SettingsModule, StoriesModule, PublishingModule], controllers: [ProductionController], providers: [ProductionService, Orchestrator], exports: [ProductionService, Orchestrator] })
export class ProductionModule {}
