import { BadRequestException, Controller, Get, Inject, Param, Post, ServiceUnavailableException } from "@nestjs/common";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { ConfigService } from "@nestjs/config";
import type { Redis } from "ioredis";
import { PrismaService } from "../prisma/prisma.service.ts";
import { REDIS } from "../redis/redis.module.ts";
import type { AppEnv } from "../config/env.ts";
import { CurrentUser, Public, Roles, type SessionUser } from "../auth/decorators.ts";
import { ActivityService } from "../activity/activity.service.ts";

/** Services the dashboard can start. Each maps to a fixed case in scripts/start-service.ps1; nothing user-supplied reaches the shell. */
const STARTABLE = ["database", "redis", "llm", "comfyui", "media", "reference"] as const;
type Startable = (typeof STARTABLE)[number];
const START_SCRIPT = path.resolve(process.cwd(), "..", "scripts", "start-service.ps1");

function runStartScript(name: Startable): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", START_SCRIPT, "-Name", name], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      const lines = (t: string | Buffer) => t.toString().trim().split(/\r?\n/).filter(Boolean);
      // PowerShell's "throw" message is the first stderr line that isn't position/context noise
      if (err) reject(new Error(lines(stderr).find((l) => !/^(At |\+|\s*\+|CategoryInfo|FullyQualifiedErrorId)/.test(l.trim())) ?? err.message));
      else resolve(lines(stdout).pop() ?? "");
    });
  });
}

interface Check { ok: boolean; detail: string; latencyMs: number; busy?: boolean }

/**
 * Runs a check with a hard deadline so one dead dependency can't hang the endpoint.
 * A service that is running but slow (the CPU is saturated while the LLM or image model works) is reported as
 * "busy", not down: a stopped service refuses the connection immediately and still shows as down.
 */
async function timed(fn: () => Promise<string>, timeoutMs = 4000, slowOk = false): Promise<Check> {
  const t = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); });
  try {
    return { ok: true, detail: await Promise.race([fn(), deadline]), latencyMs: Date.now() - t };
  } catch (e) {
    const timedOut = e instanceof Error && (e.message.startsWith("timed out") || e.name === "TimeoutError");
    if (slowOk && timedOut) return { ok: true, busy: true, detail: "busy: answering slowly while AI work runs on this machine", latencyMs: Date.now() - t };
    return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - t };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs = 4000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
    private readonly activity: ActivityService,
  ) {}

  @Public()
  @Get()
  async health() {
    const ollama = this.config.get("OLLAMA_URL", { infer: true });
    const [database, redis, llm, media, reference, comfyui] = await Promise.all([
      timed(async () => { await this.prisma.$queryRaw`SELECT 1`; return "postgres reachable"; }),
      timed(async () => `redis ${await this.redis.ping()}`),
      timed(async () => {
        const tags = (await getJson(`${ollama}/api/tags`, 10_000)) as { models: { name: string }[] };
        const want = [this.config.get("OLLAMA_TEXT_MODEL", { infer: true }), this.config.get("OLLAMA_VISION_MODEL", { infer: true })];
        const missing = want.filter((m) => !tags.models.some((x) => x.name === m || x.name === `${m}:latest`));
        if (missing.length) throw new Error(`Ollama running; missing models: ${missing.join(", ")}`);
        return `models ready: ${want.join(", ")}`;
      }, 10_000, true),
      timed(async () => { await getJson(`${this.config.get("MEDIA_SERVICE_URL", { infer: true })}/health`, 10_000); return "media-service up"; }, 10_000, true),
      timed(async () => { await getJson(`${this.config.get("REFERENCE_SERVICE_URL", { infer: true })}/health`, 10_000); return "reference-service up"; }, 10_000, true),
      timed(async () => {
        const s = (await getJson(`${this.config.get("COMFYUI_URL", { infer: true })}/system_stats`, 10_000)) as { system?: { comfyui_version?: string } };
        return `ComfyUI ${s.system?.comfyui_version ?? ""} up`.replace("  ", " ");
      }, 10_000, true),
    ]);
    const checks = { database, redis, llm, comfyui, media, reference };
    return { status: database.ok && redis.ok ? "ok" : "degraded", checks, time: new Date().toISOString() };
  }

  /** Starts a stopped local service in its own window (same commands as scripts/start-all.ps1). */
  @Post("services/:name/start")
  @Roles("owner")
  async start(@Param("name") name: string, @CurrentUser() u: SessionUser) {
    if (!(STARTABLE as readonly string[]).includes(name)) throw new BadRequestException(`Unknown service "${name}"`);
    if (process.platform !== "win32" || !fs.existsSync(START_SCRIPT)) throw new ServiceUnavailableException("Starting services from the dashboard is only available on the Windows machine that runs ReelForge");
    try {
      const result = await runStartScript(name as Startable);
      await this.activity.record({ entityType: "system", action: "service_start", message: `${name}: ${result} (requested from the dashboard)`, actorUserId: u.id }).catch(() => undefined);
      return { ok: true, result };
    } catch (e) {
      throw new ServiceUnavailableException(`Could not start ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
