import { Body, Controller, Get, Injectable, Module, Put, type OnApplicationBootstrap } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { zod } from "../common/zod.pipe.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { CATEGORIES } from "../references/references.module.ts";

/** Output format is fixed by requirement: vertical 9:16 reel for YouTube Shorts + Instagram Reels. */
export const OUTPUT = { width: 1080, height: 1920, aspect: "9:16", fps: 30, videoCodec: "H.264", audioCodec: "AAC", container: "MP4" } as const;

export const GenerationSettings = z.object({
  language: z.enum(["en", "hi", "hinglish"]).default("en"),
  minDurationSec: z.number().int().min(15).max(90).default(30),
  maxDurationSec: z.number().int().min(15).max(90).default(60),
  defaultPlatforms: z.array(z.enum(["youtube", "instagram"])).min(1).default(["youtube", "instagram"]),
  youtubePrivacy: z.enum(["private", "unlisted", "public"]).default("private"),
}).refine((s) => s.minDurationSec <= s.maxDurationSec, { message: "minDurationSec must be ≤ maxDurationSec" });
export type GenerationSettings = z.infer<typeof GenerationSettings>;

const ScheduleBody = z.object({
  enabled: z.boolean(),
  targetCount: z.number().int().min(1).max(20),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:mm"),
  timezone: z.string().min(1),
  categories: z.array(z.enum(CATEGORIES)).min(1),
  language: z.enum(["en", "hi", "hinglish"]),
  maxConcurrency: z.number().int().min(1).max(2),
});

@Injectable()
export class SettingsService implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService, private readonly queues: QueuesService) {}

  async generation(): Promise<GenerationSettings> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: "generation" } });
    return GenerationSettings.parse(row?.value ?? {});
  }

  async schedule() {
    const s = await this.prisma.dailySchedule.findFirst({ orderBy: { createdAt: "asc" } });
    if (s) return s;
    return this.prisma.dailySchedule.create({ data: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, categories: ["rabbit_squirrel_adventure"] } });
  }

  /** Registers (or removes) the daily cron in the maintenance queue. Generation never publishes. */
  async syncScheduler() {
    const s = await this.schedule();
    const q = this.queues.queue("maintenance");
    if (!s.enabled) {
      await q.removeJobScheduler("daily-generation");
      return;
    }
    const [h, m] = s.startTime.split(":").map(Number);
    await q.upsertJobScheduler("daily-generation", { pattern: `${m} ${h} * * *`, tz: s.timezone }, { name: "daily-generation", data: { scheduleId: s.id }, opts: { attempts: 1 } });
  }

  async onApplicationBootstrap() {
    await this.syncScheduler().catch((e: unknown) => console.warn(`[settings] scheduler sync skipped: ${e instanceof Error ? e.message : e}`));
  }
}

@Controller("settings")
class SettingsController {
  constructor(private readonly settings: SettingsService, private readonly prisma: PrismaService, private readonly activity: ActivityService) {}

  @Get()
  async get() {
    return { generation: await this.settings.generation(), schedule: await this.settings.schedule(), output: OUTPUT, categories: CATEGORIES };
  }

  @Put("generation")
  @Roles("owner")
  async putGeneration(@Body(zod(GenerationSettings)) b: GenerationSettings, @CurrentUser() u: SessionUser) {
    await this.prisma.systemSetting.upsert({ where: { key: "generation" }, create: { key: "generation", value: b, updatedBy: u.id }, update: { value: b, updatedBy: u.id } });
    await this.activity.record({ entityType: "settings", action: "generation_updated", message: `Generation settings: ${b.language}, ${b.minDurationSec}–${b.maxDurationSec}s, ${b.defaultPlatforms.join(" + ")}`, actorUserId: u.id });
    return { ok: true };
  }

  @Put("schedule")
  @Roles("owner")
  async putSchedule(@Body(zod(ScheduleBody)) b: z.infer<typeof ScheduleBody>, @CurrentUser() u: SessionUser) {
    const s = await this.settings.schedule();
    await this.prisma.dailySchedule.update({ where: { id: s.id }, data: b });
    await this.settings.syncScheduler();
    await this.activity.record({ entityType: "settings", action: "schedule_updated", message: b.enabled ? `Daily generation ON: ${b.targetCount} reels at ${b.startTime} (${b.timezone})` : "Daily generation OFF", actorUserId: u.id });
    return { ok: true };
  }
}

@Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
