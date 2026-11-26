import { Body, Controller, Get, Injectable, Module, Put, type OnApplicationBootstrap } from "@nestjs/common";
import { z } from "zod";
import { STYLE_IDS } from "../common/styles.ts";
import { normalizeLength } from "../common/lengths.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { zod } from "../common/zod.pipe.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { CATEGORIES } from "../references/references.module.ts";
import { AGE_GROUPS } from "../references/platform.ts";

/** Output format is fixed by requirement: vertical 9:16 reel for YouTube Shorts + Instagram Reels. */
export const OUTPUT = { width: 1080, height: 1920, aspect: "9:16", fps: 30, videoCodec: "H.264", audioCodec: "AAC", container: "MP4" } as const;

/** Legacy rows stored min/max seconds (15-90); map them onto the nearest allowed length. */
const migrateLegacy = (v: unknown) => {
  if (!v || typeof v !== "object") return v;
  const o = { ...(v as Record<string, unknown>) };
  if (o.durationSec === undefined && typeof o.maxDurationSec === "number") o.durationSec = normalizeLength(o.maxDurationSec);
  delete o.minDurationSec;
  delete o.maxDurationSec;
  return o;
};

export const GenerationSettings = z.preprocess(migrateLegacy, z.object({
  language: z.enum(["en", "hi", "hinglish"]).default("hi"),
  /** default reel length in seconds: 60, 120 or 180 (long) */
  durationSec: z.union([z.literal(60), z.literal(120), z.literal(180)]).default(60),
  defaultPlatforms: z.array(z.enum(["youtube", "instagram"])).min(1).default(["youtube", "instagram"]),
  youtubePrivacy: z.enum(["private", "unlisted", "public"]).default("private"),
  /** default visual style for new reels, including the daily schedule */
  style: z.enum(STYLE_IDS).default("storybook"),
  /** default audience: adapts vocabulary, pace and emotional depth */
  ageGroup: z.enum(AGE_GROUPS).default("age_4_6"),
  /** target seconds per scene (one animated shot); a starting point, story pacing decides the final length */
  sceneSec: z.number().min(4).max(20).default(8),
  /** write structured scene prompts automatically before production */
  autoPrompts: z.boolean().default(true),
}));
export type GenerationSettings = z.infer<typeof GenerationSettings>;

const ScheduleBody = z.object({
  enabled: z.boolean(),
  targetCount: z.number().int().min(1).max(20),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:mm"),
  timezone: z.string().min(1),
  categories: z.array(z.enum(CATEGORIES)).min(1),
  language: z.enum(["en", "hi", "hinglish"]),
  targetDurationSec: z.union([z.literal(60), z.literal(120), z.literal(180)]),
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
    return this.prisma.dailySchedule.create({ data: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, categories: ["rabbit_squirrel_adventure"], language: "hi" } });
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
    await this.activity.record({ entityType: "settings", action: "generation_updated", message: `Generation settings: ${b.language}, ${b.durationSec}s, ${b.defaultPlatforms.join(" + ")}`, actorUserId: u.id });
    return { ok: true };
  }

  @Put("schedule")
  @Roles("owner")
  async putSchedule(@Body(zod(ScheduleBody)) b: z.infer<typeof ScheduleBody>, @CurrentUser() u: SessionUser) {
    const s = await this.settings.schedule();
    await this.prisma.dailySchedule.update({ where: { id: s.id }, data: b });
    await this.settings.syncScheduler();
    await this.activity.record({ entityType: "settings", action: "schedule_updated", message: b.enabled ? `Daily generation ON: ${b.targetCount} × ${b.targetDurationSec}s ${b.language} reels at ${b.startTime} (${b.timezone})` : "Daily generation OFF", actorUserId: u.id });
    return { ok: true };
  }
}

@Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
