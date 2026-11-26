import type { ModelCapabilities, RenderedPrompt } from "./adapters.ts";
import type { ScenePromptSpec } from "./spec.ts";

/**
 * Deterministic prompt-quality rubric (sections A-J). It checks that instructions are PRESENT and SPECIFIC; it
 * cannot judge artistic quality. Failed checks become concrete fix instructions for the auto-improve pass.
 */

export interface PromptCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: "error" | "warn";
  weight: number;
  detail: string;
}
export interface PromptEvaluation {
  score: number;
  checks: PromptCheck[];
  /** fix instructions for the LLM (from failed checks it can fix) */
  fixes: string[];
  /** facts the LLM cannot fix (missing reference image, model limits) */
  notes: string[];
}

const filled = (s: string | undefined | null, min = 2) => (s ?? "").trim().split(/\s+/).filter(Boolean).length >= min;
const VAGUE = /^(moves?|is there|stands?|looks?|walks?|happy|sad|nothing|none|n\/a|normal|neutral)\.?$/i;
const specific = (s: string | undefined | null, min = 4) => filled(s, min) && !VAGUE.test((s ?? "").trim());

function jaccard(a: string, b: string): number {
  const A = new Set(a.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  const B = new Set(b.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}

/** Scene-specific words only (identity, style and negatives are shared by design). */
export function sceneFingerprint(spec: ScenePromptSpec): string {
  return [spec.keyMoment, spec.environment.location, ...spec.characters.flatMap((c) => [c.beat.action, ...c.beat.movements]), spec.camera.movementDetail].join(" ");
}

export function evaluateScene(spec: ScenePromptSpec, rendered: RenderedPrompt, caps: ModelCapabilities, others: string[] = []): PromptEvaluation {
  const video = caps.output === "video";
  const checks: PromptCheck[] = [];
  const add = (id: string, label: string, ok: boolean, weight: number, detail: string, severity: "error" | "warn" = "warn") => checks.push({ id, label, ok, weight, detail, severity });
  const fixes: string[] = [];
  const notes: string[] = [];

  // A — identity
  const noIdentity = spec.characters.filter((c) => !filled(c.identity, 4));
  add("identity", "Character identity locked", noIdentity.length === 0, 14, noIdentity.length ? `No permanent identity for: ${noIdentity.map((c) => c.name).join(", ")} (create a character profile)` : "Identity tags copied from the permanent profiles", "error");
  if (noIdentity.length) notes.push(`Create character profiles for ${noIdentity.map((c) => c.name).join(", ")}.`);
  if (caps.referenceImages !== "none") {
    const noRef = spec.characters.filter((c) => !c.referenceKey);
    add("reference", "Reference images attached", noRef.length === 0, 8, noRef.length ? `No master reference image yet for: ${noRef.map((c) => c.name).join(", ")}` : `${spec.characters.length} reference image(s) attached`);
    if (noRef.length) notes.push(`Generate or upload master reference images for ${noRef.map((c) => c.name).join(", ")} (Character Studio).`);
  }

  // scene clarity
  const clear = specific(spec.keyMoment, 7);
  add("clarity", "Clear key moment", clear, 8, clear ? spec.keyMoment : "Key moment is missing or vague");
  if (!clear) fixes.push("Write keyMoment as one concrete sentence: who does what, where.");

  // C — actions
  const vagueAction = spec.characters.filter((c) => !specific(c.beat.action, 4));
  add("actions", "Specific character actions", vagueAction.length === 0 && spec.characters.length > 0, 12, vagueAction.length ? `Vague or missing action for: ${vagueAction.map((c) => c.name).join(", ")}` : "Every character has a concrete action");
  if (vagueAction.length) fixes.push(`Give ${vagueAction.map((c) => c.name).join(", ")} a concrete visible action with a verb (at least 6 words).`);
  if (video) {
    const noPos = spec.characters.filter((c) => !filled(c.beat.startPosition) || !filled(c.beat.endPosition));
    add("positions", "Start and end positions", noPos.length === 0, 6, noPos.length ? `Missing start/end position for: ${noPos.map((c) => c.name).join(", ")}` : "Start and end positions defined");
    if (noPos.length) fixes.push(`Describe where ${noPos.map((c) => c.name).join(", ")} start and end in the frame.`);
  }

  // E — body movement
  const stiff = spec.characters.filter((c) => c.beat.movements.filter((m) => specific(m, 3)).length < (video ? 2 : 1));
  add("movement", "Natural body movement", stiff.length === 0, video ? 12 : 5, stiff.length ? `Too few specific movements for: ${stiff.map((c) => c.name).join(", ")}` : "Body movements described");
  if (stiff.length) fixes.push(`List 2-4 specific natural body movements (paws/hands, ears, tail, head, weight shifts) for ${stiff.map((c) => c.name).join(", ")}.`);

  // D — face
  const flat = spec.characters.filter((c) => !filled(c.beat.expression) || (!filled(c.beat.eyes) && !filled(c.beat.mouth)));
  add("face", "Facial expressions", flat.length === 0, 8, flat.length ? `Missing expression / eyes / mouth for: ${flat.map((c) => c.name).join(", ")}` : "Expressions, eyes and mouth described");
  if (flat.length) fixes.push(`Describe the expression, eye movement and mouth of ${flat.map((c) => c.name).join(", ")}.`);

  // F — camera
  const camOk = Boolean(spec.camera.shot) && (!video || specific(spec.camera.movementDetail, 5));
  add("camera", "Camera direction", camOk, video ? 10 : 4, camOk ? `${spec.camera.shot}, ${spec.camera.movement}` : "Camera movement through the shot is not described");
  if (!camOk) fixes.push("Describe how the camera moves through the shot from first to last frame (camera.movementDetail).");

  // B — environment
  const env = spec.environment;
  const envOk = specific(env.location, 3) && filled(env.timeOfDay, 1) && env.objects.length + env.details.length >= 3;
  add("environment", "Environment detail", envOk, 8, envOk ? env.location : "Location, time of day or environmental details are thin");
  if (!envOk) fixes.push("Make the environment specific: a precise location, time of day, 2-5 objects and 2-4 living details (wind, water, light, insects).");

  // G — look
  const lookOk = filled(spec.visual.lighting, 3) && filled(spec.visual.atmosphere, 2);
  add("visual", "Lighting and atmosphere", lookOk, 5, lookOk ? spec.visual.lighting : "Lighting or atmosphere missing");
  if (!lookOk) fixes.push("Describe the lighting (source, direction, quality) and the atmosphere.");

  // I — continuity
  const contOk = (spec.sceneIndex === 0 || filled(spec.continuity.fromPrevious, 4)) && (spec.isLastScene || filled(spec.continuity.toNext, 4));
  add("continuity", "Scene continuity", contOk, 7, contOk ? "Links to the previous and next scene" : "Continuity with neighbouring scenes is not described");
  if (!contOk) fixes.push("Describe how this shot continues from the previous scene's ending and leads into the next scene.");

  // H — audio routed: dialogue must have voices
  const unvoiced = spec.audio.dialogue.filter((d) => d.speaker.toLowerCase() !== "narrator" && !spec.characters.some((c) => c.name.toLowerCase() === d.speaker.toLowerCase() && c.voice));
  add("voices", "Voices for dialogue", unvoiced.length === 0, 3, unvoiced.length ? `No voice profile for: ${[...new Set(unvoiced.map((d) => d.speaker))].join(", ")} (narrator voice will be used)` : "Every speaker has a voice");

  // model compatibility
  const hardDrops = rendered.dropped.filter((d) => /trimmed/.test(d));
  add("compatibility", "Fits the model", hardDrops.length === 0, 6, hardDrops.length ? `Over the model's prompt budget: ${hardDrops.join("; ")}` : `${rendered.dropped.length} unsupported instruction(s) listed, none trimmed`);
  if (hardDrops.length) fixes.push("Use fewer, shorter phrases: the prompt is over the model's budget.");

  // distinctiveness vs other scenes
  const fp = sceneFingerprint(spec);
  const maxSim = others.reduce((m, o) => Math.max(m, jaccard(fp, o)), 0);
  add("distinct", "Distinct from other scenes", maxSim < 0.6, 5, maxSim >= 0.6 ? `Very similar to another scene (${Math.round(maxSim * 100)}% overlap)` : "Scene-specific");
  if (maxSim >= 0.6) fixes.push("This scene's action and setting read like another scene: make what happens here specific to this moment of the story.");

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.reduce((n, c) => n + (c.ok ? c.weight : 0), 0);
  return { score: Math.round((got / total) * 100), checks, fixes, notes };
}


/** Auto-improve threshold: below this, one AI improvement pass runs before the prompt is saved. */
export const AUTO_IMPROVE_BELOW = 80;
