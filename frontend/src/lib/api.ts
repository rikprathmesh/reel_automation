/**
 * Typed client for the ReelForge backend. All calls go through the Next.js rewrite (/api → backend),
 * so the httpOnly session cookie is sent automatically and never touched by page scripts.
 */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the backend. Is it running on port 4000?");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error
      ?? (res.status >= 500 ? "The backend isn't responding (is it running on port 4000?)" : res.statusText);
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T,>(p: string) => request<T>("GET", p),
  post: <T,>(p: string, b: unknown = {}) => request<T>("POST", p, b),
  put: <T,>(p: string, b: unknown) => request<T>("PUT", p, b),
  patch: <T,>(p: string, b: unknown) => request<T>("PATCH", p, b),
  del: <T,>(p: string) => request<T>("DELETE", p),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* -------------------------------- types -------------------------------- */

export type Role = "owner" | "editor" | "viewer";
export interface SessionUser { id: string; email: string; role: Role; displayName: string }

export interface HealthCheck { ok: boolean; detail: string; latencyMs: number; /** running but slow (CPU busy with AI work) */ busy?: boolean }
export interface Health {
  status: "ok" | "degraded";
  checks: { database: HealthCheck; redis: HealthCheck; llm: HealthCheck; comfyui: HealthCheck; media: HealthCheck; reference: HealthCheck };
  time: string;
}

export interface ActivityEntry {
  id: string;
  entityType: string;
  entityId: string | null;
  action: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
  actor?: { displayName: string } | null;
}

/* ------------------------------ formatting ------------------------------ */

export function ago(ts: string | null | undefined): string {
  if (!ts) return "—";
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Multipart upload (file + fields) through the same-origin proxy. */
export async function upload<T>(path: string, file: File, fields: Record<string, string | undefined> = {}): Promise<T> {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") fd.append(k, v);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: "POST", body: fd, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "Can't reach the backend. Is it running on port 4000?");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? res.statusText);
  return data as T;
}

/* ---------------------------- domain types ---------------------------- */

export const CATEGORY_LABELS: Record<string, string> = {
  kids_moral: "Kids' moral stories",
  emotional: "Emotional storytelling",
  motivation: "Motivation & life lessons",
  rabbit_squirrel_adventure: "Rabbit & squirrel adventures",
  friendship_kindness: "Friendship & kindness",
  family: "Family relationships",
  funny_animals: "Funny animal stories",
  inspirational: "Short inspirational stories",
  panchatantra: "Panchatantra stories",
  educational: "Educational storytelling",
  travel_exploration: "Travel & exploration",
  historical: "Historical storytelling",
  mahabharat: "Mahabharat (kids)",
  ramayan: "Ramayan (kids)",
  hanuman: "Lord Hanuman",
  krishna: "Lord Krishna",
  shivaji_maharaj: "Chhatrapati Shivaji Maharaj (kids)",
};
/** These categories use their own cast (Krishna, Shri Ram, Shivaji Maharaj…), not Rabbit & Squirrel. */
export const EPIC_CATEGORIES = ["mahabharat", "ramayan", "hanuman", "krishna", "shivaji_maharaj"];
/** Retellings of scripture / history / fables: the AI keeps source details and designs their own characters. */
export const SOURCE_CATEGORIES = ["panchatantra", "historical", "mahabharat", "ramayan", "hanuman", "krishna", "shivaji_maharaj"];
export type AgeGroup = "age_1_3" | "age_4_6" | "age_7_10" | "general";
export const AGE_GROUP_LABELS: Record<AgeGroup, string> = { age_1_3: "1-3 years", age_4_6: "4-6 years", age_7_10: "7-10 years", general: "General audience" };
export type StorySource = "generated" | "idea" | "full_story" | "continuation";
export const STORY_SOURCE_LABELS: Record<StorySource, string> = { generated: "AI story", idea: "My idea", full_story: "My full story", continuation: "Next episode" };
export const LANGUAGE_LABELS: Record<string, string> = { hi: "Hindi", en: "English", hinglish: "Hinglish" };

/** Reel lengths in seconds: at least 1 minute, up to 3 minutes (the Shorts / Reels maximum). */
export type LengthSec = 60 | 120 | 180;
export const LENGTH_OPTIONS: { value: LengthSec; label: string }[] = [
  { value: 60, label: "1 min" }, { value: 120, label: "2 min" }, { value: 180, label: "3 min (long)" },
];

/** Visual styles (one per reel). Mirrors backend/src/common/styles.ts; swatches are the style's palette. */
export type StyleId = "storybook" | "shadow_puppet" | "folk_poster" | "chibi" | "painterly" | "pinman";
export const STYLE_OPTIONS: { id: StyleId; label: string; bestFor: string; swatches: string[] }[] = [
  { id: "storybook", label: "3D Cartoon", bestFor: "Kids' stories, animals, Mahabharat, Ramayan, Shivaji Maharaj", swatches: ["#F4C27A", "#8FC9A8", "#6FA8DC", "#E58E73"] },
  { id: "shadow_puppet", label: "Shadow Puppet", bestFor: "Night, battle, confrontation, a vow", swatches: ["#160D06", "#5E2C10", "#EC9F3E", "#FFD98C"] },
  { id: "folk_poster", label: "Folk Poster", bestFor: "A court, throne, blessing, arrival", swatches: ["#E8D5A0", "#C0392B", "#1E7A4C", "#E8B23A", "#1B6FA8"] },
  { id: "chibi", label: "Chibi", bestFor: "Childhood, play, family feed", swatches: ["#79CBD8", "#8FD079", "#F6A0C0", "#FFF6E2"] },
  { id: "painterly", label: "Painterly", bestFor: "Flight, sunrise, a journey, awe", swatches: ["#0C1132", "#7A3D62", "#CE7340", "#F7C169"] },
  { id: "pinman", label: "Pinman", bestFor: "A moral, an idea, a contrast", swatches: ["#FBFAF6", "#141019", "#E82420"] },
];
export const STYLE_LABELS: Record<string, string> = Object.fromEntries(STYLE_OPTIONS.map((s) => [s.id, s.label]));

export interface VoiceProfile {
  id: string; name: string; engine: "kokoro" | "piper"; voiceId: string; language: "en" | "hi" | "hinglish";
  speed: number; style: string; isNarrator: boolean; characters?: { id: string; name: string }[];
}
export interface CharacterImage { id: string; kind: string; isPrimary: boolean; url: string; createdAt: string }
export interface Character {
  id: string; name: string; description: string; appearance: string; furColors: string; clothingColors: string;
  personality: string; basePrompt: string; negativePrompt: string; seed: number; expressionPresets: Record<string, string>;
  isStoryteller: boolean; active: boolean; voiceProfileId: string | null; voiceProfile: VoiceProfile | null;
  /** voice for Hindi stories */
  hindiVoiceProfileId: string | null; hindiVoiceProfile: VoiceProfile | null;
  /** story categories this character belongs to; empty = the general kids' cast */
  categories: string[];
  images: CharacterImage[]; primaryImageUrl: string | null; sceneCount: number;
}
export type CharacterInput = Omit<Character, "id" | "seed" | "voiceProfile" | "hindiVoiceProfile" | "images" | "primaryImageUrl" | "sceneCount">;

export type ReferenceStatus = "queued" | "extracting" | "extracted" | "analyzing" | "analyzed" | "needs_upload" | "failed";
export interface ReferenceAnalysis {
  summary: string; hook: Record<string, unknown>; structure: unknown; pacing: Record<string, unknown>; transitions: unknown;
  visualStyle: Record<string, unknown>; characterTraits: unknown; narration: Record<string, unknown>; emotionalArc: string;
  retentionTactics: string[]; doNotCopy: string[]; model: string;
}
export interface Reference {
  id: string; url: string | null; platform: string; source: "url" | "upload"; status: ReferenceStatus; category: string | null;
  title: string | null; author: string | null; caption: string | null; transcript: string | null; durationSec: number | null;
  extractor: string | null; error: string | null; thumbnailUrl: string | null; videoUrl?: string | null; createdAt: string;
  metadata: Record<string, unknown> | null; analysis: (Partial<ReferenceAnalysis> & { summary: string }) | null;
  storyCount?: number; stories?: { id: string; title: string; createdAt: string }[];
}

export interface Story {
  id: string; title: string; category: string; language: string; targetAudience: string; emotionalObjective: string;
  hook: string; moral: string; status: string; style: string; createdAt: string; _count?: { scripts: number; projects: number };
  ageGroup?: AgeGroup; sourceMode?: StorySource; episodeNo?: number; parentStoryId?: string | null;
}
export interface ProjectSummary {
  id: string; status: string; createdAt: string; targetPlatforms: string[];
  story: { id: string; title: string; category: string; language: string };
  latestVersion: { id: string; versionNo: number; status: string; durationSec: number | null; videoUrl: string | null; thumbnailUrl: string | null; createdAt: string } | null;
  latestJob: GenerationJob | null;
}
export interface GenerationJob {
  id: string; projectId: string; bullJobId: string; stage: string; status: string; progress: number; attempt: number;
  maxAttempts: number; error: { message: string } | null; startedAt: string | null; completedAt: string | null; createdAt: string;
  project?: { id: string; story: { title: string } };
}
export interface Stats { total: number; awaitingReview: number; approved: number; rejected: number; published: number; generating: number; failedJobs: number }

export interface ProviderOption { id: string; label: string; capability: string; paid: boolean; local: boolean; health: { ok: boolean; detail: string } }
export interface Integration { capability: string; selected: string; options: ProviderOption[] }

export interface GenerationSettings { language: "en" | "hi" | "hinglish"; durationSec: LengthSec; defaultPlatforms: ("youtube" | "instagram")[]; youtubePrivacy: "private" | "unlisted" | "public"; style: StyleId; ageGroup: AgeGroup; sceneSec: number; autoPrompts: boolean }
export interface DailySchedule { id: string; enabled: boolean; targetCount: number; startTime: string; timezone: string; categories: string[]; language: "en" | "hi" | "hinglish"; targetDurationSec: LengthSec; maxConcurrency: number }
export interface SettingsPayload { generation: GenerationSettings; schedule: DailySchedule; output: { width: number; height: number; aspect: string; fps: number; videoCodec: string; audioCodec: string; container: string }; categories: string[] }

/* ---------------------------- review & publishing ---------------------------- */

export type Platform = "youtube" | "instagram";
export interface ReviewScene { id: string; title?: string; index: number; description: string; dialogue: { speaker: string; text: string; emotion: string }[]; onScreenText: string }
export interface ReviewVersion {
  id: string; projectId: string; versionNo: number; status: string; durationSec: number | null; createdAt: string;
  videoUrl: string | null; thumbnailUrl: string | null;
  validation: { ok: boolean; problems: string[]; width: number; height: number; fps: number; warnings?: string[]; animation?: { provider: string; label: string; isAiAnimation: boolean; structuredPrompts: number; scenes: number } } | null;
  script: { id: string; version: number; narration: string; youtubeTitle: string; youtubeDescription: string; instagramCaption: string; hashtags: string[]; musicDirection: string; scenes: ReviewScene[] };
  project: { id: string; status: string; targetPlatforms: Platform[]; story: Story };
  approvals: { decision: string; decidedAt: string; notes: string | null; platforms: Platform[]; user: { displayName: string } }[];
  sceneJobs?: SceneJob[];
  timings?: RenderTimings | null;
  publishingJobs: { id: string; platform: Platform; status: string; scheduledFor: string | null; published: { url: string | null } | null }[];
}
export interface PublishingJobRow {
  id: string; platform: Platform; status: string; scheduledFor: string | null; attempts: number; createdAt: string; updatedAt: string;
  lastError: Record<string, unknown> | null; storyTitle: string; category: string; versionNo: number; projectId: string; thumbnailUrl: string | null;
  approval: { decidedAt: string; user: { displayName: string } };
  published: { url: string | null; remoteId: string; publishedAt: string; analytics: { views: number | null; likes: number | null; comments: number | null }[] } | null;
}
export interface AccountsPayload {
  youtube: { oauthConfigured: boolean; account: { accountName: string; status: string; expiresAt: string | null } | null };
  instagram: { oauthConfigured: boolean; account: { accountName: string; status: string; expiresAt: string | null } | null };
}
export interface AnalyticsRow { id: string; platform: Platform; url: string | null; publishedAt: string; title: string; category: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; history: { at: string; views: number | null }[] }
export interface AnalyticsPayload {
  totals: { published: number; youtube: { videos: number; views: number; likes: number; comments: number }; instagram: { videos: number; views: number; likes: number; comments: number } };
  top: AnalyticsRow[]; rows: AnalyticsRow[];
}
export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : Intl.NumberFormat(undefined, { notation: "compact" }).format(n));

/* ------------------------------- prompt studio ------------------------------- */

export interface PromptCheck { id: string; label: string; ok: boolean; severity: "error" | "warn"; weight: number; detail: string }
export interface PromptEvaluation { score: number; checks: PromptCheck[]; fixes: string[]; notes: string[] }
export interface RenderedPrompt { positive: string; negative: string; params: Record<string, unknown>; dropped: string[]; routed: string[] }
export interface CharacterBeat { name: string; action: string; movements: string[]; interaction: string; startPosition: string; endPosition: string; expression: string; eyes: string; mouth: string; head: string }
export interface SceneDraft {
  keyMoment: string;
  environment: { location: string; background: string; timeOfDay: string; weather: string; objects: string[]; details: string[] };
  characters: CharacterBeat[];
  camera: { shot: string; angle: string; movement: string; movementDetail: string; focus: string };
  visual: { lighting: string; atmosphere: string; colorGrade: string; effects: string[] };
  audio: { sfx: string[]; ambience: string };
  continuity: { fromPrevious: string; toNext: string; props: string };
}
export interface ScenePromptSpec extends Omit<SceneDraft, "characters" | "audio"> {
  sceneIndex: number; sceneTitle: string; description: string; durationSec: number;
  style: { id: string; label: string };
  characters: { id: string; name: string; identity: string; referenceUrl: string | null; voice: string | null; beat: CharacterBeat }[];
  audio: SceneDraft["audio"] & { dialogue: { speaker: string; text: string; emotion: string }[]; lipSync: boolean };
  negative: string[];
  override?: { positive?: string; negative?: string };
}
export interface ScenePrompt {
  id: string; version: number; targetModel: string; origin: string; positive: string; negative: string; dropped: string[];
  params: (Record<string, unknown> & { routed?: string[] }) | null; evaluation: PromptEvaluation | null; score: number | null;
  spec: ScenePromptSpec; createdAt: string; instruction: string | null; model: string | null; keyframe: RenderedPrompt | null;
}
export interface PromptVersionSummary { id: string; version: number; isCurrent: boolean; origin: string; targetModel: string; score: number | null; createdAt: string; instruction: string | null }
export interface PromptStudioScene {
  id: string; index: number; title: string; description: string; location: string; events: number[]; durationHint: number;
  dialogue: { speaker: string; text: string; emotion: string }[];
  characters: { id: string; name: string; imageUrl: string | null }[];
  prompt: ScenePrompt | null; history: PromptVersionSummary[];
}
export interface StoryBible {
  title: string; logline: string; sourceType: string; sourceNotes: string;
  characters: { name: string; role: string; species: string; personality: string; appearance: string; relationships: { to: string; relation: string }[] }[];
  locations: { name: string; description: string; timeOfDay: string; visualDetails: string[] }[];
  objects: { name: string; description: string; importance: string }[];
  events: { order: number; summary: string; location: string; characters: string[]; emotion: string }[];
  conflicts: string[]; emotions: string[]; dialogueHints: string[]; moral: string; beginning: string; middle: string; ending: string;
}
export interface PromptStudioCharacter {
  id: string; name: string; species: string; personality: string; identity: string; imageUrl: string | null;
  visualProfile: Record<string, unknown> | null;
  referencePrompts: { id: string; view: string; positive: string; negative: string; version: number }[];
}
export interface PromptStudioPayload {
  story: Story & { understanding: StoryBible | null; sourceText: string | null };
  script: { id: string; version: number; narration: string } | null;
  scenes: PromptStudioScene[];
  characters: PromptStudioCharacter[];
  pending: { id: string; name: string; state: string; sceneId?: string; characterId?: string }[];
}
export interface ModelCaps {
  id: string; label: string; output: "image" | "video"; isAiAnimation: boolean; textToVideo: boolean; imageToVideo: boolean;
  referenceImages: string; firstFrame: boolean; lastFrame: boolean; camera: string; negativePrompt: boolean; maxPromptWords: number;
  maxClipSec: number; fps: number; resolution: string; audio: boolean; lipSync: boolean; requiresGpu: boolean; license: string; notes: string; installed: boolean;
}
export interface PromptTemplate { id: string; name: string; targetModel: string; notes: string; updatedAt: string }

/** The parts of a spec the director can edit (identity, style and dialogue stay locked). */
export function draftOf(spec: ScenePromptSpec): SceneDraft {
  return {
    keyMoment: spec.keyMoment, environment: spec.environment, characters: spec.characters.map((c) => c.beat), camera: spec.camera,
    visual: spec.visual, audio: { sfx: spec.audio.sfx, ambience: spec.audio.ambience }, continuity: spec.continuity,
  };
}

/** One scene of one render (async pipeline). */
export interface SceneJob {
  sceneId: string; index: number; status: "queued" | "active" | "completed" | "failed"; imageUrl: string | null; clipUrl: string | null; reused: boolean;
  timings: { image?: number; voice?: number; clip?: number; total?: number } | null; error: { message: string } | null;
}
export interface RenderTimings { produceSec?: number; sceneCount?: number; reused?: number; scenesWorkSec?: number; merge?: { clipsSec: number; renderSec: number; totalSec: number }; wallSec?: number }

/* ------------------------------- Google Flow ------------------------------- */

export interface FlowPack {
  story: { id: string; title: string; language: string; style: string };
  model: ModelCaps;
  characters: { id: string; name: string; identity: string; imageUrl: string | null; flowPrompt: string }[];
  scenes: {
    id: string; index: number; title: string; description: string; durationHint: number; characterIds: string[];
    dialogue: { speaker: string; text: string; emotion: string }[];
    veoPrompt: string | null; notes: string[];
    clip: { url: string; duration: number | null; hasAudio: boolean | null; uploadedAt: string } | null;
  }[];
  clipsUploaded: number;
}
