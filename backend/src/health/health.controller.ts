import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Redis } from "ioredis";
import { PrismaService } from "../prisma/prisma.service.ts";
import { REDIS } from "../redis/redis.module.ts";
import type { AppEnv } from "../config/env.ts";
import { Public } from "../auth/decorators.ts";

interface Check { ok: boolean; detail: string; latencyMs: number }

/** Runs a check with a hard deadline so one dead dependency can't hang the endpoint. */
async function timed(fn: () => Promise<string>, timeoutMs = 4000): Promise<Check> {
  const t = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); });
  try {
    return { ok: true, detail: await Promise.race([fn(), deadline]), latencyMs: Date.now() - t };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - t };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Real dependency checks — every entry reflects an actual round-trip. */
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  @Public()
  @Get()
  async health() {
    const ollama = this.config.get("OLLAMA_URL", { infer: true });
    const [database, redis, llm, media, reference] = await Promise.all([
      timed(async () => { await this.prisma.$queryRaw`SELECT 1`; return "postgres reachable"; }),
      timed(async () => `redis ${await this.redis.ping()}`),
      timed(async () => {
        const tags = (await getJson(`${ollama}/api/tags`)) as { models: { name: string }[] };
        const want = [this.config.get("OLLAMA_TEXT_MODEL", { infer: true }), this.config.get("OLLAMA_VISION_MODEL", { infer: true })];
        const missing = want.filter((m) => !tags.models.some((x) => x.name === m || x.name === `${m}:latest`));
        if (missing.length) throw new Error(`Ollama running; missing models: ${missing.join(", ")}`);
        return `models ready: ${want.join(", ")}`;
      }),
      timed(async () => { await getJson(`${this.config.get("MEDIA_SERVICE_URL", { infer: true })}/health`); return "media-service up"; }),
      timed(async () => { await getJson(`${this.config.get("REFERENCE_SERVICE_URL", { infer: true })}/health`); return "reference-service up"; }),
    ]);
    const checks = { database, redis, llm, media, reference };
    return { status: database.ok && redis.ok ? "ok" : "degraded", checks, time: new Date().toISOString() };
  }
}
