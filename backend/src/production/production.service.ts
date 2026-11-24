import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Job } from "bullmq";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { EventsService } from "../events/events.service.ts";
import { JobTracker, QueuesService } from "../queues/queues.module.ts";
import { MediaAssetsService } from "../storage/storage.module.ts";
import { ProviderRegistry } from "../providers/providers.module.ts";
import type { ComposeScene, ComposeVoice } from "../providers/service.providers.ts";
import type { CameraMove, Word } from "../providers/types.ts";
import { SettingsService, OUTPUT } from "../settings/settings.module.ts";
import type { GenerationStage, Language, Prisma } from "../generated/prisma/client.ts";

interface DialogueLine { speaker: string; text: string; emotion: string }

/** Visual style shared by every image so all reels look like one series. */
const SERIES_STYLE = "cute stylized 3D animated storybook film still, Pixar-like soft lighting, warm cinematic colour grading, high detail, vertical composition";
const NEGATIVE = "text, letters, watermark, logo, signature, blurry, deformed, extra limbs, extra fingers, bad anatomy, lowres, jpeg artifacts, realistic photo, scary";

const HEAD = 0.35, GAP = 0.22, TAIL = 0.45;

/**
 * One reel = one production job. Stages (spec §7): storyboard → voice → animation → audio → editing →
 * render → validation. A version is only marked "ready" after the rendered MP4 passes validation;
 * a failure at any stage leaves the version "failed" with the reason, never "ready".
 */
@Injectable()
export class ProductionService implements OnApplicationBootstrap {
  private readonly log = new Logger("Production");

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly tracker: JobTracker,
    private readonly queues: QueuesService,
    private readonly assets: MediaAssetsService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly settings: SettingsService,
  ) {}

  /** Other heavy jobs (story generation, new-reel) share this queue so only one AI model runs at a time. */
  readonly handlers = new Map<string, (job: Job) => Promise<unknown>>();

  onApplicationBootstrap() {
    this.queues.process("production", (job) => {
      const handler = this.handlers.get(job.name);
      return handler ? handler(job) : this.run(job);
    }, async (job, err) => {
      if (job.name !== "produce") return;
      const { projectId } = job.data as { projectId: string };
      await this.tracker.fail(job.id!, err, true).catch(() => undefined);
      await this.prisma.videoProject.update({ where: { id: projectId }, data: { status: "failed" } }).catch(() => undefined);
      await this.prisma.videoVersion.updateMany({ where: { projectId, status: "rendering" }, data: { status: "failed" } });
      this.events.emit("project", { id: projectId, status: "failed" });
    });
  }

  /** Creates a project for a story and queues its production. Returns the project id. */
  async start(storyId: string, scheduleRunId: string | null = null): Promise<string> {
    const gen = await this.settings.generation();
    const project = await this.prisma.videoProject.create({ data: { storyId, scheduleRunId, status: "queued", targetPlatforms: gen.defaultPlatforms } });
    const jobId = await this.queues.enqueue("production", "produce", { projectId: project.id }, { attempts: 2, backoff: { type: "fixed", delay: 120_000 } });
    await this.tracker.create(project.id, jobId, 2);
    await this.prisma.story.update({ where: { id: storyId }, data: { status: "in_production" } });
    this.events.emit("project", { id: project.id, status: "queued" });
    await this.activity.record({ entityType: "project", entityId: project.id, action: "queued", message: "Reel production queued" });
    return project.id;
  }

  /** New render of an existing project (same or revised script) → new version for review. */
  async rerender(projectId: string): Promise<string> {
    const jobId = await this.queues.enqueue("production", "produce", { projectId }, { attempts: 2, backoff: { type: "fixed", delay: 120_000 } });
    await this.tracker.create(projectId, jobId, 2);
    await this.prisma.videoProject.update({ where: { id: projectId }, data: { status: "queued" } });
    this.events.emit("project", { id: projectId, status: "queued" });
    return jobId;
  }

  private async stage(job: Job, stage: GenerationStage, pct: number, projectId: string) {
    await this.tracker.progress(job.id!, stage, pct);
    this.events.emit("project", { id: projectId, status: "generating", stage, progress: pct });
  }

  async run(job: Job) {
    const { projectId } = job.data as { projectId: string };
    // idempotency: a stalled/redelivered job that already produced its version must not render again
    const tracked = await this.prisma.videoGenerationJob.findUnique({ where: { bullJobId: job.id! } });
    if (tracked?.status === "completed") {
      this.log.warn(`Job ${job.id} for project ${projectId} already completed; skipping duplicate delivery`);
      return;
    }
    // a previous attempt that crashed mid-render leaves a "rendering" version behind
    await this.prisma.videoVersion.updateMany({ where: { projectId, status: "rendering" }, data: { status: "failed", validation: { problems: ["render interrupted; superseded by a new attempt"] } } });
    await this.tracker.start(job.id!, job.attemptsMade + 1);
    const project = await this.prisma.videoProject.findUniqueOrThrow({
      where: { id: projectId },
      include: { story: { include: { scripts: { where: { isCurrent: true }, include: { scenes: { orderBy: { index: "asc" }, include: { characters: { include: { character: { include: { voiceProfile: true, referenceImages: { where: { isPrimary: true }, include: { mediaAsset: true } } } } } } } } } } } } },
    });
    const script = project.story.scripts[0];
    if (!script || !script.scenes.length) throw new Error("Story has no current script with scenes");
    await this.prisma.videoProject.update({ where: { id: projectId }, data: { status: "generating" } });

    // a fresh version for this render attempt
    const lastNo = (await this.prisma.videoVersion.aggregate({ where: { projectId }, _max: { versionNo: true } }))._max.versionNo ?? 0;
    const version = await this.prisma.videoVersion.create({ data: { projectId, versionNo: lastNo + 1, scriptId: script.id, status: "rendering" } });
    const base = `projects/${projectId}/v${version.versionNo}`;
    const language = project.story.language as Language;

    /* ---- STORYBOARD: character sheets + scene images ---- */
    await this.stage(job, "storyboard", 5, projectId);
    const castIds = [...new Set(script.scenes.flatMap((s) => s.characters.map((c) => c.characterId)))];
    for (const id of castIds) await this.ensureCharacterSheet(id);
    const sheets = new Map((await this.prisma.characterReferenceImage.findMany({ where: { characterId: { in: castIds }, isPrimary: true }, include: { mediaAsset: true } })).map((r) => [r.characterId, r.mediaAsset.storageKey]));

    const image = await this.registry.get("image");
    const sceneImages: string[] = [];
    for (const [i, scene] of script.scenes.entries()) {
      const cast = scene.characters.map((c) => `${c.character.basePrompt}${c.expressionPreset ? `, ${(c.character.expressionPresets as Record<string, string>)[c.expressionPreset] ?? c.expressionPreset}` : ""}`);
      const prompt = [SERIES_STYLE, scene.visualPrompt, ...cast].join(". ");
      const refs = scene.characters.map((c) => sheets.get(c.characterId)).filter((k): k is string => Boolean(k));
      const negative = [NEGATIVE, ...scene.characters.map((c) => c.character.negativePrompt).filter(Boolean)].join(", ");
      const res = await image.generate({ prompt, negativePrompt: negative, referenceKeys: refs, seed: (scene.characters[0]?.character.seed ?? 7) + i * 101, width: OUTPUT.width, height: OUTPUT.height, outKey: `${base}/scene_${String(i).padStart(2, "0")}.png` });
      await this.assets.registerExisting({ kind: "scene_image", key: res.key, mime: "image/png", projectId, provider: res.workflow, meta: { scene: i, prompt } });
      sceneImages.push(res.key);
      await this.stage(job, "storyboard", 5 + Math.round(((i + 1) / script.scenes.length) * 35), projectId);
    }

    /* ---- VOICE: narrator + character-specific lines ---- */
    await this.stage(job, "voice", 42, projectId);
    const voice = await this.registry.get("voice");
    const narrator = await this.prisma.voiceProfile.findFirst({ where: { isNarrator: true, language: language === "hi" ? "hi" : "en" } });
    const lines: { scene: number; key: string; duration: number; words: Word[] }[] = [];
    for (const [i, scene] of script.scenes.entries()) {
      const dialogue = (scene.dialogue as unknown as DialogueLine[]) ?? [];
      for (const [li, d] of dialogue.entries()) {
        if (!d.text?.trim()) continue;
        const speaker = scene.characters.find((c) => c.character.name.toLowerCase() === d.speaker.trim().toLowerCase())?.character
          ?? (await this.prisma.character.findFirst({ where: { name: { equals: d.speaker.trim(), mode: "insensitive" }, deletedAt: null }, include: { voiceProfile: true } }));
        const vp = speaker?.voiceProfile ?? narrator;
        if (!vp) throw new Error("No narrator voice profile configured");
        const speed = vp.speed * (/excit|fast|panic|angry/i.test(d.emotion) ? 1.06 : /sad|slow|whisper|calm/i.test(d.emotion) ? 0.94 : 1);
        const res = await voice.synthesize({ text: d.text, voiceId: vp.voiceId, engine: vp.engine, speed, language, outKey: `${base}/voice_${String(i).padStart(2, "0")}_${li}` });
        await this.assets.registerExisting({ kind: "voice", key: res.key, mime: "audio/wav", projectId, provider: vp.engine, durationSec: res.durationSec, meta: { scene: i, line: li, speaker: d.speaker, voice: vp.voiceId } });
        lines.push({ scene: i, key: res.key, duration: res.durationSec, words: res.words });
      }
      await this.stage(job, "voice", 42 + Math.round(((i + 1) / script.scenes.length) * 18), projectId);
    }
    if (!lines.length) throw new Error("Script has no spoken lines — nothing to voice");

    /* ---- timing: each scene lasts as long as its dialogue; transitions overlap neighbours ---- */
    const gen = await this.settings.generation();
    const timeline: ComposeScene[] = [];
    const voices: ComposeVoice[] = [];
    let start = 0;
    script.scenes.forEach((scene, i) => {
      const ls = lines.filter((l) => l.scene === i);
      const speech = ls.reduce((t, l) => t + l.duration, 0) + Math.max(0, ls.length - 1) * GAP;
      const trans = i === script.scenes.length - 1 ? 0 : scene.transition === "cut" ? 0.06 : 0.45;
      const dur = Math.max(2.4, scene.durationHint * 0.6, HEAD + speech + TAIL) + trans;
      timeline.push({ clip_key: "", duration: dur, start, transition: scene.transition === "cut" ? "fade" : scene.transition, transition_sec: trans, on_screen_text: scene.onScreenText, sfx_key: null });
      let t = start + HEAD;
      for (const l of ls) { voices.push({ key: l.key, start: t, duration: l.duration, words: l.words }); t += l.duration + GAP; }
      start += dur - trans;
    });
    const total = timeline.at(-1)!.start + timeline.at(-1)!.duration;
    if (total > gen.maxDurationSec + 15) throw new Error(`Timeline is ${total.toFixed(1)}s, far over the ${gen.maxDurationSec}s target — the script is too long`);

    /* ---- ANIMATION: cinematic camera motion per scene ---- */
    await this.stage(job, "animation", 62, projectId);
    const video = await this.registry.get("video");
    for (const [i, scene] of script.scenes.entries()) {
      const res = await video.animate({ imageKey: sceneImages[i]!, durationSec: timeline[i]!.duration, camera: scene.camera as CameraMove, prompt: scene.description, outKey: `${base}/work/clip_${String(i).padStart(2, "0")}.mp4` });
      timeline[i]!.clip_key = res.key;
      await this.stage(job, "animation", 62 + Math.round(((i + 1) / script.scenes.length) * 18), projectId);
    }

    /* ---- AUDIO: licensed library music + SFX ---- */
    await this.stage(job, "audio", 82, projectId);
    const composer = this.registry.composer;
    for (const [i, scene] of script.scenes.entries()) if (scene.sfx.trim()) timeline[i]!.sfx_key = (await composer.pickLibrary("sfx", scene.sfx, projectId)).key;
    const music = await composer.pickLibrary("music", script.musicDirection, projectId);
    const whoosh = await composer.pickLibrary("sfx", "whoosh swoosh transition", projectId);
    if (!music.key) await this.activity.record({ entityType: "project", entityId: projectId, action: "no_music", level: "warn", message: "No licensed track in storage/library/music matched — rendering without music" });

    /* ---- EDITING + RENDER ---- */
    await this.stage(job, "editing", 86, projectId);
    const out = await composer.compose({ work_key: `${base}/work`, scenes: timeline, voices, music_key: music.key, whoosh_key: whoosh.key, end_card: script.ending.length <= 60 ? script.ending : "", total_sec: total, out_key: `${base}/reel.mp4` });

    /* ---- VALIDATION ---- */
    await this.stage(job, "validation", 95, projectId);
    await this.prisma.videoVersion.update({ where: { id: version.id }, data: { validation: out.validation as unknown as Prisma.InputJsonValue, durationSec: out.duration } });
    if (!out.validation.ok) throw new Error(`Rendered video failed validation: ${out.validation.problems.join("; ")}`);

    const videoAsset = await this.assets.registerExisting({ kind: "video", key: out.key, mime: "video/mp4", projectId, durationSec: out.duration, meta: { validation: out.validation } as unknown as Prisma.InputJsonValue });
    const thumb = await composer.thumbnail(sceneImages[0]!, "", `${base}/thumbnail.jpg`);
    const thumbAsset = await this.assets.registerExisting({ kind: "thumbnail", key: thumb.key, mime: "image/jpeg", projectId });

    await this.prisma.$transaction([
      this.prisma.videoVersion.updateMany({ where: { projectId, status: { in: ["ready", "changes_requested"] }, id: { not: version.id } }, data: { status: "superseded" } }),
      this.prisma.videoVersion.update({ where: { id: version.id }, data: { status: "ready", videoAssetId: videoAsset.id, thumbnailAssetId: thumbAsset.id } }),
      this.prisma.videoProject.update({ where: { id: projectId }, data: { status: "awaiting_review" } }),
    ]);
    await this.tracker.complete(job.id!);
    this.events.emit("project", { id: projectId, status: "awaiting_review" });
    await this.activity.record({ entityType: "project", entityId: projectId, action: "rendered", message: `Reel v${version.versionNo} rendered (${out.duration.toFixed(1)}s) and passed validation — awaiting review` });
  }

  /** Generates a model sheet for a character that has no primary reference image yet. */
  private async ensureCharacterSheet(characterId: string) {
    const has = await this.prisma.characterReferenceImage.count({ where: { characterId, isPrimary: true } });
    if (has) return;
    const c = await this.prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const image = await this.registry.get("image");
    const res = await image.generate({
      prompt: `${SERIES_STYLE}. Character model sheet: ${c.basePrompt}. Full body, front view, friendly neutral expression, standing centred on a plain soft light-grey background, even studio lighting, crisp silhouette`,
      negativePrompt: `${NEGATIVE}, ${c.negativePrompt}, multiple characters, busy background`,
      referenceKeys: [], seed: c.seed, width: 1024, height: 1024, outKey: `characters/${c.id}/sheet_${Date.now()}.png`,
    });
    const asset = await this.assets.registerExisting({ kind: "character_image", key: res.key, mime: "image/png", provider: res.workflow, meta: { generated: true } });
    // if a sheet was uploaded while this one rendered, keep the user's choice as primary
    const primaryNow = await this.prisma.characterReferenceImage.count({ where: { characterId, isPrimary: true } });
    await this.prisma.characterReferenceImage.create({ data: { characterId, mediaAssetId: asset.id, kind: "sheet", isPrimary: primaryNow === 0 } });
    this.events.emit("character", { id: characterId });
    await this.activity.record({ entityType: "character", entityId: characterId, action: "sheet_generated", message: `Model sheet generated for ${c.name}` });
  }
}
