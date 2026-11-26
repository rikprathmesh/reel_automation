import { BASE_NEGATIVES, type ScenePromptSpec } from "./spec.ts";

/**
 * Model adapters: one provider-independent ScenePromptSpec → a prompt shaped for one model's real abilities.
 * Capabilities are declared per model from its documentation; anything a model cannot do is listed in `dropped`
 * (shown in Prompt Studio) instead of being sent as if it were supported. Whether a model is actually installed
 * is a separate, runtime fact (media-service workflows), see PromptsService.models().
 */

export type PromptStyle = "tags" | "prose" | "veo" | "none";

export interface ModelCapabilities {
  id: string;
  label: string;
  output: "image" | "video";
  /** true only for models that generate motion; Ken Burns over a still is NOT AI animation */
  isAiAnimation: boolean;
  textToVideo: boolean;
  imageToVideo: boolean;
  /** how character reference images condition the output */
  referenceImages: "none" | "ip_adapter" | "first_frame" | "ingredients";
  firstFrame: boolean;
  lastFrame: boolean;
  /** "prompt" = camera words in the prompt (approximate); "params" = explicit controls; "pan_zoom" = crop motion only */
  camera: "none" | "prompt" | "params" | "pan_zoom";
  negativePrompt: boolean;
  /** usable text prompt length in words (SD1.5 CLIP sees 75-token chunks; longer prompts are diluted) */
  maxPromptWords: number;
  /** native clip length; longer scenes are split into several clips or held */
  maxClipSec: number;
  fps: number;
  resolution: string;
  audio: boolean;
  lipSync: boolean;
  promptStyle: PromptStyle;
  requiresGpu: boolean;
  /** media-service workflow that must exist for this model to run ("ffmpeg" = always available) */
  workflow: string;
  license: string;
  notes: string;
}

export const MODELS: Record<string, ModelCapabilities> = {
  "sd15-still": {
    id: "sd15-still", label: "SD 1.5 keyframe still (DreamShaper + IP-Adapter)", output: "image", isAiAnimation: false,
    textToVideo: false, imageToVideo: false, referenceImages: "ip_adapter", firstFrame: false, lastFrame: false, camera: "none",
    negativePrompt: true, maxPromptWords: 110, maxClipSec: 0, fps: 0, resolution: "432×768 → 1080×1920", audio: false, lipSync: false,
    promptStyle: "tags", requiresGpu: false, workflow: "txt2img_ref", license: "CreativeML OpenRAIL-M (DreamShaper), Apache-2.0 (IP-Adapter)",
    notes: "Installed. One still per scene (the keyframe for image-to-video models). ~3-4 min per image on this CPU. At LCM cfg 1.0 the negative prompt has little effect.",
  },
  "animatediff-lcm": {
    id: "animatediff-lcm", label: "AnimateDiff v3 + LCM (SD 1.5)", output: "video", isAiAnimation: true,
    textToVideo: true, imageToVideo: true, referenceImages: "ip_adapter", firstFrame: true, lastFrame: false, camera: "prompt",
    negativePrompt: true, maxPromptWords: 110, maxClipSec: 2, fps: 8, resolution: "384×672 (upscaled)", audio: false, lipSync: false,
    promptStyle: "tags", requiresGpu: false, workflow: "animatediff", license: "AnimateDiff v3 motion module + AnimateDiff-Evolved: Apache-2.0; LCM-LoRA: open",
    notes: "The only real-animation model that runs on this CPU, slowly: about 2 s of motion per scene (16 frames at 8 fps, smoothed to 30 fps), then the last frame is held. Simple continuous motion; no precise choreography. Image-to-video from the scene keyframe + character references.",
  },
  "wan21-i2v": {
    id: "wan21-i2v", label: "Wan 2.1 image-to-video (GPU)", output: "video", isAiAnimation: true,
    textToVideo: true, imageToVideo: true, referenceImages: "first_frame", firstFrame: true, lastFrame: false, camera: "prompt",
    negativePrompt: true, maxPromptWords: 220, maxClipSec: 5, fps: 16, resolution: "480p / 720p", audio: false, lipSync: false,
    promptStyle: "prose", requiresGpu: true, workflow: "wan_i2v", license: "Apache-2.0",
    notes: "Best open quality for character motion. Needs an NVIDIA GPU (or a remote GPU ComfyUI). Not runnable on this laptop.",
  },
  "ltxv-i2v": {
    id: "ltxv-i2v", label: "LTX-Video image-to-video (GPU)", output: "video", isAiAnimation: true,
    textToVideo: true, imageToVideo: true, referenceImages: "first_frame", firstFrame: true, lastFrame: true, camera: "prompt",
    negativePrompt: true, maxPromptWords: 200, maxClipSec: 8, fps: 24, resolution: "768×512 class", audio: false, lipSync: false,
    promptStyle: "prose", requiresGpu: true, workflow: "ltxv_i2v", license: "LTX-Video open weights licence (check commercial terms)",
    notes: "Fast GPU model; likes long chronological paragraphs; supports first and last keyframes. Needs an NVIDIA GPU.",
  },
  "svd-xt": {
    id: "svd-xt", label: "Stable Video Diffusion XT (GPU)", output: "video", isAiAnimation: true,
    textToVideo: false, imageToVideo: true, referenceImages: "first_frame", firstFrame: true, lastFrame: false, camera: "none",
    negativePrompt: false, maxPromptWords: 0, maxClipSec: 3, fps: 8, resolution: "576×1024", audio: false, lipSync: false,
    promptStyle: "none", requiresGpu: true, workflow: "img2vid", license: "Stability AI Community License",
    notes: "Animates the keyframe without any text control: actions, expressions and camera cannot be directed.",
  },
  "veo-flow": {
    id: "veo-flow", label: "Google Flow / Veo (you make the clip in Flow)", output: "video", isAiAnimation: true,
    textToVideo: true, imageToVideo: true, referenceImages: "ingredients", firstFrame: true, lastFrame: false, camera: "prompt",
    negativePrompt: false, maxPromptWords: 420, maxClipSec: 8, fps: 24, resolution: "Flow output (vertical 9:16)", audio: true, lipSync: true,
    promptStyle: "veo", requiresGpu: false, workflow: "manual", license: "Google Flow / Veo terms of your Google account",
    notes: "Best quality: real character animation with voices and sound made by Veo. Flow has no public API, so you paste this prompt into Flow (with the character images as ingredients), download the 8 s clip and upload it on the Flow tab. ReelForge assembles the reel.",
  },
  kenburns: {
    id: "kenburns", label: "Camera motion over still (FFmpeg, NOT AI animation)", output: "video", isAiAnimation: false,
    textToVideo: false, imageToVideo: true, referenceImages: "none", firstFrame: true, lastFrame: false, camera: "pan_zoom",
    negativePrompt: false, maxPromptWords: 0, maxClipSec: 120, fps: 30, resolution: "1080×1920", audio: false, lipSync: false,
    promptStyle: "none", requiresGpu: false, workflow: "ffmpeg", license: "FFmpeg (LGPL/GPL)",
    notes: "Fallback only: zoom/pan over the keyframe. Characters do not move. Reels made this way are labelled as not animated.",
  },
};

export const DEFAULT_VIDEO_MODEL = "animatediff-lcm";
export const KEYFRAME_MODEL = "sd15-still";

export interface RenderedPrompt {
  positive: string;
  negative: string;
  params: Record<string, unknown>;
  /** spec instructions this model cannot follow */
  dropped: string[];
  /** spec sections handled by another stage (audio → TTS/mixer) */
  routed: string[];
}

const SHOT_TEXT: Record<string, string> = {
  extreme_wide: "extreme wide shot", wide: "wide shot", medium: "medium shot", medium_close_up: "medium close-up", close_up: "close-up",
  extreme_close_up: "extreme close-up", over_the_shoulder: "over-the-shoulder shot", low_angle: "low-angle shot", high_angle: "high-angle shot", birds_eye: "bird's-eye view",
};
const MOVE_TEXT: Record<string, string> = {
  static: "static camera", slow_push_in: "slow push-in", pull_out: "slow pull-out", pan_left: "camera pans left", pan_right: "camera pans right",
  tilt_up: "camera tilts up", tilt_down: "camera tilts down", tracking: "tracking shot following the character", orbit: "slow orbit around the subject",
  crane_up: "camera cranes up", crane_down: "camera cranes down", handheld_gentle: "gentle handheld sway",
};
/** Ken Burns has seven crop moves; map the directed camera move onto the closest one. */
export const KENBURNS_MOVE: Record<string, string> = {
  static: "static", slow_push_in: "zoom_in", pull_out: "zoom_out", pan_left: "pan_left", pan_right: "pan_right", tilt_up: "pan_up", tilt_down: "pan_down",
  tracking: "pan_right", orbit: "zoom_in", crane_up: "pan_up", crane_down: "pan_down", handheld_gentle: "static",
};

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").replace(/[()]/g, "").trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const nonEmpty = (xs: (string | undefined | null)[]) => xs.map(clean).filter(Boolean);

function negativeText(spec: ScenePromptSpec): string {
  const parts = [spec.style.negative, ...spec.characters.map((c) => c.negative), ...spec.negative];
  const seen = new Set<string>();
  return parts.flatMap((p) => p.split(",")).map((p) => p.trim()).filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).join(", ");
}

/**
 * Tag-style prompt for SD 1.5 (stills and AnimateDiff). Parts are added in priority order and the lowest-priority
 * parts are trimmed when the budget is exceeded (trimmed parts are reported, never silently lost).
 */
function renderTags(spec: ScenePromptSpec, caps: ModelCapabilities, motion: boolean): { positive: string; trimmed: string[] } {
  const many = spec.characters.length;
  // SD 1.5 weighs early words most: the scene (moment, place, layout) comes before the long identity descriptions,
  // otherwise every keyframe becomes a character portrait on a plain backdrop (observed 2026-11-26)
  const placement = many === 2 ? `${clean(spec.characters[0]!.name)} on the left, ${clean(spec.characters[1]!.name)} on the right` : "";
  const parts: { text: string; label: string }[] = [
    { text: spec.style.prompt, label: "style" },
    { text: `(${clean(spec.keyMoment)}:1.2)`, label: "key moment" },
    { text: `(${nonEmpty([spec.environment.location, spec.environment.timeOfDay]).join(", ")}:1.15)`, label: "location and time" },
    { text: nonEmpty([SHOT_TEXT[spec.camera.shot], spec.camera.angle]).join(", "), label: "shot and angle" },
    { text: many <= 1 ? "solo, a single character" : `exactly ${many} different characters side by side, ${placement}`.replace(/, $/, ""), label: "character count" },
    ...spec.characters.flatMap((c) => [
      { text: spec.style.cast === "name" ? clean(c.name) : `(${clean(c.name)}: ${clean(c.identity)}:1.1)`, label: `${c.name} identity` },
      { text: nonEmpty([c.beat.action, c.beat.expression]).join(", "), label: `${c.name} action and expression` },
      ...(motion ? [{ text: nonEmpty(c.beat.movements.slice(0, 2)).join(", "), label: `${c.name} movements` }] : []),
    ]),
    { text: clean(spec.environment.weather), label: "weather" },
    ...(motion ? [{ text: MOVE_TEXT[spec.camera.movement] ?? "", label: "camera movement" }] : []),
    { text: nonEmpty([spec.visual.lighting, spec.visual.atmosphere]).join(", "), label: "lighting and atmosphere" },
    { text: nonEmpty(spec.environment.objects.slice(0, 3)).join(", "), label: "objects" },
    { text: nonEmpty(spec.environment.details.slice(0, motion ? 3 : 2)).join(", "), label: "environment details" },
    { text: clean(spec.environment.background), label: "background" },
    { text: clean(spec.visual.colorGrade), label: "colour grade" },
    { text: nonEmpty(spec.visual.effects.slice(0, 2)).join(", "), label: "effects" },
  ].filter((p) => p.text);
  const kept: string[] = [];
  const trimmed: string[] = [];
  let budget = caps.maxPromptWords;
  for (const p of parts) {
    const w = words(p.text);
    // identity and the key moment are never trimmed
    if (w <= budget || /identity|key moment|style|location/.test(p.label)) { kept.push(p.text); budget -= w; } else trimmed.push(p.label);
  }
  return { positive: kept.join(", "), trimmed };
}

/** Chronological paragraph for DiT video models (Wan, LTX): who, where, what happens in order, camera, light. */
function renderProse(spec: ScenePromptSpec, caps: ModelCapabilities): { positive: string; trimmed: string[] } {
  const e = spec.environment;
  const sentences: string[] = [];
  sentences.push(`${clean(spec.style.label)} animation. ${cap(SHOT_TEXT[spec.camera.shot] ?? "Shot")}, ${clean(spec.camera.angle)}.`);
  sentences.push(`${cap(clean(e.location))}, ${clean(e.timeOfDay)}, ${clean(e.weather)}; ${clean(e.background)}. ${nonEmpty(e.objects).join("; ")}.`);
  for (const c of spec.characters) {
    const b = c.beat;
    sentences.push(`${c.name}, ${clean(c.identity)}, starts ${clean(b.startPosition)}. ${c.name} ${lower(clean(b.action))}: ${nonEmpty(b.movements).join(", then ")}. ${cap(clean(b.expression))}; eyes ${lower(clean(b.eyes))}; ${lower(clean(b.head))}; mouth ${lower(clean(b.mouth))}.${b.interaction ? ` ${cap(clean(b.interaction))}.` : ""} By the end ${c.name} is ${lower(clean(b.endPosition))}.`);
  }
  sentences.push(`Camera: ${clean(spec.camera.movementDetail) || MOVE_TEXT[spec.camera.movement]}. ${cap(clean(spec.camera.focus))}.`);
  sentences.push(`${cap(clean(spec.visual.lighting))}. ${cap(clean(spec.visual.atmosphere))}. ${nonEmpty(e.details).join(", ")}. ${cap(clean(spec.visual.colorGrade))}. Smooth, natural, consistent motion; characters keep exactly the same design in every frame.`);
  const text = sentences.join(" ").replace(/\s+\./g, ".").replace(/\.\./g, ".").replace(/\s{2,}/g, " ").trim();
  const trimmed: string[] = [];
  let out = text;
  if (words(text) > caps.maxPromptWords) {
    out = text.split(/\s+/).slice(0, caps.maxPromptWords).join(" ");
    trimmed.push(`text after ${caps.maxPromptWords} words`);
  }
  return { positive: out, trimmed };
}

/** Drops phrases that repeat another phrase in the list (small models restate the action as a movement, the gaze as eyes). */
function distinct(items: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\b(directly|then|the|a|an)\b/g, "").replace(/\s+/g, " ").trim();
  for (const raw of items) {
    const t = clean(raw);
    if (!t) continue;
    const k = norm(t);
    if (out.some((o) => norm(o).includes(k) || k.includes(norm(o)))) continue;
    out.push(t);
  }
  return out;
}

/** Spoken-voice description for Veo from the character's voice profile name and personality. */
function voiceOf(c: { name: string; voice: string | null }): string {
  const v = (c.voice ?? "").toLowerCase();
  if (/elder woman|grand/.test(v)) return "soft, loving grandmother voice";
  if (/elder man/.test(v)) return "slow, wise old man voice";
  if (/woman/.test(v)) return "gentle, warm woman's voice";
  if (/strong man/.test(v)) return "deep, strong, kind man's voice";
  if (/\bman\b/.test(v)) return "calm young man's voice";
  if (/boy|squirrel/.test(v)) return "bright, playful young child's cartoon voice";
  return "cute, friendly cartoon character voice";
}

const STYLE_FOR_VEO: Record<string, string> = {
  storybook: "Pixar-style 3D animated cartoon for kids, vibrant colours, soft cinematic lighting, richly detailed environment, highly detailed fur and fabric, smooth natural character animation",
};

/**
 * One self-contained Veo paragraph per 8 s clip: look, place, who (with the permanent identity), what happens in order,
 * camera, light, and the AUDIO (Veo makes voices and sound): every spoken line with its speaker, voice and emotion.
 */
function renderVeo(spec: ScenePromptSpec, caps: ModelCapabilities): { positive: string; notes: string[] } {
  const e = spec.environment;
  const hindi = spec.audio.dialogue.some((d) => /[\u0900-\u097F]/.test(d.text));
  const lang = hindi ? "Hindi" : "English";
  const style = STYLE_FOR_VEO[spec.style.id] ?? `${spec.style.label} animation style: ${spec.style.prompt}`;
  const out: string[] = [];
  out.push(`Vertical 9:16 video. ${style}.`);
  // tight paragraph: Veo follows short, concrete prompts better than long repetitive ones
  out.push(`Setting: ${distinct([e.location, e.timeOfDay, e.weather]).join(", ")}. ${distinct([e.background, ...e.objects.slice(0, 3), ...e.details.slice(0, 2)]).join("; ")}.`);
  for (const c of spec.characters) out.push(`${c.name}: ${clean(c.identity)}. Keep ${c.name} exactly as in the reference image.`);
  for (const c of spec.characters) {
    const b = c.beat;
    const moves = distinct([b.action, ...b.movements]).map(lower);
    const face = distinct([b.expression, b.eyes && `eyes ${lower(clean(b.eyes))}`, b.head]).map(lower);
    out.push(`${c.name}${b.startPosition ? ` starts ${lower(clean(b.startPosition))}, then` : ""} ${moves.join(", then ")}; ${face.join(", ")}.${b.endPosition ? ` Ends ${lower(clean(b.endPosition))}.` : ""}`);
  }
  out.push(`Camera: ${SHOT_TEXT[spec.camera.shot] ?? "shot"}, ${clean(spec.camera.angle)}; ${clean(spec.camera.movementDetail) || MOVE_TEXT[spec.camera.movement]}.`);
  out.push(`Light and mood: ${distinct([spec.visual.lighting, spec.visual.atmosphere, spec.visual.colorGrade]).slice(0, 2).join(", ")}.`);
  const described = new Set<string>();
  const lines = spec.audio.dialogue.map((d) => {
    // each speaker's voice is described once; later lines just name the speaker
    const key = d.speaker.toLowerCase();
    if (described.has(key)) return `${d.speaker}, ${clean(d.emotion) || "natural"}: "${d.text.trim()}"`;
    described.add(key);
    const who = d.speaker.toLowerCase() === "narrator"
      ? `Narrator (voice-over, a warm, expressive ${lang} storyteller voice, like a grandmother telling a bedtime story)`
      : `${d.speaker} (${voiceOf(spec.characters.find((c) => c.name.toLowerCase() === d.speaker.toLowerCase()) ?? { name: d.speaker, voice: null })}, lips moving in sync)`;
    return `${who}, ${clean(d.emotion) || "natural"}, says in ${lang}: "${d.text.trim()}"`;
  });
  if (lines.length) out.push(`Audio, natural fluent ${lang} speech with real emotion, not robotic: ${lines.join(" Then ")}`);
  // one continuous music track is added under the whole reel by ReelForge; music inside each clip would jump at every cut
  const sounds = distinct([spec.audio.ambience, ...spec.audio.sfx]).filter((x) => !/music/i.test(x));
  out.push(`Sound: ${sounds.join("; ") || "gentle natural ambience"}. No background music.`);
  out.push("One continuous shot. No on-screen text, no subtitles, no captions, no logos, no watermark. Every character keeps exactly the same design, colours and clothing in every frame.");
  const positive = out.join(" ").replace(/\s+\./g, ".").replace(/\.\./g, ".").replace(/\s{2,}/g, " ").trim();
  const notes: string[] = [];
  const words = spec.audio.dialogue.reduce((n, d) => n + d.text.split(/\s+/).filter(Boolean).length, 0);
  const speechSec = words / 2.3;
  if (speechSec > caps.maxClipSec - 0.5) notes.push(`the dialogue needs about ${speechSec.toFixed(0)} s but a Flow/Veo clip is ${caps.maxClipSec} s: make 2 clips for this scene (split the lines) or shorten them`);
  if (words > 0 && hindi) notes.push("Veo's Hindi pronunciation varies between generations: listen before uploading, regenerate in Flow if a line sounds wrong");
  return { positive, notes };
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

export function renderPrompt(spec: ScenePromptSpec, modelId: string): RenderedPrompt {
  const caps = MODELS[modelId];
  if (!caps) throw new Error(`Unknown model adapter "${modelId}"`);
  const dropped: string[] = [];
  const routed = caps.audio ? ["voices, sound effects and ambience are generated by the model in the clip"] : ["dialogue and voices → TTS", "sound effects and ambience → audio mixer"];
  if (!caps.lipSync && spec.audio.dialogue.length) dropped.push("lip-sync (not supported by this model; mouths animate only as described)");

  let positive = "";
  let negative = caps.negativePrompt ? negativeText(spec) : "";
  if (!caps.negativePrompt) dropped.push("negative prompt (not supported)");
  const params: Record<string, unknown> = {};

  if (caps.promptStyle === "tags") {
    const motion = caps.output === "video";
    const r = renderTags(spec, caps, motion);
    positive = r.positive;
    dropped.push(...r.trimmed.map((t) => `${t} (trimmed: prompt budget ${caps.maxPromptWords} words)`));
    if (!motion) dropped.push("body movements, camera movement and start/end positions (a still shows one moment)");
    else dropped.push("exact start/end positions and multi-step choreography (AnimateDiff follows simple continuous motion only)", "focus pulls (no depth-of-field control)");
  } else if (caps.promptStyle === "veo") {
    const r = renderVeo(spec, caps);
    positive = r.positive;
    dropped.push(...r.notes);
  } else if (caps.promptStyle === "prose") {
    const r = renderProse(spec, caps);
    positive = r.positive;
    dropped.push(...r.trimmed.map((t) => `${t} (trimmed)`));
    if (!caps.lastFrame) dropped.push("explicit last-frame keyframe (end position is described in text only)");
  } else {
    dropped.push("all text instructions: actions, expressions, environment and camera direction (this model takes no text prompt)");
  }

  if (caps.referenceImages === "first_frame") dropped.push("separate character reference images (identity comes from the keyframe only)");
  if (caps.camera === "pan_zoom") params.kenburns = KENBURNS_MOVE[spec.camera.movement] ?? "static";
  if (caps.output === "video" && caps.maxClipSec > 0) {
    const clips = Math.max(1, Math.ceil(spec.durationSec / caps.maxClipSec - 0.01));
    params.clips = clips;
    params.clipSec = Math.min(spec.durationSec, caps.maxClipSec);
    params.fps = caps.fps;
    if (clips > 1 && caps.isAiAnimation) dropped.push(`one continuous ${spec.durationSec.toFixed(0)} s shot (model max ${caps.maxClipSec} s: the scene becomes ${clips} clips chained from the last frame)`);
  }
  if (spec.override?.positive) positive = spec.override.positive;
  if (spec.override?.negative !== undefined && caps.negativePrompt) negative = spec.override.negative;
  return { positive, negative, params, dropped, routed };
}

/** Base negatives every new spec starts with (exported for tests / templates). */
export const DEFAULT_SPEC_NEGATIVES = [...BASE_NEGATIVES];
