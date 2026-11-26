import { BASE_NEGATIVES, type CharacterBeat, type CharacterProfile, type SceneDraft, type ScenePromptSpec, type SpecCharacter } from "./spec.ts";

/** Pure assembly helpers (no Nest/Prisma): unit-tested in test/prompts.test.ts. */

const t = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
const usable = (s: string | undefined | null) => Boolean(t(s)) && !/^(none|n\/a|-|no)$/i.test(t(s));

/** Fixes phrasing glitches small models leave in identity text ("wearing wears a red scarf"). Pure. */
export function cleanIdentity(s: string): string {
  return s.replace(/\bwearing\s+(?:wears?|wearing)\b/gi, "wearing").replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").trim();
}

/** Compact identity tags restated verbatim in every scene prompt (Character.identityPrompt). */
export function identityTags(p: CharacterProfile): string {
  const raw = [
    t(p.species) && `${t(p.ageAppearance)} ${t(p.species)}`.trim(),
    t(p.surface),
    t(p.eyeColor) && (/\beyes?\b/i.test(p.eyeColor) ? t(p.eyeColor) : `${t(p.eyeColor)} eyes`),
    t(p.face),
    t(p.bodyProportions),
    usable(p.clothing) && `wearing ${t(p.clothing)}`,
    ...p.accessories.filter(usable).map(t),
  ].filter((x): x is string => Boolean(x));
  // split into phrases and drop repeats (small models often restate the eyes inside "face", the scarf in accessories, ...)
  const phrases = raw.flatMap((x) => x.split(/\s*,\s*/)).map((x) => x.trim()).filter(Boolean);
  const key = (x: string) => x.toLowerCase().replace(/^wearing\s+/, "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  const out: string[] = [];
  for (const ph of phrases) {
    const k = key(ph);
    if (!k || out.some((o) => key(o) === k || key(o).includes(k))) continue;
    // a longer phrase replaces a shorter one it contains ("golden" → "golden fluffy fur")
    const shorter = out.findIndex((o) => k.includes(key(o)));
    if (shorter >= 0) out[shorter] = ph; else out.push(ph);
  }
  return cleanIdentity(out.join(", "));
}

const STOP = new Set("a an the and or with of in on to his her its their is are has have very small big little who always around wears wearing that this he she it they".split(" "));

/** Descriptive words the story gives that the designed identity dropped (e.g. "fluffy"). Pure; unit-tested. */
export function missingDetails(storyAppearance: string, identity: string): string[] {
  const have = new Set(identity.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  const words = storyAppearance.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words.filter((w) => !have.has(w) && !have.has(w.replace(/s$/, ""))))];
}

export interface CastEntry {
  id: string;
  name: string;
  identity: string;
  clothing: string;
  accessories: string[];
  permanentColors: string[];
  negative: string;
  referenceKey: string | null;
  referenceUrl: string | null;
  voice: string | null;
  expressions: Record<string, string>;
  /** expression preset the script chose for this scene, if any */
  expression: string | null;
}

export interface AssembleContext {
  sceneIndex: number;
  sceneTitle: string;
  description: string;
  durationSec: number;
  isFirst: boolean;
  isLast: boolean;
  style: ScenePromptSpec["style"];
  cast: CastEntry[];
  dialogue: { speaker: string; text: string; emotion: string }[];
}

const blankBeat = (name: string): CharacterBeat => ({ name, action: "", movements: [], interaction: "", startPosition: "", endPosition: "", expression: "", eyes: "", mouth: "", head: "" });

/**
 * Merges the LLM's creative draft with the permanent identities of the scene's cast.
 * - Identity always comes from the cast profile (the draft cannot change looks).
 * - Draft beats for names that are not in the scene's cast are discarded (reported in `ignored`).
 * - Cast members the draft forgot get an empty beat (the evaluator flags it).
 */
export function assembleSceneSpec(draft: SceneDraft, ctx: AssembleContext): { spec: ScenePromptSpec; ignored: string[] } {
  const norm = (s: string) => s.trim().toLowerCase();
  const ignored = draft.characters.filter((b) => !ctx.cast.some((c) => norm(c.name) === norm(b.name))).map((b) => b.name);
  const characters: SpecCharacter[] = ctx.cast.map((c) => {
    const beat = draft.characters.find((b) => norm(b.name) === norm(c.name)) ?? blankBeat(c.name);
    // the script's expression preset wins over a vague draft expression
    const preset = c.expression ? c.expressions[c.expression] ?? c.expression : "";
    return {
      id: c.id, name: c.name, identity: c.identity, clothing: c.clothing, accessories: c.accessories, permanentColors: c.permanentColors,
      negative: c.negative, referenceKey: c.referenceKey, referenceUrl: c.referenceUrl, voice: c.voice,
      beat: { ...beat, name: c.name, expression: t(beat.expression) || preset },
    };
  });
  const spec: ScenePromptSpec = {
    version: 1,
    sceneIndex: ctx.sceneIndex,
    isLastScene: ctx.isLast,
    sceneTitle: ctx.sceneTitle,
    description: ctx.description,
    durationSec: ctx.durationSec,
    keyMoment: t(draft.keyMoment) || ctx.description,
    style: ctx.style,
    characters,
    environment: draft.environment,
    camera: draft.camera,
    visual: draft.visual,
    audio: { ...draft.audio, dialogue: ctx.dialogue, lipSync: ctx.dialogue.some((d) => d.speaker.toLowerCase() !== "narrator") },
    continuity: {
      fromPrevious: ctx.isFirst ? "" : draft.continuity.fromPrevious,
      toNext: ctx.isLast ? "" : draft.continuity.toNext,
      props: draft.continuity.props,
    },
    negative: [...BASE_NEGATIVES],
  };
  return { spec, ignored };
}

/** The draft part of a spec (what the LLM may rewrite in improve / shorten / expand). */
export function draftOf(spec: ScenePromptSpec): SceneDraft {
  return {
    keyMoment: spec.keyMoment,
    environment: spec.environment,
    characters: spec.characters.map((c) => c.beat),
    camera: spec.camera,
    visual: spec.visual,
    audio: { sfx: spec.audio.sfx, ambience: spec.audio.ambience },
    continuity: spec.continuity,
  };
}

export const REFERENCE_VIEWS = ["front", "three_quarter", "side", "back", "closeup", "expressions"] as const;
export type ReferenceView = (typeof REFERENCE_VIEWS)[number];

const VIEW_TEXT: Record<ReferenceView, string> = {
  front: "character model sheet, full body, front view, standing straight, arms relaxed, neutral friendly expression",
  three_quarter: "character model sheet, full body, three-quarter view facing left, natural standing pose",
  side: "character model sheet, full body, exact side profile view facing left",
  back: "character model sheet, full body, back view, showing the back of the head, clothing and tail from behind",
  closeup: "character portrait, head and shoulders close-up, front view, detailed face, clear eye colour",
  expressions: "character expression sheet, head close-ups in a 2x2 grid",
};

export interface ReferenceViewSpec {
  view: ReferenceView;
  identity: string;
  styleLabel: string;
  positive: string;
  negative: string;
}

/** Prompts for the permanent multi-view reference set of one character (plain background, even light). */
export function referenceViewSpecs(name: string, profile: CharacterProfile, style: { label: string; prompt: string; negative: string }, characterNegative: string): ReferenceViewSpec[] {
  const identity = identityTags(profile);
  const colours = profile.permanentColors.length ? `exact colours: ${profile.permanentColors.join(", ")}` : "";
  const negative = [style.negative, characterNegative, "multiple characters, busy background, scenery, cropped body, inconsistent design, extra limbs, text"].filter(Boolean).join(", ");
  return REFERENCE_VIEWS.map((view) => {
    const exprs = view === "expressions" ? profile.expressions.slice(0, 4).map((x) => `${x.name}: ${x.look}`).join("; ") : "";
    const positive = [style.prompt, VIEW_TEXT[view], `(${name}: ${identity}:1.15)`, exprs, colours, `silhouette: ${t(profile.silhouette)}`, "plain soft light-grey background, even studio lighting, crisp clean silhouette, same character design"].filter(Boolean).join(", ");
    return { view, identity, styleLabel: style.label, positive, negative };
  });
}
