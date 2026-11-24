import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Job } from "bullmq";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { EventsService } from "../events/events.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { MediaAssetsService } from "../storage/storage.module.ts";
import { STORAGE, type StorageAdapter } from "../storage/storage.types.ts";
import { ProviderRegistry } from "../providers/providers.module.ts";
import type { ExtractionResult } from "../providers/types.ts";
import type { Prisma, ReferenceStatus } from "../generated/prisma/client.ts";

export const PROMPT_VERSION = "ref-analysis-v1";

const VisualNotes = z.object({
  artStyle: z.string().describe("e.g. 2D anime, 3D Pixar-like, live action, devotional painting, stock footage"),
  palette: z.array(z.string()).describe("dominant colours"),
  characters: z.array(z.object({ description: z.string(), role: z.string() })),
  cameraWork: z.string().describe("shot types and camera movement seen across frames"),
  textOverlays: z.string().describe("on-screen text style or 'none'"),
  setting: z.string(),
});

export const ReferenceAnalysisSchema = z.object({
  summary: z.string().describe("What happens in the reference, 2-4 sentences"),
  hook: z.object({ text: z.string(), technique: z.string(), secondsToHook: z.number() }),
  structure: z.array(z.object({ beat: z.string(), purpose: z.string(), approxSeconds: z.number() })),
  pacing: z.object({ cutsPerMinute: z.number(), averageShotSeconds: z.number(), energy: z.string() }),
  transitions: z.array(z.object({ type: z.string(), purpose: z.string() })),
  visualStyle: z.object({ artStyle: z.string(), palette: z.array(z.string()), cameraWork: z.string(), textOverlays: z.string() }),
  characterTraits: z.array(z.object({ character: z.string(), traits: z.string() })),
  narration: z.object({ voiceType: z.string(), tone: z.string(), pace: z.string(), language: z.string(), usesDialogue: z.boolean() }),
  emotionalArc: z.string(),
  retentionTactics: z.array(z.string()),
  doNotCopy: z.array(z.string()).describe("Specific identifiable elements (plot, characters, lines, branding) that must NOT be reproduced"),
});
export type ReferenceAnalysisData = z.infer<typeof ReferenceAnalysisSchema>;

/** Reference pipeline: extract (reference-service) → describe frames (vision LLM) → structured analysis (text LLM). */
@Injectable()
export class ReferenceProcessor implements OnApplicationBootstrap {
  private readonly log = new Logger("ReferenceProcessor");

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly queues: QueuesService,
    private readonly assets: MediaAssetsService,
    private readonly registry: ProviderRegistry,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
  ) {}

  onApplicationBootstrap() {
    this.queues.process("reference", (job) => this.run(job), async (job, err) => {
      const id = (job.data as { referenceId: string }).referenceId;
      await this.setStatus(id, "failed", err.message).catch(() => undefined);
    });
  }

  private async setStatus(id: string, status: ReferenceStatus, error: string | null = null, extra: Prisma.ReferenceVideoUpdateInput = {}) {
    await this.prisma.referenceVideo.update({ where: { id }, data: { status, error, ...extra } });
    this.events.emit("reference", { id, status, error });
  }

  async run(job: Job) {
    const { referenceId: id } = job.data as { referenceId: string };
    const ref = await this.prisma.referenceVideo.findFirst({ where: { id, deletedAt: null }, include: { videoAsset: true } });
    if (!ref) {
      this.log.warn(`Reference ${id} no longer exists; skipping`);
      return;
    }
    const workKey = `references/${id}`;
    await this.setStatus(id, "extracting");
    const provider = await this.registry.get("reference");

    let res: ExtractionResult;
    if (ref.videoAsset) res = await provider.processUpload(ref.videoAsset.storageKey, workKey);
    else if (ref.url) res = await provider.extractUrl(ref.url, workKey);
    else throw new Error("Reference has neither a URL nor an uploaded video");

    // keep whatever was legitimately extracted, even on failure (caption/thumbnail)
    const base: Prisma.ReferenceVideoUpdateInput = {
      title: res.title ?? ref.title, author: res.author ?? ref.author, caption: res.caption ?? ref.caption,
      thumbnailKey: res.thumbnailKey ?? ref.thumbnailKey, extractor: ref.videoAsset ? "upload" : res.extractor,
      metadata: { ...((ref.metadata as object) ?? {}), extraction: { ...res.metadata, warnings: res.warnings, cuts: res.cuts } } as Prisma.InputJsonValue,
    };

    if (!res.ok) {
      // never pretend an inaccessible video was analyzed
      const status: ReferenceStatus = ref.source === "url" ? "needs_upload" : "failed";
      await this.setStatus(id, status, res.error ?? "Extraction failed", base);
      await this.activity.record({ entityType: "reference", entityId: id, action: status, level: "warn", message: res.error ?? "Extraction failed" });
      return;
    }

    if (res.videoKey && !ref.videoAsset) {
      const asset = await this.assets.registerExisting({ kind: "reference_video", key: res.videoKey, mime: "video/mp4", provider: res.extractor, durationSec: res.durationSec ?? undefined });
      base.videoAsset = { connect: { id: asset.id } };
    }
    await this.setStatus(id, "extracted", null, { ...base, transcript: res.transcript, durationSec: res.durationSec });
    await this.activity.record({ entityType: "reference", entityId: id, action: "extracted", message: `Extracted via ${res.extractor}: ${res.durationSec?.toFixed(1)}s, ${res.cuts.length} cuts, ${res.frameKeys.length} frames${res.transcript ? `, transcript (${res.transcriptLanguage})` : ""}` });

    await this.setStatus(id, "analyzing");
    const analysis = await this.analyze(res, ref.metadata as { notes?: string } | null);
    await this.prisma.referenceAnalysis.upsert({
      where: { referenceId: id },
      create: { referenceId: id, ...analysis.row },
      update: analysis.row,
    });
    await this.setStatus(id, "analyzed");
    await this.activity.record({ entityType: "reference", entityId: id, action: "analyzed", message: `Analyzed with ${analysis.row.model}: ${analysis.data.hook.technique} hook, ${analysis.data.pacing.cutsPerMinute.toFixed(1)} cuts/min` });
  }

  private async analyze(res: ExtractionResult, meta: { notes?: string } | null) {
    const llm = await this.registry.get("text");
    const duration = res.durationSec ?? 0;
    const cutsPerMinute = duration ? res.cuts.length / (duration / 60) : 0;
    const avgShot = duration / (res.cuts.length + 1);

    // 1) vision pass over a subset of frames (CPU-friendly)
    const frames = res.frameKeys.filter((_, i) => i % 2 === 0).slice(0, 4);
    const images = await Promise.all(frames.map(async (k) => (await this.storage.read(k)).toString("base64")));
    const visual = images.length
      ? (await llm.generateJson({
          system: "You are a film analyst. Describe only what is visible in these frames from a short vertical video, in chronological order.",
          prompt: "Describe the visual style, colour palette, characters (appearance + apparent role), camera work, on-screen text and setting.",
          images,
        }, VisualNotes, { maxTokens: 900, temperature: 0.2 })).data
      : null;

    // 2) structured analysis from all evidence
    const evidence = [
      `Duration: ${duration.toFixed(1)}s. MEASURED: ${res.cuts.length} hard cuts at [${res.cuts.join(", ")}]s → ${cutsPerMinute.toFixed(1)} cuts/min, average shot ${avgShot.toFixed(1)}s. Use these numbers for pacing.`,
      `Title: ${res.title ?? "n/a"}`,
      `Caption: ${(res.caption ?? "n/a").slice(0, 2500)}`,
      `Transcript (${res.transcriptLanguage ?? "unknown language"}): ${(res.transcript ?? "no speech").slice(0, 6000)}`,
      visual ? `Visual notes from frames: ${JSON.stringify(visual)}` : "No frames available.",
      meta?.notes ? `Creator's notes: ${meta.notes}` : "",
    ].filter(Boolean).join("\n\n");

    const { data, model } = await llm.generateJson({
      system: `You are a senior short-form video strategist. Deconstruct this reel into TRANSFERABLE craft (hook technique, beat structure, pacing, transitions, visual grammar, narration style, emotional arc, retention tactics) so an original animated rabbit-and-squirrel story channel can learn from it.
Rules: write in English even if the reel is not; base pacing on the measured numbers; put specific identifiable elements (plot, named characters, catchphrases, branding) in doNotCopy; never invent facts not supported by the evidence.`,
      prompt: evidence,
    }, ReferenceAnalysisSchema, { maxTokens: 2500, temperature: 0.3 });

    data.pacing.cutsPerMinute = Math.round(cutsPerMinute * 10) / 10;
    data.pacing.averageShotSeconds = Math.round(avgShot * 10) / 10;

    const row = {
      summary: data.summary,
      hook: data.hook as Prisma.InputJsonValue,
      structure: data.structure as Prisma.InputJsonValue,
      pacing: data.pacing as Prisma.InputJsonValue,
      transitions: data.transitions as Prisma.InputJsonValue,
      visualStyle: { ...data.visualStyle, ...(visual ? { setting: visual.setting, characters: visual.characters } : {}) } as Prisma.InputJsonValue,
      characterTraits: data.characterTraits as Prisma.InputJsonValue,
      narration: data.narration as Prisma.InputJsonValue,
      emotionalArc: data.emotionalArc,
      retentionTactics: data.retentionTactics,
      doNotCopy: data.doNotCopy,
      model: visual ? `${model} (+ vision)` : model,
      promptVersion: PROMPT_VERSION,
    };
    return { data, row };
  }
}
