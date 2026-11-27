import { z } from "zod";

/** Structured output contract for one complete story (all 16 required fields). */
export const DialogueLine = z.object({
  speaker: z.string().describe('Exact character name from the cast, or "Narrator"'),
  text: z.string(),
  emotion: z.string().describe("delivery direction, e.g. excited, whispering, sad"),
});

export const SceneSchema = z.object({
  title: z.string().describe("Short scene title (2-5 words)"),
  description: z.string().describe("What happens in this beat: concrete, visible actions in story order"),
  location: z.string().describe("Where it happens (a story-bible location when given)"),
  events: z.array(z.number().int()).describe("Story-bible event numbers this scene shows (empty if there is no bible)"),
  visualPrompt: z.string().describe("In ENGLISH: image prompt for ONE vertical 9:16 cute cartoon frame: action, composition, setting, time of day, mood. Name characters but do not re-describe their looks."),
  characters: z.array(z.string()).describe("Cast names present in the frame"),
  expressions: z.array(z.string()).describe("Expression preset per character in the same order, e.g. happy, worried"),
  camera: z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "static"]),
  transition: z.enum(["fade", "dissolve", "slideleft", "slideup", "wipeleft", "circleopen", "fadeblack", "cut"]).describe("transition INTO the next scene"),
  dialogue: z.array(DialogueLine).describe("3-4 lines spoken in this scene: Narrator lines that tell the story plus short character lines"),
  sfx: z.string().describe("One short sound effect, or empty string"),
  onScreenText: z.string().describe("Max 6 words for key beats, or empty string"),
  durationHint: z.number().describe("seconds"),
});

export const StorySchema = z.object({
  title: z.string(),
  targetAudience: z.string(),
  emotionalObjective: z.string().describe("What the viewer should feel"),
  hook: z.string().describe("The EXACT first spoken sentence (max 12 words) — a question, surprise or bold claim that stops the scroll. Scene 1 must start with this line."),
  premise: z.string().describe("One-sentence premise, used to avoid repeating concepts"),
  narration: z.string().describe("All spoken lines of the reel in order, as one text"),
  scenes: z.array(SceneSchema),
  voiceInstructions: z.string().describe("Acting direction for the voices, e.g. Narrator warm and unhurried; Rabbit gentle; Squirrel fast and bubbly"),
  musicDirection: z.string().describe("Mood, tempo and instrumentation of the background music"),
  ending: z.string().describe("How the story resolves"),
  moral: z.string(),
  youtubeTitle: z.string().describe("≤ 90 characters, curiosity-driven, honest"),
  youtubeDescription: z.string(),
  instagramCaption: z.string().describe("Hook line, short body, call to action"),
  hashtags: z.array(z.string()),
});
export type StoryData = z.infer<typeof StorySchema>;

const STOP = new Set("a an the and or but of to in on at for with is are was were be been it its this that his her their they them he she you your our we i my me as by from into who what when how why not no so up out about".split(" "));

/** Normalized bag of content words for near-duplicate detection. */
export function conceptWords(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

export function fingerprint(s: Pick<StoryData, "title" | "premise" | "moral">): string {
  return [...conceptWords(`${s.title} ${s.premise} ${s.moral}`)].sort().join(" ");
}

/** Jaccard similarity between two fingerprints (0..1). */
export function similarity(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Story quality gate: returns problems the LLM must fix, or [] when the draft is usable. */
/** Spoken words above this share of the target make the reel noticeably longer than planned (137 s for a 60 s reel, 2026-11-27). */
export const TOO_LONG = 1.15;

export const spokenWords = (d: StoryData) => d.scenes.flatMap((s) => s.dialogue).reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);

export function storyProblems(d: StoryData, targetWords: number, minScenes = 6): string[] {
  const lines = d.scenes.flatMap((s) => s.dialogue);
  const words = lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
  const problems: string[] = [];
  if (d.scenes.length < minScenes - 1) problems.push(`Only ${d.scenes.length} scenes; write at least ${minScenes} scenes so the story is long enough.`);
  if (words < targetWords * 0.65) problems.push(`Far too short: only ${words} spoken words, but the reel needs about ${targetWords}. Add Narrator lines that tell the story in every scene, 2-3 lines per scene.`);
  if (words > targetWords * TOO_LONG) problems.push(`Too long: ${words} spoken words, but the reel has room for only about ${targetWords}. Shorten the lines.`);
  if (!lines.some((l) => l.speaker.toLowerCase() === "narrator")) problems.push("There are no Narrator lines. The Narrator must carry the story between character lines.");
  const first = d.scenes[0]?.dialogue[0]?.text ?? "";
  if (/^(the scene|scene|we see|in this)/i.test(d.hook.trim()) || d.hook.split(/\s+/).length > 16) problems.push(`The hook "${d.hook}" is a description. Write the literal first spoken sentence (max 12 words) that makes viewers stop scrolling.`);
  if (first && d.hook && !first.toLowerCase().includes(d.hook.toLowerCase().slice(0, 15))) problems.push("Scene 1's first dialogue line must be exactly the hook sentence.");
  return problems;
}
