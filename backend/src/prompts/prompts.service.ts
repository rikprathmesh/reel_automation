import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { EventsService } from "../events/events.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { ProviderRegistry } from "../providers/providers.module.ts";
import { mediaUrl } from "../storage/storage.module.ts";
import { STYLES, stylePreset } from "../common/styles.ts";
import { SOURCE_MATERIAL_CATEGORIES } from "../references/platform.ts";
import { StoryBible, bibleText } from "../stories/understanding.ts";
import type { Language, Prisma, PromptOrigin } from "../generated/prisma/client.ts";
import { CharacterProfile, SceneDraft, type ScenePromptSpec } from "./spec.ts";
import { MODELS, DEFAULT_VIDEO_MODEL, KEYFRAME_MODEL, renderPrompt, type ModelCapabilities } from "./adapters.ts";
import { assembleSceneSpec, cleanIdentity, draftOf, identityTags, missingDetails, referenceViewSpecs, type CastEntry } from "./assemble.ts";
import { AUTO_IMPROVE_BELOW, evaluateScene, sceneFingerprint, type PromptEvaluation } from "./evaluate.ts";

export type PromptOp = "improve" | "shorten" | "expand" | "instruct";

const DIRECTOR_SYSTEM = `You are the animation director of a studio making short vertical (9:16) animated story videos. For ONE scene you write precise, production-ready shot directions that a video-generation model and an animator can follow.
Rules:
- Follow the story exactly: show only what happens in THIS scene, in story order. Never add new plot, characters or objects that change the story.
- Do NOT describe what characters look like (colours, clothes, species details): their permanent design is attached automatically. Describe what they DO.
- Be concrete and visual: specific verbs, body parts that move (paws, hands, wings, tail, ears, head), where characters are in the frame at the start and the end, eye direction, mouth, head movement.
- Movements must be natural and physically plausible for the character; one clear action per shot.
- Camera: choose a shot size and angle that serve the emotion, and describe how the camera moves from the first to the last frame.
- Environment: a specific place with time of day, weather, 2-5 objects and 2-4 living details (wind in leaves, water ripples, dust in sunbeams).
- Continuity: start where the previous scene ended; end in a way that leads into the next scene.
- Child-safe, warm, bright animated look; never photographic, gory or scary.
- Write in English. Keep every field brief: a short phrase or one sentence (lists: 2-4 short items).`;

const OP_TEXT: Record<Exclude<PromptOp, "instruct">, string> = {
  improve: "Improve this shot direction: fix every problem listed, make actions, body movements, expressions, camera and environment more specific and more natural. Keep the same story moment.",
  shorten: "Shorten this shot direction: keep the key moment, the main action, the most important movement, expression and camera move; remove secondary details. Use short phrases.",
  expand: "Expand this shot direction with richer detail: more specific natural body movements, facial reactions, environmental motion, light and camera behaviour. Keep the same story moment.",
};

const GENDER_VOICE: Record<string, Record<string, string[]>> = {
  en: { male: ["Boy (EN)", "Man (EN)", "Elder man (EN)"], female: ["Woman (EN)", "Woman (EN)", "Elder woman (EN)"], neutral: ["Boy (EN)", "Man (EN)", "Elder man (EN)"] },
  hi: { male: ["Hindi boy (HI)", "Hindi man (HI)", "Hindi elder man (HI)"], female: ["Hindi woman (HI)", "Hindi woman (HI)", "Hindi elder woman (HI)"], neutral: ["Hindi boy (HI)", "Hindi man (HI)", "Hindi elder man (HI)"] },
};
const AGE_SLOT: Record<string, number> = { toddler: 0, child: 0, teen: 0, adult: 1, elder: 2 };

type SceneWithAll = Prisma.StorySceneGetPayload<{ include: { characters: { include: { character: { include: { voiceProfile: true; hindiVoiceProfile: true; referenceImages: { include: { mediaAsset: true } } } } } } } }>;

@Injectable()
export class PromptsService {
  private readonly log = new Logger("Prompts");

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly queues: QueuesService,
  ) {}

  /* ------------------------------------------------------------------ models */

  /** Adapter capabilities + whether the model can actually run here (its workflow is installed). */
  async models(): Promise<(ModelCapabilities & { installed: boolean })[]> {
    let workflows: string[] = [];
    try {
      const h = await this.registry.composer.health();
      // runnable = workflow file AND its nodes and model files exist (older media-service: file only)
      workflows = h.comfyui.runnable ?? h.comfyui.workflows;
    } catch { /* media-service down: nothing verified */ }
    return Object.values(MODELS).map((m) => ({ ...m, installed: m.workflow === "ffmpeg" || m.workflow === "manual" || workflows.includes(m.workflow) }));
  }

  /* ------------------------------------------------------------- characters */

  private voiceName(profile: CharacterProfile, lang: "en" | "hi") {
    return GENDER_VOICE[lang]![profile.voice.gender]![AGE_SLOT[profile.voice.age] ?? 1]!;
  }

  /** LLM: permanent visual identity for one character, from what the story says about it. */
  async writeProfile(input: { name: string; species?: string; personality?: string; appearance: string; storyContext?: string; sourceNotes?: string }, check = true): Promise<{ profile: CharacterProfile; model: string; identity: string }> {
    const llm = await this.registry.get("text");
    const base = [
      `CHARACTER: ${input.name}`,
      input.species ? `TYPE: ${input.species}` : "",
      input.personality ? `PERSONALITY: ${input.personality}` : "",
      `WHAT THE STORY SAYS ABOUT THEM: ${input.appearance || "(nothing specific)"}`,
      input.sourceNotes ? `SOURCE TRADITION: ${input.sourceNotes}` : "",
      input.storyContext ? `STORY CONTEXT: ${input.storyContext}` : "",
      `Write every field as a full descriptive phrase of 3-10 words, never a single word. Examples of the level of detail: surface "golden fluffy fur with a cream belly"; eyeColor "big round amber eyes"; bodyProportions "small round body, big head, short legs"; face "round face, short muzzle, tiny pink nose". Do not repeat the eyes inside "face". Put scarves, hats and jewellery in accessories with their colour.`,
    ].filter(Boolean).join("\n");
    const system = `You are the lead character designer of an animation studio. You turn a story's description of a character into a permanent, reusable character design for a bright, cute 3D animated series. The design must be distinctive and simple enough to stay identical in every scene: fixed colours, fixed clothing and accessories, a recognisable silhouette. Keep EVERY visual detail the story gives (word for word where possible); add only what is needed to complete a clear cartoon design. For gods, saints and historical figures follow traditional, respectful iconography. Write in English.`;
    let { data, model } = await llm.generateJson({ system, prompt: base }, CharacterProfile, { maxTokens: 1400, temperature: 0.5 });
    // self-check: the design must keep what the story says (one retry with the dropped details named)
    let missing = check ? missingDetails(input.appearance, identityTags(data)) : [];
    if (missing.length) {
      const retry = await llm.generateJson({ system, prompt: `${base}\n\nYour previous design dropped these details the story gives: ${missing.join(", ")}. Include every one of them in the right fields.\nPrevious design: ${JSON.stringify(data)}` }, CharacterProfile, { maxTokens: 1400, temperature: 0.3 });
      const left = missingDetails(input.appearance, identityTags(retry.data));
      if (left.length <= missing.length) {
        data = retry.data;
        model = retry.model;
        missing = left;
      }
    }
    let identity = identityTags(data);
    if (missing.length) {
      // still dropped: restate the story's own phrases that carry those details, verbatim
      const phrases = input.appearance.split(/[,.;]|\band\b/i).map((s) => s.trim()).filter((s) => s && missing.some((w) => s.toLowerCase().includes(w)));
      identity = [identity, ...phrases].filter(Boolean).join(", ");
      this.log.warn(`${input.name}: design kept dropping [${missing.join(", ")}]; story phrases appended to the identity`);
    }
    return { profile: data, model, identity };
  }

  /** Creates a permanent character from a story-bible entry (name must be new). */
  async createCharacter(input: { name: string; species: string; personality: string; appearance: string; storyContext: string; sourceNotes?: string; categories: string[] }) {
    const { profile, model, identity } = await this.writeProfile(input);
    const voices = await this.prisma.voiceProfile.findMany();
    const byName = (n: string) => voices.find((v) => v.name === n)?.id ?? null;
    const c = await this.prisma.character.create({
      data: {
        name: input.name, description: `${input.species}. ${input.personality}`.slice(0, 2000), appearance: input.appearance.slice(0, 2000) || identity,
        furColors: profile.surface, clothingColors: [profile.clothing, ...profile.accessories].filter((x) => x && !/^none$/i.test(x)).join(", "),
        personality: profile.personality || input.personality, basePrompt: identity, identityPrompt: identity, species: profile.species,
        negativePrompt: "realistic, photo, scary, extra limbs, deformed", seed: Math.floor(Math.random() * 2_000_000_000),
        expressionPresets: Object.fromEntries(profile.expressions.map((e) => [e.name.toLowerCase(), e.look])),
        visualProfile: profile as unknown as Prisma.InputJsonValue,
        categories: input.categories as never,
        voiceProfileId: byName(this.voiceName(profile, "en")), hindiVoiceProfileId: byName(this.voiceName(profile, "hi")),
      },
    });
    await this.writeReferencePrompts(c.id, null, model);
    this.events.emit("character", { id: c.id });
    await this.activity.record({ entityType: "character", entityId: c.id, action: "created_from_story", message: `Permanent character ${c.name} designed from the story (${profile.species})` });
    return c;
  }

  /**
   * Gives an existing character a structured profile (if missing) and current reference-view prompts.
   * Existing identity text (basePrompt) is kept verbatim: re-profiling never redesigns a character.
   */
  async ensureProfile(characterId: string, force = false) {
    const c = await this.prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    let model: string | null = null;
    if (!c.visualProfile || force) {
      const r = await this.writeProfile({ name: c.name, species: c.species, personality: c.personality, appearance: [c.description, c.appearance, c.furColors && `colours: ${c.furColors}`, c.clothingColors && `clothing: ${c.clothingColors}`, `design tags: ${c.basePrompt}`].filter(Boolean).join(". ") }, false);
      model = r.model;
      await this.prisma.character.update({
        where: { id: c.id },
        data: { visualProfile: r.profile as unknown as Prisma.InputJsonValue, species: c.species || r.profile.species, identityPrompt: c.identityPrompt || c.basePrompt || identityTags(r.profile) },
      });
    }
    await this.writeReferencePrompts(c.id, null, model);
    this.events.emit("character", { id: c.id });
  }

  /** Stores one current prompt per reference view (front, ¾, side, back, close-up, expressions). */
  private async writeReferencePrompts(characterId: string, userId: string | null, model: string | null) {
    const c = await this.prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const profile = CharacterProfile.safeParse(c.visualProfile);
    if (!profile.success) return;
    const sheet = STYLES.storybook;
    const views = referenceViewSpecs(c.name, profile.data, { label: sheet.label, prompt: sheet.prompt, negative: sheet.negative }, c.negativePrompt);
    for (const v of views) {
      // the stored identity wins over freshly derived tags so the references match the scenes
      const positive = v.positive.replace(v.identity, c.identityPrompt || c.basePrompt || v.identity);
      await this.saveVersion({ kind: "character_reference", characterId, view: v.view }, { spec: { ...v, identity: c.identityPrompt || c.basePrompt || v.identity } as unknown as Prisma.InputJsonValue, positive, negative: v.negative, dropped: [], targetModel: KEYFRAME_MODEL, origin: "ai", model, userId });
    }
  }

  /* ----------------------------------------------------------- scene prompts */

  private async loadScene(sceneId: string) {
    const scene = await this.prisma.storyScene.findUnique({
      where: { id: sceneId },
      include: {
        characters: { include: { character: { include: { voiceProfile: true, hindiVoiceProfile: true, referenceImages: { where: { isPrimary: true }, include: { mediaAsset: true } } } } } },
        script: { include: { story: true, scenes: { orderBy: { index: "asc" }, include: { prompts: { where: { isCurrent: true, kind: "scene_video" } } } } } },
      },
    });
    if (!scene) throw new NotFoundException("Scene not found");
    return scene;
  }

  private castOf(scene: SceneWithAll, language: Language): CastEntry[] {
    return scene.characters.map(({ character: c, expressionPreset }) => {
      const p = CharacterProfile.safeParse(c.visualProfile);
      const ref = c.referenceImages[0]?.mediaAsset.storageKey ?? null;
      const voice = language === "hi" ? (c.hindiVoiceProfile ?? c.voiceProfile) : c.voiceProfile;
      return {
        id: c.id, name: c.name, identity: cleanIdentity(c.identityPrompt || c.basePrompt), clothing: p.success ? p.data.clothing : c.clothingColors,
        accessories: p.success ? p.data.accessories : [], permanentColors: p.success ? p.data.permanentColors : [c.furColors, c.clothingColors].filter(Boolean),
        negative: c.negativePrompt, referenceKey: ref, referenceUrl: mediaUrl(ref), voice: voice?.name ?? null,
        expressions: (c.expressionPresets as Record<string, string>) ?? {}, expression: expressionPreset,
      };
    });
  }

  private styleOf(styleId: string): ScenePromptSpec["style"] {
    const s = stylePreset(styleId);
    return { id: styleId, label: s.label, prompt: s.prompt, negative: s.negative, cast: s.cast };
  }

  private capsText(caps: ModelCapabilities): string {
    if (caps.output === "image") return `TARGET: a single keyframe still. Describe the one decisive moment clearly; motion words help the pose.`;
    if (caps.id === "animatediff-lcm") return `TARGET MODEL: ${caps.label}. It animates about ${caps.maxClipSec} s per clip with simple, continuous motion. Prefer ONE clear, smooth action per character (walking, turning the head, wagging a tail, blinking, smiling) over complex choreography. Camera moves must be gentle.`;
    return `TARGET MODEL: ${caps.label}. Clips up to ${caps.maxClipSec} s. Describe the action chronologically from first to last frame.`;
  }

  /** Writes (or rewrites) the current prompt of one scene. Never changes the scene's story content. */
  async generateForScene(sceneId: string, opts: { targetModel?: string; op?: PromptOp; instruction?: string; userId?: string | null } = {}) {
    const scene = await this.loadScene(sceneId);
    const story = scene.script.story;
    const current = await this.prisma.generatedPrompt.findFirst({ where: { sceneId, kind: "scene_video", isCurrent: true } });
    const targetModel = opts.targetModel ?? current?.targetModel ?? DEFAULT_VIDEO_MODEL;
    const caps = MODELS[targetModel];
    if (!caps) throw new BadRequestException(`Unknown model "${targetModel}"`);
    if (opts.op && !current) throw new BadRequestException("This scene has no prompt yet: generate one first");

    const all = scene.script.scenes;
    const i = all.findIndex((s) => s.id === sceneId);
    const prev = all[i - 1];
    const next = all[i + 1];
    const prevSpec = prev?.prompts[0]?.spec as unknown as ScenePromptSpec | undefined;
    const bible = StoryBible.safeParse(story.understanding);
    const cast = this.castOf(scene, story.language);
    const dialogue = (scene.dialogue as unknown as { speaker: string; text: string; emotion: string }[]) ?? [];
    const durationSec = Math.max(2, scene.durationHint || 8);
    const characters = await this.prisma.character.findMany({ where: { id: { in: cast.map((c) => c.id) } }, select: { name: true, personality: true, visualProfile: true } });

    const context = [
      bible.success ? `STORY BIBLE:\n${bibleText(bible.data)}` : `STORY: ${story.title}. Moral: ${story.moral}. ${scene.script.narration.slice(0, 1500)}`,
      SOURCE_MATERIAL_CATEGORIES.includes(story.category as never) ? "This is a retelling of traditional / historical source material: keep every depicted detail faithful and respectful." : "",
      `VISUAL STYLE: ${stylePreset(story.style).label}. ${stylePreset(story.style).writing}`,
      this.capsText(caps),
      `SCENE ${i + 1} OF ${all.length}${scene.title ? ` — "${scene.title}"` : ""} (about ${durationSec.toFixed(0)} s)`,
      `WHAT HAPPENS: ${scene.description}`,
      scene.location ? `LOCATION: ${scene.location}` : "",
      `CHARACTERS IN THIS SHOT (write one entry for each, exact names): ${characters.map((c) => { const p = CharacterProfile.safeParse(c.visualProfile); return `${c.name} (${c.personality}${p.success ? `; moves: ${p.data.motionStyle}` : ""})`; }).join("; ") || "none"}`,
      dialogue.length ? `SPOKEN IN THIS SCENE (for timing and expressions; do not rewrite):\n${dialogue.map((d) => `${d.speaker} (${d.emotion}): ${d.text}`).join("\n")}` : "",
      prev ? `PREVIOUS SCENE: ${prev.description}${prevSpec ? ` | it ended with: ${prevSpec.characters.map((c) => `${c.name} ${c.beat.endPosition}`).join("; ")}; ${prevSpec.continuity.toNext}` : ""}` : "This is the FIRST scene: fromPrevious must be empty.",
      next ? `NEXT SCENE: ${next.description}` : "This is the LAST scene: toNext must be empty.",
    ].filter(Boolean).join("\n\n");

    const llm = await this.registry.get("text");
    let request = context;
    let origin: PromptOrigin = "ai";
    if (opts.op && current) {
      const spec = current.spec as unknown as ScenePromptSpec;
      const ev = current.evaluation as unknown as PromptEvaluation | null;
      const task = opts.op === "instruct" ? `Apply this change requested by the director: "${opts.instruction ?? ""}". Change only what it asks; keep everything else.` : OP_TEXT[opts.op];
      request = `${context}\n\nCURRENT SHOT DIRECTION (JSON):\n${JSON.stringify(draftOf(spec))}\n${ev?.fixes.length ? `KNOWN PROBLEMS: ${ev.fixes.join(" ")}\n` : ""}\nTASK: ${task} Return the complete shot direction.`;
      origin = ({ improve: "ai_improved", shorten: "ai_shortened", expand: "ai_expanded", instruct: "ai_instructed" } as const)[opts.op];
    } else {
      request = `${context}\n\nTASK: Write the complete shot direction for this scene.`;
    }

    const { data: draft, model } = await llm.generateJson({ system: DIRECTOR_SYSTEM, prompt: request }, SceneDraft, { maxTokens: 3000, temperature: opts.op === "shorten" ? 0.4 : 0.7 });
    const ctx = { sceneIndex: i, sceneTitle: scene.title, description: scene.description, durationSec, isFirst: i === 0, isLast: i === all.length - 1, style: this.styleOf(story.style), cast, dialogue };
    let { spec, ignored } = assembleSceneSpec(draft, ctx);
    if (current && opts.op) spec.override = undefined; // an AI rewrite replaces a manual text override
    const others = all.filter((s) => s.id !== sceneId).map((s) => s.prompts[0]?.spec as unknown as ScenePromptSpec | undefined).filter((s): s is ScenePromptSpec => Boolean(s)).map(sceneFingerprint);
    let rendered = renderPrompt(spec, targetModel);
    let evaluation = evaluateScene(spec, rendered, caps, others);

    // automatic improvement: one focused pass when the rubric finds fixable gaps (shorten keeps its trade-off)
    if (evaluation.score < AUTO_IMPROVE_BELOW && evaluation.fixes.length && opts.op !== "shorten") {
      const fix = await llm.generateJson({ system: DIRECTOR_SYSTEM, prompt: `${context}\n\nCURRENT SHOT DIRECTION (JSON):\n${JSON.stringify(draft)}\n\nTASK: Fix these problems and return the complete shot direction: ${evaluation.fixes.join(" ")}` }, SceneDraft, { maxTokens: 3000, temperature: 0.5 });
      const second = assembleSceneSpec(fix.data, ctx);
      const r2 = renderPrompt(second.spec, targetModel);
      const e2 = evaluateScene(second.spec, r2, caps, others);
      this.log.log(`scene ${i + 1}: auto-improve ${evaluation.score} → ${e2.score}`);
      if (e2.score >= evaluation.score) {
        spec = second.spec;
        ignored = second.ignored;
        rendered = r2;
        evaluation = e2;
      }
    }
    if (ignored.length) evaluation.notes.push(`Ignored directions for characters not in this scene: ${ignored.join(", ")}`);

    const row = await this.saveVersion({ kind: "scene_video", sceneId }, {
      spec: spec as unknown as Prisma.InputJsonValue, positive: rendered.positive, negative: rendered.negative, dropped: rendered.dropped,
      params: { ...rendered.params, routed: rendered.routed }, targetModel, origin, evaluation, model, userId: opts.userId ?? null, instruction: opts.instruction ?? null,
    });
    this.events.emit("story", { id: story.id, prompts: true });
    await this.activity.record({ entityType: "story", entityId: story.id, action: "scene_prompt_written", message: `Scene ${i + 1} of ${all.length} prompt written (quality ${evaluation.score}, ${targetModel})` });
    return row;
  }

  /** Scene prompts for a whole story, in order (each scene sees its predecessor's fresh ending). */
  async generateForStory(storyId: string, opts: { targetModel?: string; onlyMissing?: boolean } = {}) {
    const script = await this.prisma.storyScript.findFirst({ where: { storyId, isCurrent: true }, include: { scenes: { orderBy: { index: "asc" }, include: { prompts: { where: { isCurrent: true, kind: "scene_video" }, select: { id: true } } } } } });
    if (!script) throw new NotFoundException("Story has no current script");
    // character profiles first, so scene prompts can use motion styles and reference prompts exist
    const castIds = await this.prisma.storySceneCharacter.findMany({ where: { scene: { scriptId: script.id } }, select: { characterId: true }, distinct: ["characterId"] });
    for (const { characterId } of castIds) {
      const c = await this.prisma.character.findUnique({ where: { id: characterId }, select: { visualProfile: true } });
      if (!c?.visualProfile) await this.ensureProfile(characterId).catch((e: unknown) => this.log.warn(`profile ${characterId}: ${String(e)}`));
    }
    const t0 = Date.now();
    let done = 0;
    const failed: number[] = [];
    for (const s of script.scenes) {
      if (opts.onlyMissing && s.prompts.length) continue;
      try {
        await this.generateForScene(s.id, { targetModel: opts.targetModel });
        done++;
      } catch (e) {
        // one difficult scene must not throw away the whole story: it falls back to the story's one-line visual prompt
        if (e instanceof Error && /not running|unreachable/i.test(e.message)) throw e;
        failed.push(s.index + 1);
        await this.activity.record({ entityType: "story", entityId: storyId, action: "scene_prompt_failed", level: "warn", message: `Scene ${s.index + 1} prompt could not be written (${e instanceof Error ? e.message : e}); it will use the story's one-line visual prompt. Regenerate it in Prompt Studio.` });
      }
    }
    await this.reevaluateStory(storyId);
    await this.activity.record({ entityType: "story", entityId: storyId, action: "prompts_generated", level: failed.length ? "warn" : "info", message: `Scene prompts written for ${done} scene(s) in ${Math.round((Date.now() - t0) / 60000)} min${failed.length ? `; failed for scene(s) ${failed.join(", ")}` : ""}` });
  }

  /** Recomputes evaluations (no LLM) so cross-scene checks (distinctiveness) see every final prompt. */
  async reevaluateStory(storyId: string) {
    const rows = await this.prisma.generatedPrompt.findMany({ where: { kind: "scene_video", isCurrent: true, scene: { script: { storyId, isCurrent: true } } } });
    const fps = rows.map((r) => ({ id: r.id, fp: sceneFingerprint(r.spec as unknown as ScenePromptSpec) }));
    for (const r of rows) {
      const spec = r.spec as unknown as ScenePromptSpec;
      const caps = MODELS[r.targetModel];
      if (!caps) continue;
      const prev = r.evaluation as unknown as PromptEvaluation | null;
      const ev = evaluateScene(spec, renderPrompt(spec, r.targetModel), caps, fps.filter((f) => f.id !== r.id).map((f) => f.fp));
      ev.notes = [...new Set([...(prev?.notes ?? []).filter((n) => n.startsWith("Ignored")), ...ev.notes])];
      await this.prisma.generatedPrompt.update({ where: { id: r.id }, data: { evaluation: ev as unknown as Prisma.InputJsonValue, score: ev.score } });
    }
  }

  /* -------------------------------------------------------- manual operations */

  private async currentOf(promptId: string) {
    const p = await this.prisma.generatedPrompt.findUnique({ where: { id: promptId } });
    if (!p) throw new NotFoundException("Prompt not found");
    return p;
  }

  private async rerender(base: Awaited<ReturnType<PromptsService["currentOf"]>>, spec: ScenePromptSpec, targetModel: string, origin: PromptOrigin, userId: string | null, instruction: string | null = null) {
    const caps = MODELS[targetModel];
    if (!caps) throw new BadRequestException(`Unknown model "${targetModel}"`);
    const rendered = renderPrompt(spec, targetModel);
    const evaluation = evaluateScene(spec, rendered, caps);
    const row = await this.saveVersion({ kind: "scene_video", sceneId: base.sceneId! }, {
      spec: spec as unknown as Prisma.InputJsonValue, positive: rendered.positive, negative: rendered.negative, dropped: rendered.dropped,
      params: { ...rendered.params, routed: rendered.routed }, targetModel, origin, evaluation, model: base.model, userId, instruction,
    });
    const scene = await this.prisma.storyScene.findUnique({ where: { id: base.sceneId! }, select: { script: { select: { storyId: true } } } });
    if (scene) { await this.reevaluateStory(scene.script.storyId); this.events.emit("story", { id: scene.script.storyId, prompts: true }); }
    return row;
  }

  /** Manual edit: structured sections and/or the final prompt text. Creates a new version. */
  async edit(promptId: string, body: { draft?: unknown; positive?: string | null; negative?: string | null }, userId: string) {
    const base = await this.currentOf(promptId);
    if (base.kind !== "scene_video") throw new BadRequestException("Only scene prompts can be edited here");
    let spec = structuredClone(base.spec as unknown as ScenePromptSpec);
    if (body.draft !== undefined) {
      const d = SceneDraft.safeParse(body.draft);
      if (!d.success) throw new BadRequestException(`Invalid sections: ${d.error.issues.slice(0, 5).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      spec = {
        ...spec, keyMoment: d.data.keyMoment, environment: d.data.environment, camera: d.data.camera, visual: d.data.visual,
        audio: { ...spec.audio, sfx: d.data.audio.sfx, ambience: d.data.audio.ambience }, continuity: d.data.continuity,
        // identity stays locked: only the beats of characters already in the scene can change
        characters: spec.characters.map((c) => ({ ...c, beat: { ...(d.data.characters.find((b) => b.name.toLowerCase() === c.name.toLowerCase()) ?? c.beat), name: c.name } })),
      };
    }
    if (body.positive !== undefined || body.negative !== undefined) {
      const o = { ...(spec.override ?? {}) };
      if (body.positive !== undefined) { if (body.positive?.trim()) o.positive = body.positive.trim(); else delete o.positive; }
      if (body.negative !== undefined) { if (body.negative === null) delete o.negative; else o.negative = body.negative.trim(); }
      spec.override = Object.keys(o).length ? o : undefined;
    }
    return this.rerender(base, spec, base.targetModel, "manual", userId);
  }

  /** Re-renders the same spec for another model (no LLM, story unchanged). */
  async switchModel(promptId: string, targetModel: string, userId: string) {
    const base = await this.currentOf(promptId);
    return this.rerender(base, base.spec as unknown as ScenePromptSpec, targetModel, "model_switch", userId);
  }

  /** Makes an older version current again (as a new version, history is never rewritten). */
  async restore(promptId: string, userId: string) {
    const base = await this.currentOf(promptId);
    return this.rerender(base, base.spec as unknown as ScenePromptSpec, base.targetModel, "restored", userId, `restored v${base.version}`);
  }

  async saveTemplate(promptId: string, name: string, notes: string) {
    const p = await this.currentOf(promptId);
    const spec = p.spec as unknown as ScenePromptSpec;
    // craft only: camera language, look and negatives (never characters or story content)
    const craft = { camera: { shot: spec.camera.shot, angle: spec.camera.angle, movement: spec.camera.movement, focus: spec.camera.focus }, visual: spec.visual, negative: spec.negative };
    return this.prisma.promptTemplate.upsert({
      where: { name }, create: { name, notes, kind: p.kind, targetModel: p.targetModel, spec: craft as unknown as Prisma.InputJsonValue, sourcePromptId: p.id },
      update: { notes, targetModel: p.targetModel, spec: craft as unknown as Prisma.InputJsonValue, sourcePromptId: p.id, deletedAt: null },
    });
  }

  async applyTemplate(promptId: string, templateId: string, userId: string) {
    const base = await this.currentOf(promptId);
    const t = await this.prisma.promptTemplate.findFirst({ where: { id: templateId, deletedAt: null } });
    if (!t) throw new NotFoundException("Template not found");
    const craft = t.spec as unknown as { camera: Partial<ScenePromptSpec["camera"]>; visual: ScenePromptSpec["visual"]; negative: string[] };
    const spec = structuredClone(base.spec as unknown as ScenePromptSpec);
    spec.camera = { ...spec.camera, ...craft.camera };
    spec.visual = craft.visual;
    spec.negative = [...new Set([...spec.negative, ...craft.negative])];
    return this.rerender(base, spec, base.targetModel, "template", userId, t.name);
  }

  /* ------------------------------------------------------------- persistence */

  private async saveVersion(
    key: { kind: "scene_video" | "character_reference"; sceneId?: string; characterId?: string; view?: string },
    v: { spec: Prisma.InputJsonValue; positive: string; negative: string; dropped: string[]; params?: Record<string, unknown>; targetModel: string; origin: PromptOrigin; evaluation?: PromptEvaluation; model: string | null; userId: string | null; instruction?: string | null },
  ) {
    const where = { kind: key.kind, sceneId: key.sceneId ?? null, characterId: key.characterId ?? null, view: key.view ?? "" };
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.generatedPrompt.findFirst({ where, orderBy: { version: "desc" }, select: { version: true } });
      await tx.generatedPrompt.updateMany({ where: { ...where, isCurrent: true }, data: { isCurrent: false } });
      return tx.generatedPrompt.create({
        data: {
          ...where, version: (last?.version ?? 0) + 1, isCurrent: true, origin: v.origin, targetModel: v.targetModel, spec: v.spec, positive: v.positive, negative: v.negative,
          dropped: v.dropped, params: (v.params ?? undefined) as Prisma.InputJsonValue | undefined, evaluation: (v.evaluation ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
          score: v.evaluation?.score ?? null, model: v.model, createdById: v.userId, instruction: v.instruction ?? null,
        },
      });
    });
  }

  /** The current scene prompt plus its keyframe-still and video renderings, with today's character identities (used by production). */
  async forProduction(sceneId: string) {
    const p = await this.prisma.generatedPrompt.findFirst({ where: { sceneId, kind: "scene_video", isCurrent: true } });
    if (!p) return null;
    const spec = structuredClone(p.spec as unknown as ScenePromptSpec);
    // identity and master reference are read fresh: a character edited after the prompt was written renders as it is now
    const chars = await this.prisma.character.findMany({ where: { id: { in: spec.characters.map((c) => c.id) } }, include: { referenceImages: { where: { isPrimary: true }, include: { mediaAsset: true } } } });
    for (const c of spec.characters) {
      const now = chars.find((x) => x.id === c.id);
      if (!now) continue;
      c.identity = cleanIdentity(now.identityPrompt || now.basePrompt || c.identity);
      c.referenceKey = now.referenceImages[0]?.mediaAsset.storageKey ?? c.referenceKey;
    }
    return { row: p, spec, keyframe: renderPrompt(spec, KEYFRAME_MODEL), video: renderPrompt(spec, p.targetModel) };
  }

  /* ---------------------------------------------------------------- jobs */

  /** Queues heavy LLM work on the production queue (one model in RAM at a time); skips exact duplicates. */
  async enqueue(name: "prompts-story" | "prompt-scene" | "character-profile", data: Record<string, unknown>, dedupeKey: string): Promise<{ jobId: string; duplicate: boolean }> {
    const pending = await this.queues.queue("production").getJobs(["waiting", "active", "delayed", "prioritized"]);
    const dup = pending.find((j) => j.name === name && (j.data as { dedupeKey?: string }).dedupeKey === dedupeKey);
    if (dup) return { jobId: dup.id!, duplicate: true };
    return { jobId: await this.queues.enqueue("production", name, { ...data, dedupeKey }, { attempts: 1 }), duplicate: false };
  }

  async pendingFor(storyId: string) {
    const jobs = await this.queues.queue("production").getJobs(["waiting", "active", "delayed", "prioritized"]);
    const out: { id: string; name: string; state: string; sceneId?: string; characterId?: string }[] = [];
    for (const j of jobs) {
      const d = j.data as { storyId?: string; sceneId?: string; characterId?: string };
      if (d.storyId === storyId) out.push({ id: j.id!, name: j.name, state: await j.getState(), sceneId: d.sceneId, characterId: d.characterId });
    }
    return out;
  }
}
