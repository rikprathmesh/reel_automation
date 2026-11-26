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
import { STYLES, stylePreset } from "../common/styles.ts";
import { MAX_REEL_SEC, MIN_REEL_SEC, storyPlan } from "../common/lengths.ts";
import { PromptsService } from "../prompts/prompts.service.ts";
import { KENBURNS_MOVE } from "../prompts/adapters.ts";

interface DialogueLine { speaker: string; text: string; emotion: string }
interface SceneVoice { line: number; speaker: string; key: string; duration: number; words: Word[] }
interface ProduceData { projectId: string; reuseFromVersionId?: string; onlySceneIds?: string[] }
interface SceneData { projectId: string; versionId: string; sceneJobId: string; trackerJobId: string }
interface MergeData { projectId: string; versionId: string; trackerJobId: string }

/** Character model sheets are always drawn in the storybook look: they are the identity reference for every style. */
const SHEET = STYLES.storybook;

const HEAD = 0.35, GAP = 0.22, TAIL = 0.45;
const secs = (from: Date | number) => Math.round((Date.now() - (typeof from === "number" ? from : from.getTime())) / 100) / 10;

/**
 * Asynchronous production pipeline (fan-out / fan-in on the production queue):
 *
 *   produce ─┬─ scene 1 (keyframe image → voices → AI clip when an AI video model is selected) ─┐
 *            ├─ scene 2 …                                                                       ├─► merge (timing, camera
 *            └─ scene N …                                                                       ┘   motion, music, render,
 *                                                                                                   validation → Review)
 * - Every scene is its own BullMQ job with its own retries; its results are stored in SceneGenerationJob, so a retry,
 *   a crash or a restart resumes where it stopped and never redraws a finished scene.
 * - The merge job starts only when all scene jobs completed. A scene that fails for good fails the version.
 * - Regenerating one scene creates a new version that reuses the other scenes' finished outputs.
 * - On this CPU-only machine the queue runs one heavy job at a time, so jobs run sequentially; on more workers or a GPU
 *   the same scene jobs run in parallel without code changes.
 * A version is only "ready" after the rendered MP4 passes validation; any failure leaves it "failed" with the reason.
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
    private readonly prompts: PromptsService,
  ) {}

  /** Other heavy jobs (story generation, new-reel, prompts) share this queue so only one AI model runs at a time. */
  readonly handlers = new Map<string, (job: Job) => Promise<unknown>>();

  onApplicationBootstrap() {
    this.handlers.set("scene", (job) => this.scene(job));
    this.handlers.set("merge", (job) => this.merge(job));
    this.queues.process("production", (job) => {
      const handler = this.handlers.get(job.name);
      return handler ? handler(job) : this.produce(job);
    }, async (job, err) => {
      if (!["produce", "scene", "merge"].includes(job.name)) return;
      const d = job.data as Partial<SceneData> & { projectId: string };
      const trackerJobId = d.trackerJobId ?? job.id!;
      if (job.name === "scene" && d.sceneJobId) {
        await this.prisma.sceneGenerationJob.update({ where: { id: d.sceneJobId }, data: { status: "failed", error: { message: err.message, at: new Date().toISOString() } } }).catch(() => undefined);
        // don't spend hours drawing the rest of a version that can no longer be merged
        if (d.versionId) await this.cancelPendingScenes(d.versionId);
      }
      await this.tracker.fail(trackerJobId, err, true).catch(() => undefined);
      await this.prisma.videoProject.update({ where: { id: d.projectId }, data: { status: "failed" } }).catch(() => undefined);
      await this.prisma.videoVersion.updateMany({ where: { projectId: d.projectId, status: "rendering" }, data: { status: "failed", validation: { problems: [`${job.name} failed: ${err.message}`] } } });
      this.events.emit("project", { id: d.projectId, status: "failed" });
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
  async rerender(projectId: string, data: Omit<ProduceData, "projectId"> = {}): Promise<string> {
    const jobId = await this.queues.enqueue("production", "produce", { projectId, ...data }, { attempts: 2, backoff: { type: "fixed", delay: 120_000 } });
    await this.tracker.create(projectId, jobId, 2);
    await this.prisma.videoProject.update({ where: { id: projectId }, data: { status: "queued" } });
    this.events.emit("project", { id: projectId, status: "queued" });
    return jobId;
  }

  /** Regenerates only the given scenes; every other scene is reused from `fromVersionId`. Produces a new version. */
  async rerenderScenes(projectId: string, fromVersionId: string, sceneIds: string[]): Promise<string> {
    return this.rerender(projectId, { reuseFromVersionId: fromVersionId, onlySceneIds: sceneIds });
  }

  private async progress(trackerJobId: string, stage: GenerationStage, pct: number, projectId: string) {
    await this.tracker.progress(trackerJobId, stage, pct).catch(() => undefined);
    this.events.emit("project", { id: projectId, status: "generating", stage, progress: Math.round(pct) });
  }

  private async cancelPendingScenes(versionId: string) {
    const rows = await this.prisma.sceneGenerationJob.findMany({ where: { versionId, status: "queued", bullJobId: { not: null } } });
    for (const r of rows) await this.queues.cancel("production", r.bullJobId!).catch(() => false);
  }

  /* ================================================================ produce (fan-out) */

  async produce(job: Job) {
    const d = job.data as ProduceData;
    const { projectId } = d;
    // idempotency: a stalled/redelivered produce job that already fanned out must not create a second version
    const fannedOut = await this.prisma.videoVersion.findFirst({ where: { projectId, status: "rendering", timings: { path: ["produceJobId"], equals: job.id! } } });
    if (fannedOut) {
      this.log.warn(`produce ${job.id} for project ${projectId} already fanned out (v${fannedOut.versionNo}); skipping duplicate delivery`);
      return;
    }
    if ((await this.prisma.videoGenerationJob.findUnique({ where: { bullJobId: job.id! } }))?.status === "completed") return;
    const t0 = Date.now();
    // a previous attempt that crashed mid-render leaves a "rendering" version behind
    await this.prisma.videoVersion.updateMany({ where: { projectId, status: "rendering" }, data: { status: "failed", validation: { problems: ["render interrupted; superseded by a new attempt"] } } });
    await this.tracker.start(job.id!, job.attemptsMade + 1);
    const project = await this.prisma.videoProject.findUniqueOrThrow({
      where: { id: projectId },
      include: { story: { include: { scripts: { where: { isCurrent: true }, include: { scenes: { orderBy: { index: "asc" }, include: { clipAsset: true, characters: { include: { character: true } } } } } } } } },
    });
    const script = project.story.scripts[0];
    if (!script || !script.scenes.length) throw new Error("Story has no current script with scenes");
    await this.prisma.videoProject.update({ where: { id: projectId }, data: { status: "generating" } });

    const lastNo = (await this.prisma.videoVersion.aggregate({ where: { projectId }, _max: { versionNo: true } }))._max.versionNo ?? 0;
    const version = await this.prisma.videoVersion.create({ data: { projectId, versionNo: lastNo + 1, scriptId: script.id, status: "rendering" } });
    await this.progress(job.id!, "storyboard", 2, projectId);

    // character model sheets are shared by every scene, so they are made once here, before the scenes fan out
    const castIds = [...new Set(script.scenes.flatMap((s) => s.characters.map((c) => c.characterId)))];
    for (const id of castIds) await this.ensureCharacterSheet(id);

    // reuse finished scenes from an earlier version (single-scene regeneration) when it rendered the same script
    // resume: without an explicit source, the latest FAILED version of this script lends its finished scenes, so
    // "Regenerate" after a failed merge only redoes what failed (minutes instead of redrawing every scene)
    const failedBefore = d.reuseFromVersionId ? null : await this.prisma.videoVersion.findFirst({ where: { projectId, scriptId: script.id, status: "failed", id: { not: version.id }, sceneJobs: { some: { status: "completed" } } }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true } });
    const fromId = d.reuseFromVersionId ?? failedBefore?.id;
    const from = fromId ? await this.prisma.videoVersion.findUnique({ where: { id: fromId }, include: { sceneJobs: true } }) : null;
    if (failedBefore) await this.activity.record({ entityType: "project", entityId: projectId, action: "resumed", message: `v${version.versionNo} resumes from failed v${failedBefore.versionNo}: its finished scenes are reused` });
    const reusable = from && from.scriptId === script.id ? from.sceneJobs.filter((r) => r.status === "completed" && !d.onlySceneIds?.includes(r.sceneId)) : [];
    if (from && from.scriptId !== script.id) await this.activity.record({ entityType: "project", entityId: projectId, action: "full_rerender", level: "warn", message: "The script changed since that version, so every scene is rendered again" });

    const rows = [];
    for (const [i, scene] of script.scenes.entries()) {
      // a finished scene is reused only if it was made the same way: same Flow clip, or locally when there is no clip now
      const old = reusable.find((r) => r.sceneId === scene.id && ((r.timings as { manual?: boolean } | null)?.manual ? r.clipKey === scene.clipAsset?.storageKey : !scene.clipAssetId));
      // a regenerated scene gets a new seed, otherwise the same prompt would redraw the same picture
      const seed = ((scene.characters[0]?.character.seed ?? 7) + i * 101 + (d.onlySceneIds?.includes(scene.id) ? version.versionNo * 7919 : 0)) % 2_000_000_000;
      rows.push(await this.prisma.sceneGenerationJob.create({
        data: old
          ? { versionId: version.id, sceneId: scene.id, index: i, status: "completed", seed: old.seed, imageKey: old.imageKey, clipKey: old.clipKey, voices: old.voices ?? undefined, promptId: old.promptId, promptVersion: old.promptVersion, reusedFromId: old.id, timings: old.timings ?? undefined, startedAt: new Date(), completedAt: new Date() }
          : { versionId: version.id, sceneId: scene.id, index: i, status: "queued", seed },
      }));
    }
    const todo = rows.filter((r) => r.status === "queued");
    const common = { attempts: 2, backoff: { type: "fixed" as const, delay: 60_000 } };
    const flow = await this.queues.addFlow({
      name: "merge", queueName: "production", data: { projectId, versionId: version.id, trackerJobId: job.id! } satisfies MergeData, opts: common,
      children: todo.map((r) => ({ name: "scene", queueName: "production", data: { projectId, versionId: version.id, sceneJobId: r.id, trackerJobId: job.id! } satisfies SceneData, opts: { ...common, failParentOnFailure: true } })),
    });
    for (const [i, child] of (flow.children ?? []).entries()) await this.prisma.sceneGenerationJob.update({ where: { id: todo[i]!.id }, data: { bullJobId: child.job.id } });
    await this.prisma.videoVersion.update({ where: { id: version.id }, data: { timings: { produceJobId: job.id!, produceSec: secs(t0), sceneCount: rows.length, reused: rows.length - todo.length } } });
    await this.activity.record({ entityType: "project", entityId: projectId, action: "fanned_out", message: `v${version.versionNo}: ${todo.length} scene job(s) queued${rows.length - todo.length ? `, ${rows.length - todo.length} reused` : ""}; the merge runs when all are done` });
    await this.progress(job.id!, "storyboard", 5, projectId);
  }

  /* ================================================================ scene (independent) */

  async scene(job: Job) {
    const d = job.data as SceneData;
    const row = await this.prisma.sceneGenerationJob.findUniqueOrThrow({ where: { id: d.sceneJobId }, include: { version: true } });
    if (row.status === "completed") return; // resumed / redelivered: never redraw a finished scene
    if (row.version.status !== "rendering") throw new Error(`Version v${row.version.versionNo} is "${row.version.status}"; scene skipped`);
    const t0 = Date.now();
    await this.prisma.sceneGenerationJob.update({ where: { id: row.id }, data: { status: "active", attempt: job.attemptsMade + 1, startedAt: new Date(), bullJobId: job.id } });

    const scene = await this.prisma.storyScene.findUniqueOrThrow({
      where: { id: row.sceneId },
      include: { script: { include: { story: true } }, characters: { include: { character: { include: { voiceProfile: true, hindiVoiceProfile: true, referenceImages: { where: { isPrimary: true }, include: { mediaAsset: true } } } } } } },
    });
    const story = scene.script.story;
    const language = story.language as Language;
    const base = `projects/${d.projectId}/v${row.version.versionNo}`;
    const tag = String(row.index).padStart(2, "0");

    /* Flow-assisted scene: the owner's Google Flow / Veo clip replaces the local picture, voices and motion */
    if (scene.clipAssetId) {
      const asset = await this.prisma.mediaAsset.findUniqueOrThrow({ where: { id: scene.clipAssetId } });
      const info = await this.registry.composer.clipAssets(asset.storageKey, `${base}/scene_${tag}_flow`);
      const voices: SceneVoice[] = [];
      if (info.audio_key) {
        // subtitles show the script's correctly spelled words, timed across the speech the recogniser hears in the clip
        let heard: Word[] = [];
        try { heard = (await (await this.registry.get("transcription")).transcribe(info.audio_key, language === "en" ? "en" : "hi")).words; } catch (e) { this.log.warn(`scene ${row.index + 1}: transcription failed (${e instanceof Error ? e.message : e}); subtitles spread over the clip`); }
        const scriptWords = ((scene.dialogue as unknown as DialogueLine[]) ?? []).flatMap((l) => l.text.split(/\s+/).filter(Boolean));
        const from = heard[0]?.start ?? 0.3;
        const to = heard.at(-1)?.end ?? Math.max(from + 0.5, info.duration - 0.3);
        const words: Word[] = scriptWords.length
          ? scriptWords.map((w, i) => { const step = (to - from) / scriptWords.length; return { word: w, start: from + i * step, end: from + (i + 0.9) * step }; })
          : heard;
        voices.push({ line: 0, speaker: "clip", key: info.audio_key, duration: info.duration, words });
      }
      await this.prisma.sceneGenerationJob.update({
        where: { id: row.id },
        data: { status: "completed", completedAt: new Date(), imageKey: info.frame_key, clipKey: asset.storageKey, voices: voices as unknown as Prisma.InputJsonValue, error: undefined, timings: { manual: true, clipDuration: info.duration, hasAudio: info.has_audio, motion: info.duration, image: 0, voice: 0, clip: 0, total: secs(t0) } },
      });
      if (!info.has_audio) await this.activity.record({ entityType: "project", entityId: d.projectId, action: "flow_clip_silent", level: "warn", message: `Scene ${row.index + 1}'s Flow clip has no sound` });
      const done = await this.prisma.sceneGenerationJob.count({ where: { versionId: d.versionId, status: "completed" } });
      const total = await this.prisma.sceneGenerationJob.count({ where: { versionId: d.versionId } });
      await this.progress(d.trackerJobId, "storyboard", 5 + (done / total) * 75, d.projectId);
      return;
    }

    /* keyframe image: the structured prompt (Prompt Studio) when present, else the story's one-line visual prompt */
    const style = stylePreset(story.style);
    const plan = await this.prompts.forProduction(scene.id);
    const legacy = () => {
      const cast = style.cast === "name" ? scene.characters.map((c) => c.character.name) : scene.characters.map((c) => `${c.character.identityPrompt || c.character.basePrompt}${c.expressionPreset ? `, ${(c.character.expressionPresets as Record<string, string>)[c.expressionPreset] ?? c.expressionPreset}` : ""}`);
      const action = scene.visualPrompt.replace(/[()]/g, ",").trim();
      const count = scene.characters.length <= 1 ? "solo, a single character" : `exactly ${scene.characters.length} different characters`;
      return {
        positive: [style.prompt, `(${action}:1.2)`, count, ...cast, style.background].filter(Boolean).join(", "),
        negative: [style.negative, "duplicate character, clones, plain background, studio backdrop", ...(style === STYLES.storybook ? scene.characters.map((c) => c.character.negativePrompt).filter(Boolean) : [])].join(", "),
      };
    };
    const kf = plan?.keyframe ?? legacy();
    // flat styles skip the 3D model sheets entirely (they would pull the image back to the storybook look)
    const refs = style.refWeight > 0 ? scene.characters.map((c) => c.character.referenceImages[0]?.mediaAsset.storageKey).filter((k): k is string => Boolean(k)) : [];
    const image = await this.registry.get("image");
    const ti = Date.now();
    const img = await image.generate({ prompt: kf.positive, negativePrompt: kf.negative || legacy().negative, referenceKeys: refs, referenceWeight: style.refWeight, seed: row.seed, width: OUTPUT.width, height: OUTPUT.height, outKey: `${base}/scene_${tag}.png` });
    await this.assets.registerExisting({ kind: "scene_image", key: img.key, mime: "image/png", projectId: d.projectId, provider: img.workflow, meta: { scene: row.index, prompt: kf.positive, promptId: plan?.row.id ?? null, promptVersion: plan?.row.version ?? null, style: story.style, seed: row.seed } });
    const imageSec = secs(ti);

    /* voices: narrator + character-specific lines */
    const tv = Date.now();
    const voice = await this.registry.get("voice");
    const narrator = await this.prisma.voiceProfile.findFirst({ where: { isNarrator: true, language: language === "hi" ? "hi" : "en" } });
    const voices: SceneVoice[] = [];
    for (const [li, line] of ((scene.dialogue as unknown as DialogueLine[]) ?? []).entries()) {
      if (!line.text?.trim()) continue;
      const speaker = scene.characters.find((c) => c.character.name.toLowerCase() === line.speaker.trim().toLowerCase())?.character
        ?? (await this.prisma.character.findFirst({ where: { name: { equals: line.speaker.trim(), mode: "insensitive" }, deletedAt: null }, include: { voiceProfile: true, hindiVoiceProfile: true } }));
      // Hindi (Devanagari) lines need a Hindi voice: an English voice reads them with a foreign accent
      const vp = language === "hi"
        ? (speaker?.hindiVoiceProfile ?? (speaker?.voiceProfile?.language === "hi" ? speaker.voiceProfile : null) ?? narrator)
        : (speaker?.voiceProfile ?? narrator);
      if (!vp) throw new Error("No narrator voice profile configured");
      const speed = vp.speed * (/excit|fast|panic|angry/i.test(line.emotion) ? 1.06 : /sad|slow|whisper|calm/i.test(line.emotion) ? 0.94 : 1);
      const res = await voice.synthesize({ text: line.text, voiceId: vp.voiceId, engine: vp.engine, speed, language, outKey: `${base}/voice_${tag}_${li}` });
      await this.assets.registerExisting({ kind: "voice", key: res.key, mime: "audio/wav", projectId: d.projectId, provider: vp.engine, durationSec: res.durationSec, meta: { scene: row.index, line: li, speaker: line.speaker, voice: vp.voiceId } });
      voices.push({ line: li, speaker: line.speaker, key: res.key, duration: res.durationSec, words: res.words });
    }
    const voiceSec = secs(tv);

    /* AI clip: only when a real video model is selected (camera motion over stills is made at merge time) */
    let clipKey: string | null = null;
    let clipSec = 0;
    let motionSec = 0;
    const video = await this.registry.get("video");
    if (video.info.id !== "kenburns") {
      const tc = Date.now();
      const speech = voices.reduce((n, v) => n + v.duration, 0) + Math.max(0, voices.length - 1) * GAP;
      // the merge may lengthen a scene (min reel length, transitions): +4 s headroom so the clip is never looped
      const durationSec = Math.min(60, Math.max(2.4, scene.durationHint * 0.6, HEAD + speech + TAIL) + 4);
      const res = await video.animate({
        imageKey: img.key, durationSec, camera: (plan ? KENBURNS_MOVE[plan.spec.camera.movement] ?? scene.camera : scene.camera) as CameraMove,
        // the motion model gets the scene's video prompt rendered for it, the characters' references and the scene seed
        prompt: plan?.video.positive || kf.positive, negativePrompt: plan?.video.negative || kf.negative, referenceKeys: refs, referenceWeight: style.refWeight, seed: row.seed,
        outKey: `${base}/work/clip_${tag}.mp4`,
      });
      clipKey = res.key;
      motionSec = res.motionSec;
      clipSec = secs(tc);
    }

    await this.prisma.sceneGenerationJob.update({
      where: { id: row.id },
      data: { status: "completed", completedAt: new Date(), imageKey: img.key, clipKey, voices: voices as unknown as Prisma.InputJsonValue, promptId: plan?.row.id ?? null, promptVersion: plan?.row.version ?? null, error: undefined, timings: { image: imageSec, voice: voiceSec, clip: clipSec, motion: motionSec, total: secs(t0) } },
    });
    const done = await this.prisma.sceneGenerationJob.count({ where: { versionId: d.versionId, status: "completed" } });
    const total = await this.prisma.sceneGenerationJob.count({ where: { versionId: d.versionId } });
    await this.progress(d.trackerJobId, "storyboard", 5 + (done / total) * 75, d.projectId);
  }

  /* ================================================================ merge (fan-in) */

  async merge(job: Job) {
    const d = job.data as MergeData;
    const t0 = Date.now();
    const version = await this.prisma.videoVersion.findUniqueOrThrow({
      where: { id: d.versionId },
      include: { sceneJobs: { orderBy: { index: "asc" } }, script: { include: { story: true, scenes: { orderBy: { index: "asc" } } } } },
    });
    if (version.status !== "rendering") { this.log.warn(`merge for v${version.versionNo}: version is "${version.status}", nothing to do`); return; }
    const notDone = version.sceneJobs.filter((r) => r.status !== "completed");
    if (notDone.length) throw new Error(`Cannot merge: scene(s) ${notDone.map((r) => r.index + 1).join(", ")} not completed`);
    const script = version.script;
    const story = script.story;
    const base = `projects/${d.projectId}/v${version.versionNo}`;
    await this.progress(d.trackerJobId, "editing", 82, d.projectId);

    /* timing: each scene lasts as long as its dialogue; transitions overlap neighbours */
    const gen = await this.settings.generation();
    const scenes = script.scenes;
    const sceneTiming = scenes.map((scene, i) => {
      const ls = (version.sceneJobs[i]!.voices as unknown as SceneVoice[]) ?? [];
      const t = version.sceneJobs[i]!.timings as { manual?: boolean; clipDuration?: number } | null;
      // a Flow clip plays exactly as made (its own audio and timing); only a short fade into the next scene
      if (t?.manual && t.clipDuration) return { ls, manual: true, trans: i === scenes.length - 1 ? 0 : 0.3, dur: t.clipDuration };
      const speech = ls.reduce((n, l) => n + l.duration, 0) + Math.max(0, ls.length - 1) * GAP;
      const trans = i === scenes.length - 1 ? 0 : scene.transition === "cut" ? 0.06 : 0.45;
      return { ls, manual: false, trans, dur: Math.max(2.4, scene.durationHint * 0.6, HEAD + speech + TAIL) + trans };
    });
    if (!sceneTiming.some((s) => s.ls.length)) throw new Error("Script has no spoken lines — nothing to voice");
    // every reel is at least a minute: if the narration came out a little short, let each locally made picture breathe
    // longer (max +3s each); Flow clips are never stretched (that would loop them)
    const rawTotal = sceneTiming.reduce((t, x) => t + x.dur - x.trans, 0);
    const stretchable = sceneTiming.filter((x) => !x.manual).length;
    const extra = rawTotal < MIN_REEL_SEC && stretchable ? Math.min(3, (MIN_REEL_SEC - rawTotal) / stretchable + 0.05) : 0;
    const timeline: ComposeScene[] = [];
    const voices: ComposeVoice[] = [];
    let start = 0;
    scenes.forEach((scene, i) => {
      const { ls, trans, manual } = sceneTiming[i]!;
      const dur = sceneTiming[i]!.dur + (manual ? 0 : extra);
      timeline.push({ clip_key: "", duration: dur, start, transition: manual ? "fade" : scene.transition === "cut" ? "fade" : scene.transition, transition_sec: trans, on_screen_text: manual ? "" : scene.onScreenText, sfx_key: null });
      let t = start + (manual ? 0 : HEAD);
      for (const l of ls) { voices.push({ key: l.key, start: t, duration: l.duration, words: l.words }); t += l.duration + GAP; }
      start += dur - trans;
    });
    const total = timeline.at(-1)!.start + timeline.at(-1)!.duration;
    if (total < MIN_REEL_SEC - 0.5) await this.activity.record({ entityType: "project", entityId: d.projectId, action: "short_reel", level: "warn", message: `Reel is ${total.toFixed(0)}s, under one minute: the story's narration is too short. Use "Request changes" to lengthen it.` });
    const targetSec = storyPlan(story.targetDurationSec ?? gen.durationSec).targetSec;
    // only the platform limit is a hard stop; a reel longer than planned still goes to Review, with a visible warning
    if (total > MAX_REEL_SEC + 0.5) throw new Error(`Timeline is ${total.toFixed(1)}s, over the ${MAX_REEL_SEC}s Shorts/Reels limit — shorten the script (Request changes)`);
    const tooLong = total > targetSec * 1.35 + 15 ? `Reel is ${total.toFixed(0)} s, much longer than the planned ${targetSec} s: the narration is long. Use "Request changes" to shorten it if needed.` : null;
    if (tooLong) await this.activity.record({ entityType: "project", entityId: d.projectId, action: "long_reel", level: "warn", message: tooLong });

    /* clips: AI clips from the scene jobs; scenes without one get camera motion over the keyframe (made here, it needs the final duration) */
    const tc = Date.now();
    const kenburns = this.registry.registered("video", "kenburns");
    let aiClips = 0;
    for (const [i, scene] of scenes.entries()) {
      const r = version.sceneJobs[i]!;
      if (r.clipKey) { timeline[i]!.clip_key = r.clipKey; aiClips++; continue; }
      const plan = await this.prompts.forProduction(scene.id);
      const camera = (plan ? KENBURNS_MOVE[plan.spec.camera.movement] ?? scene.camera : scene.camera) as CameraMove;
      const res = await kenburns.animate({ imageKey: r.imageKey!, durationSec: timeline[i]!.duration, camera, prompt: scene.description, outKey: `${base}/work/clip_${String(i).padStart(2, "0")}.mp4` });
      timeline[i]!.clip_key = res.key;
    }
    const clipsSec = secs(tc);
    await this.progress(d.trackerJobId, "audio", 88, d.projectId);

    /* audio: licensed library music + SFX */
    const composer = this.registry.composer;
    for (const [i, scene] of scenes.entries()) if (scene.sfx.trim() && !sceneTiming[i]!.manual) timeline[i]!.sfx_key = (await composer.pickLibrary("sfx", scene.sfx, d.projectId)).key;
    const music = await composer.pickLibrary("music", script.musicDirection, d.projectId);
    const whoosh = await composer.pickLibrary("sfx", "whoosh swoosh transition", d.projectId);
    if (!music.key) await this.activity.record({ entityType: "project", entityId: d.projectId, action: "no_music", level: "warn", message: "No licensed track in storage/library/music matched — rendering without music" });

    /* render */
    await this.progress(d.trackerJobId, "render", 90, d.projectId);
    const tr = Date.now();
    const out = await composer.compose({ work_key: `${base}/work`, scenes: timeline, voices, music_key: music.key, whoosh_key: whoosh.key, end_card: script.ending.length <= 60 ? script.ending : "", total_sec: total, out_key: `${base}/reel.mp4` });
    const renderSec = secs(tr);

    /* validation + honest labelling: camera motion over stills is never reported as AI animation */
    await this.progress(d.trackerJobId, "validation", 96, d.projectId);
    const structured = (await Promise.all(scenes.map((s) => this.prisma.generatedPrompt.count({ where: { sceneId: s.id, kind: "scene_video", isCurrent: true } })))).filter(Boolean).length;
    // how much of the reel is real AI motion (AnimateDiff on CPU makes ~2 s per scene; the rest holds the last frame)
    const motionSec = version.sceneJobs.reduce((n, r) => n + ((r.timings as { motion?: number } | null)?.motion ?? 0), 0);
    const motionShare = Math.min(1, motionSec / Math.max(1, total));
    const flowClips = sceneTiming.filter((x) => x.manual).length;
    const animation = { provider: flowClips ? (flowClips === aiClips ? "google-flow" : `google-flow + ${(await this.registry.get("video")).info.id}`) : aiClips ? (await this.registry.get("video")).info.id : "kenburns", flowClips, isAiAnimation: aiClips > 0, aiScenes: aiClips, scenes: scenes.length, motionSec: Math.round(motionSec * 10) / 10, motionShare: Math.round(motionShare * 100) / 100, structuredPrompts: structured };
    const warnings = [
      ...(tooLong ? [tooLong] : []),
      ...(aiClips === 0 ? ["Not AI-animated: every scene is a still image with camera motion (Ken Burns). Characters do not move. See docs/AUDIT_VIDEO_ENGINE.md §5."] : []),
      ...(aiClips > 0 && aiClips < scenes.length ? [`Only ${aiClips} of ${scenes.length} scenes are AI-animated; the rest are stills with camera motion.`] : []),
      ...(aiClips > 0 && motionShare < 0.9 ? [`Real AI motion covers ${motionSec.toFixed(0)} s of the ${total.toFixed(0)} s reel (${Math.round(motionShare * 100)}%): each animated scene moves for about ${(motionSec / aiClips).toFixed(1)} s, then holds its last frame.`] : []),
    ];
    const sceneTimings = version.sceneJobs.map((r) => ({ scene: r.index + 1, reused: Boolean(r.reusedFromId), ...((r.timings as Record<string, number> | null) ?? {}) }));
    const timings = {
      ...((version.timings as Record<string, unknown> | null) ?? {}),
      scenes: sceneTimings,
      scenesWorkSec: Math.round(sceneTimings.filter((s) => !s.reused).reduce((n, s) => n + ((s as { total?: number }).total ?? 0), 0)),
      merge: { clipsSec, renderSec, totalSec: secs(t0) },
      wallSec: secs(version.createdAt),
    };
    await this.prisma.videoVersion.update({ where: { id: version.id }, data: { timings: timings as Prisma.InputJsonValue, validation: { ...out.validation, animation, warnings } as unknown as Prisma.InputJsonValue, durationSec: out.duration } });
    if (!out.validation.ok) throw new Error(`Rendered video failed validation: ${out.validation.problems.join("; ")}`);

    const videoAsset = await this.assets.registerExisting({ kind: "video", key: out.key, mime: "video/mp4", projectId: d.projectId, durationSec: out.duration, meta: { validation: out.validation } as unknown as Prisma.InputJsonValue });
    const thumb = await composer.thumbnail(version.sceneJobs[0]!.imageKey!, "", `${base}/thumbnail.jpg`);
    const thumbAsset = await this.assets.registerExisting({ kind: "thumbnail", key: thumb.key, mime: "image/jpeg", projectId: d.projectId });

    await this.prisma.$transaction([
      this.prisma.videoVersion.updateMany({ where: { projectId: d.projectId, status: { in: ["ready", "changes_requested"] }, id: { not: version.id } }, data: { status: "superseded" } }),
      this.prisma.videoVersion.update({ where: { id: version.id }, data: { status: "ready", videoAssetId: videoAsset.id, thumbnailAssetId: thumbAsset.id } }),
      this.prisma.videoProject.update({ where: { id: d.projectId }, data: { status: "awaiting_review" } }),
    ]);
    await this.tracker.complete(d.trackerJobId);
    this.events.emit("project", { id: d.projectId, status: "awaiting_review" });
    const mins = (s: number) => `${(s / 60).toFixed(1)} min`;
    await this.activity.record({ entityType: "project", entityId: d.projectId, action: "rendered", message: `Reel v${version.versionNo} rendered (${out.duration.toFixed(1)}s) and passed validation — awaiting review. Time: scenes ${mins(timings.scenesWorkSec)}, merge ${mins(timings.merge.totalSec)}, wall clock ${mins(timings.wallSec)}` });
  }

  /** Generates a model sheet for a character that has no primary reference image yet (front view prompt when available). */
  private async ensureCharacterSheet(characterId: string) {
    const has = await this.prisma.characterReferenceImage.count({ where: { characterId, isPrimary: true } });
    if (has) return;
    const c = await this.prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const front = await this.prisma.generatedPrompt.findFirst({ where: { characterId, kind: "character_reference", view: "front", isCurrent: true } });
    const image = await this.registry.get("image");
    const res = await image.generate({
      prompt: front?.positive ?? `${SHEET.prompt}. Character model sheet: ${c.identityPrompt || c.basePrompt}. Full body, front view, friendly neutral expression, standing centred on a plain soft light-grey background, even studio lighting, crisp silhouette`,
      negativePrompt: front?.negative ?? `${SHEET.negative}, ${c.negativePrompt}, multiple characters, busy background`,
      referenceKeys: [], seed: c.seed, width: 1024, height: 1024, outKey: `characters/${c.id}/sheet_${Date.now()}.png`,
    });
    const asset = await this.assets.registerExisting({ kind: "character_image", key: res.key, mime: "image/png", provider: res.workflow, meta: { generated: true, promptId: front?.id ?? null } });
    // if a sheet was uploaded while this one rendered, keep the user's choice as primary
    const primaryNow = await this.prisma.characterReferenceImage.count({ where: { characterId, isPrimary: true } });
    await this.prisma.characterReferenceImage.create({ data: { characterId, mediaAssetId: asset.id, kind: front ? "front" : "sheet", isPrimary: primaryNow === 0 } });
    this.events.emit("character", { id: characterId });
    await this.activity.record({ entityType: "character", entityId: characterId, action: "sheet_generated", message: `Master reference image generated for ${c.name}` });
  }
}
