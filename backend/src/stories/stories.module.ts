import { Body, Controller, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put, type OnApplicationBootstrap } from "@nestjs/common";
import type { Job } from "bullmq";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { EventsService } from "../events/events.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { ProviderRegistry } from "../providers/providers.module.ts";
import { SettingsModule, SettingsService } from "../settings/settings.module.ts";
import { zod } from "../common/zod.pipe.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { CATEGORIES } from "../references/platform.ts";
import { CATEGORY_TEXT, LANGUAGE_RULES } from "./prompts.ts";
import { StorySchema, fingerprint, similarity, storyProblems, type StoryData } from "./story.schema.ts";
import type { Language, Prisma, StoryCategory } from "../generated/prisma/client.ts";

export interface StoryRequest {
  category: StoryCategory;
  language?: Language;
  referenceIds?: string[];
  /** Revision of an existing story: feedback is applied and a new script version is created. */
  reviseStoryId?: string;
  feedback?: string;
}

const DUPLICATE_THRESHOLD = 0.45;

@Injectable()
export class StoryEngine implements OnApplicationBootstrap {
  private readonly log = new Logger("StoryEngine");

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly queues: QueuesService,
  ) {}

  onApplicationBootstrap() {
    // legacy queue drain: story jobs are now enqueued on "production" (see Orchestrator)
    this.queues.process("story", async (job: Job) => (await this.generate(job.data as StoryRequest)).id);
  }

  private async context(req: StoryRequest) {
    const cast = await this.prisma.character.findMany({ where: { active: true, deletedAt: null }, include: { voiceProfile: true }, orderBy: [{ isStoryteller: "desc" }, { createdAt: "asc" }] });
    const refs = await this.prisma.referenceVideo.findMany({
      where: { status: "analyzed", deletedAt: null, ...(req.referenceIds?.length ? { id: { in: req.referenceIds } } : { OR: [{ category: req.category }, { category: null }] }) },
      include: { analysis: true }, orderBy: { createdAt: "desc" }, take: 4,
    });
    const recent = await this.prisma.story.findMany({ where: { deletedAt: null }, select: { title: true, conceptFingerprint: true }, orderBy: { createdAt: "desc" }, take: 60 });
    return { cast, refs, recent };
  }

  async generate(req: StoryRequest): Promise<{ id: string }> {
    const gen = await this.settings.generation();
    const language = req.language ?? gen.language;
    const target = Math.round((gen.minDurationSec + gen.maxDurationSec) / 2);
    const { cast, refs, recent } = await this.context(req);
    const revising = req.reviseStoryId ? await this.prisma.story.findUnique({ where: { id: req.reviseStoryId }, include: { scripts: { where: { isCurrent: true }, include: { scenes: { orderBy: { index: "asc" } } } } } }) : null;

    const castText = cast.map((c) => `- ${c.name}${c.isStoryteller ? " (main storyteller)" : ""}: ${c.description} Personality: ${c.personality}. Expressions available: ${Object.keys(c.expressionPresets as object).join(", ") || "neutral"}.`).join("\n");
    const refText = refs.map((r) => {
      const a = r.analysis!;
      return `Reference (${r.category ?? "uncategorized"}): hook ${JSON.stringify(a.hook)}; structure ${JSON.stringify(a.structure)}; pacing ${JSON.stringify(a.pacing)}; arc: ${a.emotionalArc}; retention: ${a.retentionTactics.join(", ")}. DO NOT COPY: ${a.doNotCopy.join("; ")}`;
    }).join("\n");

    await this.registry.composer.freeImageModel();
    const llm = await this.registry.get("text");
    let feedbackNote = req.feedback ?? "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const prompt = [
        `CATEGORY: ${CATEGORY_TEXT[req.category]}`,
        `LANGUAGE: ${LANGUAGE_RULES[language]}`,
        `TARGET LENGTH: ${target} seconds total (${gen.minDurationSec}-${gen.maxDurationSec}s). Spoken words ≈ ${Math.round(target * 2.3)}. 6-9 scenes.`,
        `CAST (use these exact names; keep them in character):\n${castText}`,
        refText ? `CRAFT LEARNED FROM REFERENCES (apply the techniques, never the content):\n${refText}` : "",
        recent.length ? `ALREADY MADE — do NOT repeat these concepts:\n${recent.map((r) => `- ${r.title}`).join("\n")}` : "",
        revising ? `REVISE THIS STORY (keep what works, fix what the creator asked):\n${JSON.stringify({ title: revising.title, hook: revising.hook, narration: revising.scripts[0]?.narration })}` : "",
        feedbackNote ? `CREATOR FEEDBACK (must address): ${feedbackNote}` : "",
      ].filter(Boolean).join("\n\n");

      const { data, model } = await llm.generateJson({
        system: `You are an award-winning writer-director of short animated stories for YouTube Shorts and Instagram Reels.
Write ORIGINAL stories with a scroll-stopping hook in the first 2-3 seconds, clear progression, real emotion and a satisfying ending with a moral.
Avoid generic AI phrasing ("In a world…", "Once upon a time in a magical forest", "little did they know"). Use concrete, specific moments and natural dialogue.
Each scene is one vertical frame. The Narrator tells the story in short vivid sentences between the characters' lines; 2-3 spoken lines per scene.
The very first spoken line is the hook: a question, surprise or bold claim (max 12 words) — never a scene description.`,
        prompt,
      }, StorySchema, { maxTokens: 3500, temperature: 0.9 });

      // quality gate: send weak drafts back with concrete feedback
      const problems = storyProblems(data, Math.round(target * 2.3));
      if (problems.length && attempt < 3) {
        await this.activity.record({ entityType: "story", action: "draft_rejected", level: "warn", message: `Draft "${data.title}" sent back: ${problems.join(" ")}`.slice(0, 500) });
        feedbackNote = `${req.feedback ?? ""} Fix these problems in your previous draft "${data.title}": ${problems.join(" ")}`.trim();
        continue;
      }
      // narration is always the actual spoken lines, so audio, captions and script agree
      data.narration = data.scenes.flatMap((sc) => sc.dialogue.map((l) => (l.speaker.toLowerCase() === "narrator" ? l.text : `${l.speaker}: ${l.text}`))).join(String.fromCharCode(10));
      const fp = fingerprint(data);
      const dup = recent.find((r) => similarity(fp, r.conceptFingerprint) >= DUPLICATE_THRESHOLD && r.title !== revising?.title);
      if (dup && !revising && attempt < 3) {
        await this.activity.record({ entityType: "story", action: "duplicate_rejected", level: "warn", message: `"${data.title}" was too similar to "${dup.title}" — regenerating` });
        feedbackNote = `${req.feedback ?? ""} Your previous idea "${data.title}" was too similar to "${dup.title}". Choose a clearly different premise, setting and twist.`.trim();
        continue;
      }
      return revising ? this.saveRevision(revising.id, data, req.feedback ?? null, model) : this.save(data, req, language, fp, model, cast, refs.map((r) => r.id));
    }
    throw new Error("Could not produce a non-duplicate story after 3 attempts");
  }

  private sceneRows(data: StoryData, cast: { id: string; name: string }[]) {
    return data.scenes.map((s, index) => ({
      index, description: s.description, visualPrompt: s.visualPrompt, camera: s.camera, transition: s.transition, sfx: s.sfx,
      onScreenText: s.onScreenText, dialogue: s.dialogue as Prisma.InputJsonValue, durationHint: s.durationHint,
      characters: { create: this.sceneCast(s.characters, s.expressions, cast) },
    }));
  }

  /** Maps character names the LLM used to cast IDs (unknown names are ignored, duplicates removed). */
  private sceneCast(names: string[], expressions: string[], cast: { id: string; name: string }[]) {
    const out: { characterId: string; expressionPreset: string | null }[] = [];
    names.forEach((n, i) => {
      const c = cast.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
      if (c && !out.some((o) => o.characterId === c.id)) out.push({ characterId: c.id, expressionPreset: expressions[i] ?? null });
    });
    return out;
  }

  private scriptData(data: StoryData) {
    return {
      narration: data.narration, musicDirection: data.musicDirection, voiceInstructions: data.voiceInstructions, ending: data.ending,
      youtubeTitle: data.youtubeTitle.slice(0, 100), youtubeDescription: data.youtubeDescription, instagramCaption: data.instagramCaption.slice(0, 2200),
      hashtags: data.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/\s+/g, "")).slice(0, 25),
    };
  }

  private async save(data: StoryData, req: StoryRequest, language: Language, fp: string, model: string, cast: { id: string; name: string }[], refIds: string[]) {
    const story = await this.prisma.story.create({
      data: {
        title: data.title, category: req.category, language, targetAudience: data.targetAudience, emotionalObjective: data.emotionalObjective,
        hook: data.hook, moral: data.moral, conceptFingerprint: fp, status: "scripted", model,
        references: refIds.length ? { connect: refIds.map((id) => ({ id })) } : undefined,
        scripts: { create: { version: 1, isCurrent: true, ...this.scriptData(data), scenes: { create: this.sceneRows(data, cast) } } },
      },
    });
    this.events.emit("story", { id: story.id });
    await this.activity.record({ entityType: "story", entityId: story.id, action: "generated", message: `Story "${story.title}" (${data.scenes.length} scenes, ${language}) generated with ${model}` });
    return { id: story.id };
  }

  async saveRevision(storyId: string, data: StoryData, feedback: string | null, model: string) {
    const cast = await this.prisma.character.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
    const last = await this.prisma.storyScript.findFirst({ where: { storyId }, orderBy: { version: "desc" } });
    await this.prisma.$transaction([
      this.prisma.storyScript.updateMany({ where: { storyId }, data: { isCurrent: false } }),
      this.prisma.story.update({ where: { id: storyId }, data: { title: data.title, hook: data.hook, moral: data.moral, targetAudience: data.targetAudience, emotionalObjective: data.emotionalObjective, model } }),
      this.prisma.storyScript.create({ data: { storyId, version: (last?.version ?? 0) + 1, isCurrent: true, feedback, ...this.scriptData(data), scenes: { create: this.sceneRows(data, cast) } } }),
    ]);
    this.events.emit("story", { id: storyId });
    await this.activity.record({ entityType: "story", entityId: storyId, action: "revised", message: `Story revised to v${(last?.version ?? 0) + 1}${feedback ? ` (feedback: ${feedback.slice(0, 120)})` : ""}` });
    return { id: storyId };
  }
}

const GenerateBody = z.object({
  category: z.enum(CATEGORIES),
  language: z.enum(["en", "hi", "hinglish"]).optional(),
  referenceIds: z.array(z.string().uuid()).max(5).optional(),
});
const ScriptEditBody = z.object({
  narration: z.string().min(10).max(8000),
  youtubeTitle: z.string().min(1).max(100),
  youtubeDescription: z.string().max(5000),
  instagramCaption: z.string().max(2200),
  hashtags: z.array(z.string().max(60)).max(30),
});

@Controller("stories")
class StoriesController {
  constructor(private readonly queues: QueuesService, private readonly activity: ActivityService, private readonly prisma: PrismaService, private readonly events: EventsService) {}

  @Post("generate")
  @Roles("owner", "editor")
  async generate(@Body(zod(GenerateBody)) b: z.infer<typeof GenerateBody>, @CurrentUser() u: SessionUser) {
    const jobId = await this.queues.enqueue("production", "story", b, { attempts: 2 });
    await this.activity.record({ entityType: "story", action: "generation_requested", message: `Story requested: ${b.category}${b.language ? ` (${b.language})` : ""}`, actorUserId: u.id });
    return { jobId };
  }

  /** Manual script edit → new script version (history kept). */
  @Put(":id/script")
  @Roles("owner", "editor")
  async editScript(@Param("id", ParseUUIDPipe) id: string, @Body(zod(ScriptEditBody)) b: z.infer<typeof ScriptEditBody>, @CurrentUser() u: SessionUser) {
    const cur = await this.prisma.storyScript.findFirst({ where: { storyId: id, isCurrent: true }, include: { scenes: { include: { characters: true } } } });
    if (!cur) throw new NotFoundException("Story has no script");
    const next = await this.prisma.$transaction(async (tx) => {
      await tx.storyScript.updateMany({ where: { storyId: id }, data: { isCurrent: false } });
      const last = await tx.storyScript.findFirstOrThrow({ where: { storyId: id }, orderBy: { version: "desc" } });
      return tx.storyScript.create({
        data: {
          storyId: id, version: last.version + 1, isCurrent: true, narration: b.narration, youtubeTitle: b.youtubeTitle, youtubeDescription: b.youtubeDescription,
          instagramCaption: b.instagramCaption, hashtags: b.hashtags, musicDirection: cur.musicDirection, voiceInstructions: cur.voiceInstructions, ending: cur.ending,
          feedback: "manual edit",
          scenes: {
            create: cur.scenes.map((s) => ({
              index: s.index, description: s.description, visualPrompt: s.visualPrompt, camera: s.camera, transition: s.transition, sfx: s.sfx,
              onScreenText: s.onScreenText, dialogue: s.dialogue as Prisma.InputJsonValue, durationHint: s.durationHint,
              characters: { create: s.characters.map((c) => ({ characterId: c.characterId, expressionPreset: c.expressionPreset })) },
            })),
          },
        },
      });
    });
    this.events.emit("story", { id });
    await this.activity.record({ entityType: "story", entityId: id, action: "script_edited", message: `Script edited manually (v${next.version})`, actorUserId: u.id });
    return { version: next.version };
  }
}

@Module({ imports: [SettingsModule], controllers: [StoriesController], providers: [StoryEngine], exports: [StoryEngine] })
export class StoriesModule {}
