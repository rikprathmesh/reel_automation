import { z } from "zod";

/**
 * Structured prompt contracts.
 *
 * Split of responsibility (the core of character consistency):
 * - The LLM writes only the CREATIVE, scene-specific parts (SceneDraft): what happens, how bodies and faces move,
 *   the environment, camera, light, continuity.
 * - Character IDENTITY (looks, colours, clothing, accessories, reference image) is never written by the LLM per
 *   scene. It is copied verbatim from the permanent Character profile, so every scene restates the same identity.
 * - Style, dialogue (from the approved script) and negatives are injected by the system.
 */

export const CAMERA_SHOTS = ["extreme_wide", "wide", "medium", "medium_close_up", "close_up", "extreme_close_up", "over_the_shoulder", "low_angle", "high_angle", "birds_eye"] as const;
export const CAMERA_MOVES = ["static", "slow_push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "tracking", "orbit", "crane_up", "crane_down", "handheld_gentle"] as const;

const str = (d: string) => z.string().describe(d);

export const CharacterBeat = z.object({
  name: str("Exact cast name"),
  action: str("What this character does in the shot, as a concrete visible action with a verb"),
  movements: z.array(z.string()).describe("2-4 natural body movements in order (paws/hands/wings/tail/ears/head)"),
  interaction: str("How they interact with other characters or objects; empty if none"),
  startPosition: str("Where and how they are at the first frame (position in frame, pose, facing)"),
  endPosition: str("Where and how they are at the last frame"),
  expression: str("Facial expression and emotion"),
  eyes: str("Eye movement / gaze"),
  mouth: str("Mouth: talking, smiling, open in surprise, closed"),
  head: str("Head movement: tilt, turn, nod"),
});
export type CharacterBeat = z.infer<typeof CharacterBeat>;

/** What the LLM writes for one scene. */
export const SceneDraft = z.object({
  keyMoment: str("ONE sentence: the single most important frame of this scene (used for the keyframe still)"),
  environment: z.object({
    location: str("Specific place, e.g. 'mossy jungle path between giant ferns'"),
    background: str("What is behind the characters"),
    timeOfDay: str("morning / noon / golden evening / night ..."),
    weather: str("clear, light breeze, drizzle ..."),
    objects: z.array(z.string()).describe("2-5 important objects / props and where they are"),
    details: z.array(z.string()).describe("2-4 living environmental details (leaves swaying, fireflies, ripples)"),
  }),
  characters: z.array(CharacterBeat),
  camera: z.object({
    shot: z.enum(CAMERA_SHOTS),
    angle: str("eye level / slightly low / high ..."),
    movement: z.enum(CAMERA_MOVES),
    movementDetail: str("How the camera moves through the shot, e.g. 'starts wide, slowly tracks beside Sheru, pushes in to a close-up as he sees the butterfly'"),
    focus: str("Depth of field and focus changes, e.g. 'soft background, focus pulls from flower to Sheru'"),
  }),
  visual: z.object({
    lighting: str("Light source, direction and quality"),
    atmosphere: str("Mood and air: mist, sun rays, sparkles"),
    colorGrade: str("Colour palette / grading"),
    effects: z.array(z.string()).describe("Small visual effects, may be empty"),
  }),
  audio: z.object({
    sfx: z.array(z.string()).describe("Sound effects with timing, e.g. 'soft paw steps throughout'"),
    ambience: str("Background ambience"),
  }),
  continuity: z.object({
    fromPrevious: str("How this shot follows the previous scene's ending (empty for the first scene)"),
    toNext: str("How the last frame leads into the next scene (empty for the last scene)"),
    props: str("Objects/positions that must stay consistent"),
  }),
});
export type SceneDraft = z.infer<typeof SceneDraft>;

/** Permanent character identity (Character.visualProfile). */
export const CharacterProfile = z.object({
  species: str("Species or character type, e.g. 'baby lion cub', 'young human girl', 'rabbit'"),
  ageAppearance: str("Apparent age"),
  bodyProportions: str("Body shape and proportions (head-to-body ratio, size, build)"),
  face: str("Face structure: shape, muzzle/nose, cheeks"),
  eyeColor: str("Eye colour and shape"),
  surface: str("Skin / fur / feathers / hair: colour, texture, markings"),
  clothing: str("Permanent clothing with colours, or 'none'"),
  accessories: z.array(z.string()).describe("Permanent accessories with colours (e.g. 'red scarf around the neck')"),
  permanentColors: z.array(z.string()).describe("3-6 colours that must never change"),
  silhouette: str("What makes the silhouette recognisable (ears, tail, crown, hairstyle)"),
  personality: str("Personality in a few words"),
  motionStyle: str("How the character moves (bouncy hops, slow graceful steps ...)"),
  expressions: z.array(z.object({ name: z.string(), look: z.string() })).describe("4-6 named expressions and how the face looks"),
  voice: z.object({ gender: z.enum(["male", "female", "neutral"]), age: z.enum(["toddler", "child", "teen", "adult", "elder"]), tone: z.string() }),
});
export type CharacterProfile = z.infer<typeof CharacterProfile>;

export interface SpecCharacter {
  id: string;
  name: string;
  /** verbatim identity tags from the permanent profile */
  identity: string;
  clothing: string;
  accessories: string[];
  permanentColors: string[];
  negative: string;
  /** storage key of the master reference image (null = none yet) */
  referenceKey: string | null;
  referenceUrl: string | null;
  voice: string | null;
  beat: CharacterBeat;
}

/** The full scene prompt (sections A-J) stored in GeneratedPrompt.spec. */
export interface ScenePromptSpec {
  version: 1;
  sceneIndex: number;
  isLastScene: boolean;
  sceneTitle: string;
  description: string;
  durationSec: number;
  keyMoment: string;
  /** cast "name": flat styles (silhouettes, stick figures) only name characters instead of describing them */
  style: { id: string; label: string; prompt: string; negative: string; cast?: "full" | "name" };
  /** A + C + D + E */
  characters: SpecCharacter[];
  /** B */
  environment: SceneDraft["environment"];
  /** F */
  camera: SceneDraft["camera"];
  /** G */
  visual: SceneDraft["visual"];
  /** H: dialogue comes from the approved script, never from the prompt LLM */
  audio: SceneDraft["audio"] & { dialogue: { speaker: string; text: string; emotion: string }[]; lipSync: boolean };
  /** I */
  continuity: SceneDraft["continuity"];
  /** J */
  negative: string[];
  /** a manual override of the rendered positive / negative text (Prompt Studio "edit final prompt") */
  override?: { positive?: string; negative?: string };
}

/** Consistency negatives every scene carries (section J). */
export const BASE_NEGATIVES = [
  "character morphing", "changing clothes", "changing eye colour", "different character design", "extra limbs", "missing limbs",
  "distorted face", "deformed hands or paws", "flickering", "jittery motion", "unnatural movement", "duplicate characters", "clones",
  "random extra objects", "sudden camera jumps", "inconsistent proportions", "text", "watermark", "logo", "blurry", "low quality",
] as const;
