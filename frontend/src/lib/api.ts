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

export interface HealthCheck { ok: boolean; detail: string; latencyMs: number }
export interface Health {
  status: "ok" | "degraded";
  checks: { database: HealthCheck; redis: HealthCheck; llm: HealthCheck; media: HealthCheck; reference: HealthCheck };
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
};
export const LANGUAGE_LABELS: Record<string, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish" };

export interface VoiceProfile {
  id: string; name: string; engine: "kokoro" | "piper"; voiceId: string; language: "en" | "hi" | "hinglish";
  speed: number; style: string; isNarrator: boolean; characters?: { id: string; name: string }[];
}
export interface CharacterImage { id: string; kind: string; isPrimary: boolean; url: string; createdAt: string }
export interface Character {
  id: string; name: string; description: string; appearance: string; furColors: string; clothingColors: string;
  personality: string; basePrompt: string; negativePrompt: string; seed: number; expressionPresets: Record<string, string>;
  isStoryteller: boolean; active: boolean; voiceProfileId: string | null; voiceProfile: VoiceProfile | null;
  images: CharacterImage[]; primaryImageUrl: string | null; sceneCount: number;
}
export type CharacterInput = Omit<Character, "id" | "seed" | "voiceProfile" | "images" | "primaryImageUrl" | "sceneCount">;

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
  hook: string; moral: string; status: string; createdAt: string; _count?: { scripts: number; projects: number };
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

export interface GenerationSettings { language: "en" | "hi" | "hinglish"; minDurationSec: number; maxDurationSec: number; defaultPlatforms: ("youtube" | "instagram")[]; youtubePrivacy: "private" | "unlisted" | "public" }
export interface DailySchedule { id: string; enabled: boolean; targetCount: number; startTime: string; timezone: string; categories: string[]; language: "en" | "hi" | "hinglish"; maxConcurrency: number }
export interface SettingsPayload { generation: GenerationSettings; schedule: DailySchedule; output: { width: number; height: number; aspect: string; fps: number; videoCodec: string; audioCodec: string; container: string }; categories: string[] }

/* ---------------------------- review & publishing ---------------------------- */

export type Platform = "youtube" | "instagram";
export interface ReviewScene { index: number; description: string; dialogue: { speaker: string; text: string; emotion: string }[]; onScreenText: string }
export interface ReviewVersion {
  id: string; projectId: string; versionNo: number; status: string; durationSec: number | null; createdAt: string;
  videoUrl: string | null; thumbnailUrl: string | null;
  validation: { ok: boolean; problems: string[]; width: number; height: number; fps: number } | null;
  script: { id: string; version: number; narration: string; youtubeTitle: string; youtubeDescription: string; instagramCaption: string; hashtags: string[]; musicDirection: string; scenes: ReviewScene[] };
  project: { id: string; status: string; targetPlatforms: Platform[]; story: Story };
  approvals: { decision: string; decidedAt: string; notes: string | null; platforms: Platform[]; user: { displayName: string } }[];
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
