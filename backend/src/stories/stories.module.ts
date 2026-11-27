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
import { AGE_GROUPS, CATEGORIES, CATEGORY_CASTS, EPIC_CATEGORIES, SOURCE_MATERIAL_CATEGORIES, STORY_SOURCES } from "../references/platform.ts";
import { AGE_RULES, CATEGORY_TEXT, LANGUAGE_RULES, storytellerSystem } from "./prompts.ts";
import { LENGTHS, storyPlan, type StoryPlan } from "../common/lengths.ts";
import { STYLE_IDS, stylePreset, type StyleId } from "../common/styles.ts";
import { StorySchema, TOO_LONG, fingerprint, similarity, spokenWords, storyProblems, type StoryData } from "./story.schema.ts";
import { StoryBible, UNDERSTANDING_SYSTEM, bibleText, faithfulnessProblems } from "./understanding.ts";
import { PromptsModule } from "../prompts/prompts.module.ts";
import { PromptsService } from "../prompts/prompts.service.ts";
import type { AgeGroup, Language, Prisma, StoryCategory, StorySource } from "../generated/prisma/client.ts";

export interface StoryRequest {
  category: StoryCategory;
  language?: Language;
  referenceIds?: string[];
  /** Visual style preset; defaults to the generation setting. A revision keeps the story's style. */
  style?: StyleId;
  /** Reel length in seconds (60 / 120 / 180); defaults to the generation setting. A revision keeps the story's length. */
  durationSec?: number;
  /** Revision of an existing story: feedback is applied and a new script version is created. */
  reviseStoryId?: string;
  feedback?: string;
  /** Audience; defaults to the generation setting. */
  ageGroup?: AgeGroup;
  /** generated (AI invents) | idea (creator's premise) | full_story (creator's text, kept faithful) | continuation (next episode) */
  mode?: StorySource;
  /** the creator's idea or full story; for a continuation, optional direction for the next episode */
  sourceText?: string;
  /** previous episode, for mode=continuation */
  parentStoryId?: string;
}

type CastRow = { id: string; name: string; description: string; personality: string; isStoryteller: boolean; expressionPresets: unknown };

const DUPLICATE_THRESHOLD = 0.45;

/** Words that push SD 1.5 checkpoints towards photographs; every style here is drawn/animated. */
const PHOTO_WORDS = /\b(photo-?realistic|hyper-?realistic|realistic|photograph(y|ic)?|photo|cinematic|film still|dslr|8k|4k|bokeh|depth of field|dramatic lighting|moody|dark and gloomy)\b,?/gi;

/** Name comparison that ignores honorifics ("Lord Krishna" = "Krishna ji" = "Krishna"). */
const normName = (s: string) => s.toLowerCase().replace(/\b(lord|shri|sri|bhagwan|mata|maharaj)\b|\bji\b/g, "").replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * May a saved character appear in a story of this category? Epic categories use their own cast; every other
 * category uses the untagged cast plus characters made for that category. This keeps epic figures (Krishna,
 * Ravana, ...) out of a rabbit-and-squirrel moral story (seen 2026-11-27: the 7B model added both).
 */
function castAllowed(c: { categories: string[] }, category: StoryCategory): boolean {
  if ((EPIC_CATEGORIES as readonly string[]).includes(category)) {
    const tags: string[] = CATEGORY_CASTS[category as keyof typeof CATEGORY_CASTS] ?? [category];
    return c.categories.some((t) => tags.includes(t));
  }
  return c.categories.length === 0 || c.categories.includes(category);
}

/** The creator named this character themselves (their idea or story text), so it stays even outside its category. */
const mentioned = (text: string | null, name: string) => !!text && normName(name).length > 0 && normName(text).includes(normName(name));

function cleanVisualPrompts(d: StoryData) {
  for (const sc of d.scenes) sc.visualPrompt = sc.visualPrompt.replace(PHOTO_WORDS, "").replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").trim();
}

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
    private readonly prompts: PromptsService,
  ) {}

  onApplicationBootstrap() {
    // legacy queue drain: story jobs are now enqueued on "production" (see Orchestrator)
    this.queues.process("story", async (job: Job) => (await this.generate(job.data as StoryRequest)).id);
  }

  private async context(req: StoryRequest) {
    // epic stories use their own cast (Hanuman → Ramayan cast, Krishna → Mahabharat cast); the general kids' categories use
    // the untagged cast. Characters the understanding engine creates are tagged with their story's category, so they never
    // leak into unrelated AI-invented stories.
    const epic = (EPIC_CATEGORIES as readonly string[]).includes(req.category);
    const tags = CATEGORY_CASTS[req.category as keyof typeof CATEGORY_CASTS] ?? [req.category];
    const cast = await this.prisma.character.findMany({
      where: { active: true, deletedAt: null, ...(epic ? { categories: { hasSome: tags as StoryCategory[] } } : { categories: { isEmpty: true } }) },
      include: { voiceProfile: true }, orderBy: [{ isStoryteller: "desc" }, { createdAt: "asc" }],
    });
    const refs = await this.prisma.referenceVideo.findMany({
      where: { status: "analyzed", deletedAt: null, ...(req.referenceIds?.length ? { id: { in: req.referenceIds } } : { OR: [{ category: req.category }, { category: null }] }) },
      include: { analysis: true }, orderBy: { createdAt: "desc" }, take: 4,
    });
    const recent = await this.prisma.story.findMany({ where: { deletedAt: null }, select: { title: true, conceptFingerprint: true }, orderBy: { createdAt: "desc" }, take: 60 });
    return { cast, refs, recent };
  }

  /**
   * AI story mode, step 0: the AI invents ONE fresh premise (checked against recent stories so concepts don't repeat).
   * It then goes through understanding and casting like any idea, so new stories get their own permanent characters.
   */
  private async inventPremise(category: StoryCategory, age: AgeGroup, cast: CastRow[], recent: { title: string; conceptFingerprint: string }[]): Promise<string> {
    const Premise = z.object({
      title: z.string(),
      premise: z.string().describe("4-6 sentences: who the characters are (each with a clear, simple look: species, colours, one accessory), where it happens, what happens in order, how it ends"),
      moral: z.string(),
    });
    const llm = await this.registry.get("text");
    let avoid = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, model } = await llm.generateJson({
        system: "You are the head writer of an animated story channel. You invent ONE fresh, simple, memorable story premise with a clear beginning, problem and happy resolution. For traditional, mythological or historical categories you choose ONE well-known episode and keep it faithful. Write in English.",
        prompt: [
          `CATEGORY: ${CATEGORY_TEXT[category]}`,
          `AUDIENCE: ${AGE_RULES[age].audience}`,
          cast.length ? `EXISTING PERMANENT CHARACTERS (use them when they fit this category; otherwise invent new characters):\n${cast.map((c) => `- ${c.name}: ${c.description}`).join("\n")}` : "Invent the characters.",
          recent.length ? `ALREADY MADE — choose something clearly different:\n${recent.slice(0, 40).map((r) => `- ${r.title}`).join("\n")}` : "",
          avoid,
        ].filter(Boolean).join("\n\n"),
      }, Premise, { maxTokens: 900, temperature: 0.95 });
      const dup = recent.find((r) => similarity(fingerprint(data), r.conceptFingerprint) >= DUPLICATE_THRESHOLD);
      if (!dup || attempt === 3) {
        await this.activity.record({ entityType: "story", action: "premise_invented", message: `AI premise (${model}): "${data.title}" — ${data.premise.slice(0, 200)}` });
        return `${data.title}. ${data.premise} Moral: ${data.moral}`;
      }
      avoid = `Your idea "${data.title}" is too similar to "${dup.title}". Choose a clearly different premise, setting and twist.`;
    }
    throw new Error("unreachable");
  }

  async generate(req: StoryRequest): Promise<{ id: string }> {
    const gen = await this.settings.generation();
    const language = req.language ?? gen.language;
    const ctx = await this.context(req);
    const { refs, recent } = ctx;
    let cast: CastRow[] = ctx.cast;
    const revising = req.reviseStoryId ? await this.prisma.story.findUnique({ where: { id: req.reviseStoryId }, include: { scripts: { where: { isCurrent: true }, include: { scenes: { orderBy: { index: "asc" }, include: { characters: { include: { character: true } } } } } } } }) : null;
    const parent = req.parentStoryId ? await this.prisma.story.findFirst({ where: { id: req.parentStoryId, deletedAt: null }, include: { scripts: { where: { isCurrent: true } } } }) : null;
    if (req.parentStoryId && !parent) throw new Error("Previous episode not found");
    const age = (revising?.ageGroup ?? req.ageGroup ?? gen.ageGroup) as AgeGroup;
    const rules = AGE_RULES[age];
    const plan = storyPlan(revising?.targetDurationSec ?? req.durationSec ?? gen.durationSec, { sceneSec: gen.sceneSec, wordsPerSec: rules.wordsPerSec });
    const style = (revising?.style as StyleId | undefined) ?? req.style ?? gen.style;
    let mode: StorySource = revising?.sourceMode ?? req.mode ?? (parent ? "continuation" : req.sourceText?.trim() ? "idea" : "generated");
    let sourceText = revising?.sourceText ?? (req.sourceText?.trim() || null);

    await this.registry.composer.freeImageModel();
    const llm = await this.registry.get("text");

    /* 1. UNDERSTAND the story before writing anything else */
    let bible: StoryBible | null = null;
    if (revising) {
      const b = StoryBible.safeParse(revising.understanding);
      bible = b.success ? b.data : null;
      const revCast = revising.scripts[0]?.scenes.flatMap((s) => s.characters.map((c) => c.character)) ?? [];
      if (bible) cast = [...new Map(revCast.map((c) => [c.id, c])).values()];
    } else {
      // AI story: the AI invents the premise itself, then it is understood and cast exactly like a creator's idea
      if (mode === "generated") sourceText = await this.inventPremise(req.category, age, cast, recent);
      const understandArgs = { category: req.category, mode: mode === "generated" ? "idea" : mode, age, sourceText, parent } as const;
      bible = await this.understand(understandArgs);
      // characters from another category that the creator never asked for: understand again without them
      const intruders = await this.intruders(bible, req.category, sourceText);
      if (intruders.length) {
        await this.activity.record({ entityType: "story", action: "cast_intruders", level: "warn", message: `"${bible.title}": ${intruders.join(", ")} don't belong in this category - rewriting the story without them` });
        bible = await this.understand({ ...understandArgs, forbid: intruders });
      }
      cast = await this.resolveCast(bible, req.category, sourceText);
    }

    const castText = cast.map((c) => `- ${c.name}${c.isStoryteller ? " (main storyteller)" : ""}: ${c.description} Personality: ${c.personality}. Expressions available: ${Object.keys((c.expressionPresets as object) ?? {}).join(", ") || "neutral"}.`).join("\n");
    const refText = refs.map((r) => {
      const a = r.analysis!;
      return `Reference (${r.category ?? "uncategorized"}): hook ${JSON.stringify(a.hook)}; structure ${JSON.stringify(a.structure)}; pacing ${JSON.stringify(a.pacing)}; arc: ${a.emotionalArc}; retention: ${a.retentionTactics.join(", ")}. DO NOT COPY: ${a.doNotCopy.join("; ")}`;
    }).join("\n");

    /* 2. SCRIPT: scenes, narration and dialogue that follow the bible */
    let feedbackNote = req.feedback ?? "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const prompt = [
        `CATEGORY: ${CATEGORY_TEXT[req.category]}`,
        `LANGUAGE: ${LANGUAGE_RULES[language]}`,
        `AUDIENCE: ${rules.audience} (${rules.label})`,
        `TARGET LENGTH: ${plan.targetSec} seconds when read aloud. ALL spoken lines together (Narrator + characters): ${Math.round(plan.words * 0.9)}-${Math.round(plan.words * 1.1)} words, never more - the reel must not run longer than ${plan.targetSec} seconds.`,
        `SCENES: ${plan.minScenes}-${plan.maxScenes} scenes of about ${plan.sceneSec} seconds each (one animated shot per scene), each with ${plan.linesPerScene}-${plan.linesPerScene + 1} spoken lines.`,
        bible ? `STORY BIBLE — this is the story to tell. Follow it exactly:\n${bibleText(bible)}\nIn every scene, "events" lists the event numbers it shows. Cover every event, in order. Do not add events or characters.` : "",
        mode === "full_story" && sourceText ? `THE CREATOR'S STORY (keep their wording in the Narrator lines wherever possible; never change what happens):\n${sourceText}` : "",
        `VISUAL STYLE: ${stylePreset(style).label}. ${stylePreset(style).writing} Write every scene's visualPrompt so it works in this style.`,
        `CAST (use these exact names; keep them in character):\n${castText}`,
        refText ? `CRAFT LEARNED FROM REFERENCES (apply the techniques, never the content):\n${refText}` : "",
        !bible && recent.length ? `ALREADY MADE — do NOT repeat these concepts:\n${recent.map((r) => `- ${r.title}`).join("\n")}` : "",
        revising ? `REVISE THIS STORY (keep what works, fix what the creator asked):\n${JSON.stringify({ title: revising.title, hook: revising.hook, narration: revising.scripts[0]?.narration })}` : "",
        feedbackNote ? `CREATOR FEEDBACK (must address): ${feedbackNote}` : "",
      ].filter(Boolean).join("\n\n");

      const { data, model } = await llm.generateJson({ system: storytellerSystem(age), prompt }, StorySchema, { maxTokens: plan.maxTokens, temperature: bible ? 0.6 : 0.85 });

      // quality gate: send weak drafts back with concrete feedback
      cleanVisualPrompts(data);
      const problems = storyProblems(data, plan.words, plan.minScenes);
      // a full redraft costs 10-20 min of CPU; only redo the story when it is structurally too small.
      // Thin narration, a missing Narrator or a weak hook are fixed by the much cheaper repair pass below.
      const spoken = data.scenes.flatMap((sc) => sc.dialogue).reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
      const severe = data.scenes.length < plan.minScenes - 1 || spoken < plan.words * 0.35;
      if (problems.length && severe && attempt < 3) {
        await this.activity.record({ entityType: "story", action: "draft_rejected", level: "warn", message: `Draft "${data.title}" sent back: ${problems.join(" ")}`.slice(0, 500) });
        feedbackNote = `${req.feedback ?? ""} Fix these problems in your previous draft "${data.title}": ${problems.join(" ")}`.trim();
        continue;
      }
      // faithfulness to the story bible: one redraft at most, then keep the draft and say what is off
      if (bible) {
        const unfaithful = faithfulnessProblems(bible, data.scenes);
        if (unfaithful.length && attempt < 2) {
          await this.activity.record({ entityType: "story", action: "draft_unfaithful", level: "warn", message: `Draft "${data.title}" does not follow the story: ${unfaithful.join(" ")}`.slice(0, 500) });
          feedbackNote = `${req.feedback ?? ""} Your previous draft did not follow the story bible: ${unfaithful.join(" ")}`.trim();
          continue;
        }
        if (unfaithful.length) await this.activity.record({ entityType: "story", action: "faithfulness_warning", level: "warn", message: `"${data.title}": ${unfaithful.join(" ")}`.slice(0, 500) });
        // deterministic clean-up of what the model invented: characters outside the story never appear or speak
        const allowed = new Set([...cast.map((c) => c.name.toLowerCase()), "narrator"]);
        let reassigned = 0;
        for (const sc of data.scenes) {
          sc.characters = sc.characters.filter((n) => allowed.has(n.trim().toLowerCase()));
          for (const l of sc.dialogue) if (!allowed.has(l.speaker.trim().toLowerCase())) { l.speaker = "Narrator"; reassigned++; }
        }
        if (reassigned) await this.activity.record({ entityType: "story", action: "speakers_fixed", level: "warn", message: `${reassigned} line(s) by characters outside the story were given to the Narrator` });
        // the story keeps the bible's title (the script model sometimes drifts to an unrelated Hindi title);
        // the YouTube/Instagram title stays in the reel's language
        data.title = bible.title;
      }
      // still weak → targeted repair instead of shipping a thin story; too long → shortened to fit the reel
      if (problems.length) await this.repair(data, plan, language);
      if (spokenWords(data) > plan.words * TOO_LONG) await this.shorten(data, plan, language);
      // narration is always the actual spoken lines, so audio, captions and script agree
      data.narration = data.scenes.flatMap((sc) => sc.dialogue.map((l) => (l.speaker.toLowerCase() === "narrator" ? l.text : `${l.speaker}: ${l.text}`))).join(String.fromCharCode(10));
      const fp = fingerprint(data);
      // the creator's own stories are never rejected; AI premises were already checked in inventPremise
      const dup = mode === "generated" && !bible ? recent.find((r) => similarity(fp, r.conceptFingerprint) >= DUPLICATE_THRESHOLD && r.title !== revising?.title) : undefined;
      if (dup && !revising && attempt < 3) {
        await this.activity.record({ entityType: "story", action: "duplicate_rejected", level: "warn", message: `"${data.title}" was too similar to "${dup.title}" — regenerating` });
        feedbackNote = `${req.feedback ?? ""} Your previous idea "${data.title}" was too similar to "${dup.title}". Choose a clearly different premise, setting and twist.`.trim();
        continue;
      }
      const saved = revising
        ? await this.saveRevision(revising.id, data, req.feedback ?? null, model, cast)
        : await this.save(data, { ...req, style, durationSec: plan.targetSec }, language, fp, model, cast, refs.map((r) => r.id), {
          ageGroup: age, sourceMode: mode, sourceText, understanding: bible, parentStoryId: parent?.id ?? null, episodeNo: parent ? parent.episodeNo + 1 : 1,
        });
      /* 3. AI-invented stories get their bible from the finished script, so every later stage shares it */
      if (!bible) await this.understandScript(saved.id, data, req.category, age);
      return saved;
    }
    throw new Error("Could not produce a non-duplicate story after 3 attempts");
  }

  /** Story Understanding Engine: idea / full story / next episode → story bible. */
  private async understand(a: { category: StoryCategory; mode: StorySource; age: AgeGroup; sourceText: string | null; forbid?: string[]; parent: { id: string; title: string; episodeNo: number; understanding: unknown; hook: string; scripts: { narration: string }[] } | null }): Promise<StoryBible> {
    // only characters that belong to this category (or that the creator named) are offered for reuse
    const known = (await this.prisma.character.findMany({ where: { deletedAt: null, active: true }, select: { name: true, species: true, description: true, categories: true } }))
      .filter((k) => castAllowed(k, a.category) || mentioned(a.sourceText, k.name));
    const parentBible = a.parent ? StoryBible.safeParse(a.parent.understanding) : null;
    const prompt = [
      `CATEGORY: ${CATEGORY_TEXT[a.category]}`,
      `AUDIENCE: ${AGE_RULES[a.age].audience}`,
      SOURCE_MATERIAL_CATEGORIES.includes(a.category as never) ? "This category retells traditional or historical source material: keep it faithful and fill sourceNotes." : "",
      a.mode === "full_story" ? `THE STORY:\n${a.sourceText}` : "",
      a.mode === "idea" ? `THE IDEA (develop it into a complete short story with a clear beginning, middle and ending):\n${a.sourceText}` : "",
      a.mode === "continuation" && a.parent ? `PREVIOUS EPISODE ${a.parent.episodeNo}: "${a.parent.title}"\n${parentBible?.success ? bibleText(parentBible.data) : a.parent.scripts[0]?.narration.slice(0, 3000) ?? a.parent.hook}\n\nWrite the story bible for EPISODE ${a.parent.episodeNo + 1}: the same characters with exactly the same names, a new adventure that continues naturally from where the previous episode ended.${a.sourceText ? ` Direction from the creator: ${a.sourceText}` : ""}` : "",
      known.length ? `PERMANENT CHARACTERS THAT ALREADY EXIST (if a character in the story is one of these, use exactly this name):\n${known.map((k) => `- ${k.name} (${k.species || k.description.slice(0, 70)})`).join("\n")}` : "",
      a.forbid?.length ? `DO NOT include ${a.forbid.join(", ")} or any character the story doesn't need. Use only the characters the idea itself describes.` : "",
      "Write names, descriptions and events in English even when the story is written in another language. Keep dialogueHints in the story's original language.",
    ].filter(Boolean).join("\n\n");
    const llm = await this.registry.get("text");
    const { data, model } = await llm.generateJson({ system: UNDERSTANDING_SYSTEM, prompt }, StoryBible, { maxTokens: 5000, temperature: a.mode === "full_story" ? 0.2 : 0.7 });
    data.events.sort((x, y) => x.order - y.order);
    await this.activity.record({ entityType: "story", action: "understood", message: `Story understood (${model}): "${data.title}" — ${data.characters.length} characters, ${data.locations.length} locations, ${data.events.length} events` });
    return data;
  }

  /** Bible for an AI-invented story, read back from its finished script. Best effort: prompts fall back to the narration. */
  private async understandScript(storyId: string, data: StoryData, category: StoryCategory, age: AgeGroup) {
    try {
      const script = data.scenes.map((s, i) => `Scene ${i + 1} (${s.location}): ${s.description} | ${s.dialogue.map((d) => `${d.speaker}: ${d.text}`).join(" / ")}`).join("\n");
      const bible = await this.understand({ category, mode: "full_story", age, sourceText: `${data.title}\n${script}`, parent: null });
      await this.prisma.story.update({ where: { id: storyId }, data: { understanding: bible as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      await this.activity.record({ entityType: "story", entityId: storyId, action: "understanding_failed", level: "warn", message: `Story bible could not be built: ${e instanceof Error ? e.message : e}` });
    }
  }

  /**
   * Maps the bible's characters to permanent characters: existing ones are reused (never redesigned), new ones are
   * designed once (profile + reference prompts) and tagged with the story's category.
   */
  /** Saved characters in the bible that belong to another category and that the creator didn't name. */
  private async intruders(bible: StoryBible, category: StoryCategory, sourceText: string | null): Promise<string[]> {
    const all = await this.prisma.character.findMany({ select: { name: true, categories: true } });
    return bible.characters.flatMap((bc) => {
      const c = this.findSaved(all, bc.name);
      return c && !castAllowed(c, category) && !mentioned(sourceText, c.name) ? [c.name] : [];
    });
  }

  private findSaved<T extends { name: string }>(all: T[], name: string): T | undefined {
    const n = normName(name);
    return all.find((x) => normName(x.name) === n) ?? all.find((x) => n.length >= 4 && normName(x.name).length >= 4 && (normName(x.name).includes(n) || n.includes(normName(x.name))));
  }

  private async resolveCast(bible: StoryBible, category: StoryCategory, sourceText: string | null = null): Promise<CastRow[]> {
    const all = await this.prisma.character.findMany();
    const out: CastRow[] = [];
    const renamed = new Map<string, string>();
    const dropped = new Set<string>();
    for (const bc of bible.characters) {
      if (/^narrator$/i.test(bc.name.trim())) continue;
      let c = this.findSaved(all, bc.name);
      // last guard: a character from another category the creator didn't ask for never joins the cast
      if (c && !castAllowed(c, category) && !mentioned(sourceText, c.name)) { dropped.add(bc.name); continue; }
      if (c?.deletedAt) {
        c = await this.prisma.character.update({ where: { id: c.id }, data: { deletedAt: null, active: true } });
        await this.activity.record({ entityType: "character", entityId: c.id, action: "restored", message: `${c.name} restored: the story uses this character again` });
      }
      if (!c) {
        c = await this.prompts.createCharacter({ name: bc.name.trim().slice(0, 60), species: bc.species, personality: bc.personality, appearance: bc.appearance, storyContext: bible.logline, sourceNotes: bible.sourceNotes, categories: [category] });
        all.push(c);
      }
      if (c.name !== bc.name) renamed.set(bc.name, c.name);
      if (!out.some((o) => o.id === c!.id)) out.push(c);
    }
    if (dropped.size) {
      bible.characters = bible.characters.filter((c) => !dropped.has(c.name));
      for (const e of bible.events) e.characters = e.characters.filter((n) => !dropped.has(n));
      await this.activity.record({ entityType: "story", action: "cast_intruders_removed", level: "warn", message: `"${bible.title}": removed ${[...dropped].join(", ")} (not part of this category)` });
    }
    // from here on the bible speaks of characters by their permanent names
    const fix = (name: string) => renamed.get(name) ?? name;
    for (const c of bible.characters) { c.name = fix(c.name); c.relationships.forEach((r) => (r.to = fix(r.to))); }
    for (const e of bible.events) e.characters = e.characters.map(fix);
    return out;
  }

  private sceneRows(data: StoryData, cast: { id: string; name: string }[]) {
    return data.scenes.map((s, index) => ({
      index, title: s.title.slice(0, 120), location: s.location.slice(0, 300), events: s.events.filter((n) => Number.isInteger(n) && n > 0), description: s.description, visualPrompt: s.visualPrompt, camera: s.camera, transition: s.transition, sfx: s.sfx,
      onScreenText: s.onScreenText, dialogue: s.dialogue as Prisma.InputJsonValue, durationHint: s.durationHint,
      characters: { create: this.sceneCast(s.characters, s.expressions, cast) },
    }));
  }

  /**
   * Second pass for small models: a focused request for Narrator lines per scene (an easier task than a
   * whole story), merged into the draft. Also guarantees the hook is the first spoken line and that the
   * story has enough scenes' worth of narration to reach the target length.
   */
  private async repair(data: StoryData, plan: StoryPlan, language: Language) {
    const targetWords = plan.words;
    const llm = await this.registry.get("text");
    // narration is only added for the words that are actually missing (it used to add 2-3 lines per scene to an
    // already long script, which turned a 60 s reel into 137 s)
    const missing = targetWords - spokenWords(data);
    const needsNarration = missing > targetWords * 0.15 || !data.scenes.some((s) => s.dialogue.some((l) => l.speaker.toLowerCase() === "narrator"));
    if (!needsNarration) { this.ensureHook(data); return; }
    const perScene = Math.max(6, Math.round(Math.max(missing, targetWords * 0.3) / Math.max(1, data.scenes.length)));
    const Narration = z.object({ scenes: z.array(z.object({ index: z.number(), narratorLines: z.array(z.string()) })) });
    const { data: n } = await llm.generateJson({
      system: `You are the warm, gentle narrator of a short animated story for children aged 1-10. ${LANGUAGE_RULES[language]} Write simple, vivid, spoken narration in short sentences a small child understands. Never describe camera or scenes technically.`,
      prompt: `Story "${data.title}". Moral: ${data.moral}.\nFor EACH scene below write 1-2 short Narrator lines (about ${perScene} words per scene in total, never more) that tell what happens and build emotion, so the story flows when read aloud.\n${data.scenes.map((s, i) => `Scene ${i}: ${s.description} | character lines: ${s.dialogue.map((d) => `${d.speaker}: ${d.text}`).join(" / ") || "none"}`).join("\n")}`,
    }, Narration, { maxTokens: 1500 + data.scenes.length * 250, temperature: 0.7 });
    for (const sc of n.scenes) {
      const scene = data.scenes[sc.index];
      if (!scene) continue;
      const existing = new Set(scene.dialogue.map((d) => d.text.trim().toLowerCase()));
      const lines = sc.narratorLines.map((t) => t.trim()).filter((t) => t && !existing.has(t.toLowerCase())).slice(0, 2);
      scene.dialogue = [...lines.map((text) => ({ speaker: "Narrator", text, emotion: "warm storytelling" })), ...scene.dialogue];
    }
    this.ensureHook(data);
    await this.activity.record({ entityType: "story", action: "narration_repaired", message: `Added narrator lines to "${data.title}" (${storyProblems(data, targetWords, plan.minScenes).length} remaining issue(s))` });
  }

  /** The hook must be the very first spoken line. */
  private ensureHook(data: StoryData) {
    const first = data.scenes[0]?.dialogue[0]?.text ?? "";
    const hook = data.hook.trim();
    if (hook && hook.split(/\s+/).length <= 16 && !/^(the scene|scene|we see)/i.test(hook) && !first.toLowerCase().startsWith(hook.toLowerCase().slice(0, 15))) {
      data.scenes[0]?.dialogue.unshift({ speaker: "Narrator", text: hook, emotion: "intriguing" });
    }
  }

  /**
   * Too many words for the reel's length: the model rewrites every scene's lines shorter (same speakers, same story).
   * If it still overshoots, the last lines of the longest scenes are dropped so the reel never runs far over its length.
   */
  private async shorten(data: StoryData, plan: StoryPlan, language: Language) {
    const before = spokenWords(data);
    const llm = await this.registry.get("text");
    const perScene = Math.max(6, Math.round(plan.words / Math.max(1, data.scenes.length)));
    const Shorter = z.object({ scenes: z.array(z.object({ index: z.number(), lines: z.array(z.object({ speaker: z.string(), text: z.string() })) })) });
    try {
      const { data: s } = await llm.generateJson({
        system: `You are the script editor of a short animated reel. ${LANGUAGE_RULES[language]} You shorten spoken lines so the reel fits its length, keeping the story, the speakers and the emotional beats. Simple words a child understands.`,
        prompt: `The reel is ${plan.targetSec} seconds, so ALL lines together may have at most ${plan.words} words (about ${perScene} per scene). Now they have ${before}.\nRewrite each scene's lines shorter: keep the same speakers (you may merge or drop Narrator lines), keep scene 0's first line as the hook.\n${data.scenes.map((sc, i) => `Scene ${i}:\n${sc.dialogue.map((d) => `  ${d.speaker}: ${d.text}`).join("\n")}`).join("\n")}`,
      }, Shorter, { maxTokens: 1000 + data.scenes.length * 250, temperature: 0.4 });
      for (const sc of s.scenes) {
        const scene = data.scenes[sc.index];
        const lines = sc.lines.filter((l) => l.text.trim());
        if (!scene || !lines.length) continue;
        scene.dialogue = lines.map((l, i) => ({ speaker: l.speaker.trim() || "Narrator", text: l.text.trim(), emotion: scene.dialogue.find((d) => d.speaker === l.speaker)?.emotion ?? scene.dialogue[i]?.emotion ?? "warm storytelling" }));
      }
    } catch (e) {
      this.log.warn(`shortening failed: ${e instanceof Error ? e.message : e}`);
    }
    // hard cap: drop trailing lines of the wordiest scenes (never a scene's only line)
    while (spokenWords(data) > plan.words * TOO_LONG) {
      const longest = data.scenes.filter((sc) => sc.dialogue.length > 1).sort((a, b) => spokenWords({ ...data, scenes: [b] }) - spokenWords({ ...data, scenes: [a] }))[0];
      if (!longest) break;
      longest.dialogue.pop();
    }
    await this.activity.record({ entityType: "story", action: "script_shortened", message: `"${data.title}" shortened from ${before} to ${spokenWords(data)} spoken words to fit ${plan.targetSec} s` });
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

  private async save(data: StoryData, req: StoryRequest, language: Language, fp: string, model: string, cast: { id: string; name: string }[], refIds: string[],
    meta: { ageGroup: AgeGroup; sourceMode: StorySource; sourceText: string | null; understanding: StoryBible | null; parentStoryId: string | null; episodeNo: number }) {
    const story = await this.prisma.story.create({
      data: {
        title: data.title, category: req.category, language, targetAudience: data.targetAudience, emotionalObjective: data.emotionalObjective,
        hook: data.hook, moral: data.moral, conceptFingerprint: fp, status: "scripted", model, style: req.style ?? "storybook", targetDurationSec: req.durationSec ?? null,
        ageGroup: meta.ageGroup, sourceMode: meta.sourceMode, sourceText: meta.sourceText, understanding: (meta.understanding ?? undefined) as Prisma.InputJsonValue | undefined,
        parentStoryId: meta.parentStoryId, episodeNo: meta.episodeNo,
        references: refIds.length ? { connect: refIds.map((id) => ({ id })) } : undefined,
        scripts: { create: { version: 1, isCurrent: true, ...this.scriptData(data), scenes: { create: this.sceneRows(data, cast) } } },
      },
    });
    this.events.emit("story", { id: story.id });
    await this.activity.record({ entityType: "story", entityId: story.id, action: "generated", message: `Story "${story.title}" (${data.scenes.length} scenes, ${language}) generated with ${model} (${meta.sourceMode}${meta.parentStoryId ? `, episode ${meta.episodeNo}` : ""})` });
    return { id: story.id };
  }

  async saveRevision(storyId: string, data: StoryData, feedback: string | null, model: string, storyCast: { id: string; name: string }[] = []) {
    // the story's own cast first, so a revision never swaps a permanent character for a same-named one
    const others = await this.prisma.character.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
    const cast = [...storyCast, ...others.filter((o) => !storyCast.some((c) => c.id === o.id))];
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
  style: z.enum(STYLE_IDS).optional(),
  durationSec: z.union([z.literal(LENGTHS[0]), z.literal(LENGTHS[1]), z.literal(LENGTHS[2])]).optional(),
  ageGroup: z.enum(AGE_GROUPS).optional(),
  mode: z.enum(STORY_SOURCES).optional(),
  /** the creator's idea or full story (kept verbatim) */
  sourceText: z.string().trim().max(20000).optional(),
  parentStoryId: z.string().uuid().optional(),
}).superRefine((b, ctx) => {
  if ((b.mode === "idea" || b.mode === "full_story") && (b.sourceText?.length ?? 0) < 10) ctx.addIssue({ code: "custom", path: ["sourceText"], message: "Write your idea or story (at least 10 characters)" });
  if (b.mode === "continuation" && !b.parentStoryId) ctx.addIssue({ code: "custom", path: ["parentStoryId"], message: "Choose the episode to continue" });
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

@Module({ imports: [SettingsModule, PromptsModule], controllers: [StoriesController], providers: [StoryEngine], exports: [StoryEngine] })
export class StoriesModule {}
