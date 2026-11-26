/**
 * Reel lengths. Every reel is at least one minute; "long" is up to three minutes (the YouTube Shorts and
 * Instagram Reels limit). Scenes default to about 8 seconds (one animated shot each), so longer reels get more scenes.
 * Each scene is rendered separately (about 2-4 minutes per still on this CPU; much longer for real animation).
 */
export const LENGTHS = [60, 120, 180] as const;
export type LengthSec = (typeof LENGTHS)[number];
export const LENGTH_LABELS: Record<LengthSec, string> = { 60: "1 min", 120: "2 min", 180: "3 min (long)" };
export const MIN_REEL_SEC = 60;
export const MAX_REEL_SEC = 180;

export interface StoryPlan {
  targetSec: number;
  /** target length of one scene (one animated shot), seconds */
  sceneSec: number;
  minScenes: number;
  maxScenes: number;
  /** spoken words for the target length at the audience's pace */
  words: number;
  /** spoken lines per scene that fit its length */
  linesPerScene: number;
  /** LLM output budget: Devanagari costs several tokens per word, and each scene carries an English image prompt */
  maxTokens: number;
}

/** Default scene length: a starting point, not a limit (story pacing and the video model decide the actual length). */
export const DEFAULT_SCENE_SEC = 8;

export function storyPlan(targetSec: number | null | undefined, opts: { sceneSec?: number; wordsPerSec?: number } = {}): StoryPlan {
  const t = Math.min(MAX_REEL_SEC, Math.max(MIN_REEL_SEC, Math.round(targetSec ?? MIN_REEL_SEC)));
  const sceneSec = Math.min(20, Math.max(4, opts.sceneSec ?? DEFAULT_SCENE_SEC));
  const wps = opts.wordsPerSec ?? 2.2;
  const minScenes = Math.max(4, Math.round(t / (sceneSec * 1.3)));
  const maxScenes = Math.max(minScenes + 2, Math.round(t / (sceneSec * 0.85)));
  const words = Math.round(t * wps);
  const linesPerScene = Math.max(1, Math.min(4, Math.round((sceneSec * wps) / 9)));
  // capped so prompt + output fit the 16k Ollama context (8 s scenes carry ~2 lines, so ~380 tokens each)
  return { targetSec: t, sceneSec, minScenes, maxScenes, words, linesPerScene, maxTokens: Math.min(12_000, 2000 + maxScenes * 380) };
}

/** Nearest allowed length for a stored/legacy value. */
export function normalizeLength(sec: number | null | undefined): LengthSec {
  const v = sec ?? MIN_REEL_SEC;
  return LENGTHS.reduce((best, l) => (Math.abs(l - v) < Math.abs(best - v) ? l : best), LENGTHS[0]);
}
