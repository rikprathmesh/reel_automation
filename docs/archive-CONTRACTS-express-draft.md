# ReelForge AI — Service Contracts

Three independently deployable apps share these contracts:

| App | Folder | Stack | Port |
|---|---|---|---|
| Frontend | `frontend/` | Next.js 16 (App Router), TS, Tailwind v4, shadcn/ui, Framer Motion, React Query, Redux Toolkit | 3000 |
| Backend | `backend/` | Node 22+, TS, Express 5, Prisma 7 + PostgreSQL, BullMQ + Redis, SSE | 4000 |
| Media service | `media-service/` | Python 3.12, FastAPI, FFmpeg, ComfyUI client, faster-whisper, Kokoro / Piper, yt-dlp, Agent Reach | 8000 |

External local services: PostgreSQL, Redis, Ollama (`:11434`), ComfyUI (`:8188`).

**Rules that every app must respect**
1. Nothing is published without an explicit approval recorded in the DB (`Reel.approvedAt` + status `approved|publishing|partially_published`). Rejected reels can never enter the publish queue.
2. No paid API is called unless the operator explicitly enables that provider in env (all paid providers default to off).
3. No fake integrations: if a dependency (ComfyUI, TTS engine, Ollama…) is unavailable, the operation fails with a clear error. Never return placeholder/dummy output as success.
4. Every important operation is written to `AuditLog`.

---

## 1. Storage

All binary artifacts live in a shared storage root addressed by **keys** (POSIX relative paths, e.g. `reels/12/scene_00.png`).

- Backend: `StorageAdapter` interface (`put`, `getStream`, `exists`, `delete`, `localPath?`, `publicUrl`). Only `LocalStorage` ships now; S3 can be added by implementing the interface.
- Media service: reads/writes keys under `STORAGE_ROOT` (same volume mounted in both containers; default `./storage` locally, `/storage` in Docker).
- Library assets: `library/music/*` and `library/sfx/*` (keywords in filenames, optional `library.json` `{ "file.mp3": "tags" }`).

Key layout: `references/{refId}/…`, `characters/{charId}/sheet_{ts}.png`, `reels/{reelId}/…`, `work/{anything}/…` (scratch, deletable).

---

## 2. Media service HTTP API (`MEDIA_SERVICE_URL`, default `http://localhost:8000`)

JSON in / JSON out. Errors: non-2xx with `{ "detail": "human readable message" }`. Long operations are synchronous (backend uses up to 30 min timeouts). Optional shared secret: header `X-Media-Token` must equal `MEDIA_SERVICE_TOKEN` when that env is set.

### `GET /health`
```json
{
  "ffmpeg": true,
  "ytdlp": true,
  "agent_reach": false,
  "comfyui": { "ok": true, "url": "http://comfyui:8188", "detail": "…" , "workflows": ["txt2img", "txt2img_ref", "img2vid"] },
  "tts": { "kokoro": true, "piper": false, "default_engine": "kokoro" },
  "whisper": { "ok": true, "model": "small" }
}
```

### `GET /voices`
`[{ "engine": "kokoro", "id": "af_heart", "name": "Heart (US female)", "language": "en-us" }, …]`

### `POST /reference/ingest`
Req `{ "url": str, "work_key": "references/7", "max_frames": 10 }`
Res
```json
{
  "metadata": { "title": str|null, "uploader": str|null, "duration": float|null, "view_count": int|null, "like_count": int|null, "comment_count": int|null, "description": str|null, "tags": [str] },
  "agent_reach_text": str|null,
  "transcript": str|null,
  "transcript_source": "subtitles"|"whisper"|null,
  "duration": float|null,
  "cuts": [float],
  "frames": ["references/7/frame_00.jpg", …],
  "video_downloaded": bool,
  "warnings": [str]
}
```
Fails (422) only if metadata, Agent Reach and download all fail.

### `POST /tts`
Req `{ "text": str, "engine": "kokoro"|"piper"|null, "voice": str|null, "speed": float (default 1.0), "out_key": "reels/12/voice_00_0" }` (extension added by service)
Res `{ "key": "reels/12/voice_00_0.wav", "duration": float, "engine": "kokoro", "voice": "af_heart", "words": [{ "word": str, "start": float, "end": float }] }`
Word timings come from faster-whisper word-level alignment of the generated audio.

### `POST /image`
Req `{ "prompt": str, "negative_prompt": str|null, "reference_keys": [str], "seed": int, "width": int, "height": int, "out_key": "reels/12/scene_00.png" }`
Res `{ "key": str, "workflow": "txt2img"|"txt2img_ref" }`
Uses ComfyUI workflow templates in `media-service/workflows/*.json` (API format). When `reference_keys` is non-empty and `txt2img_ref` exists (IPAdapter / reference conditioning), refs are uploaded to ComfyUI and that workflow is used.

### `POST /animate`
Req `{ "image_key": str, "duration": float, "camera": "zoom_in"|"zoom_out"|"pan_left"|"pan_right"|"pan_up"|"pan_down"|"static", "prompt": str, "mode": "kenburns"|"comfyui", "out_key": "work/reel-12/clip_00.mp4" }`
Res `{ "key": str, "mode": "kenburns"|"comfyui" }` — output is always 1080x1920, 30 fps, H.264, no audio, exactly `duration` seconds. `comfyui` mode uses the `img2vid` workflow and falls back to `kenburns` only if `mode` was `comfyui` and the workflow is missing (reported in `mode`).

### `POST /library/pick`
Req `{ "kind": "music"|"sfx", "query": str, "salt": str }` → Res `{ "key": str|null }` (null = nothing suitable; sfx requires a keyword match).

### `POST /compose`
Req
```json
{
  "work_key": "work/reel-12",
  "scenes": [{ "clip_key": str, "duration": float, "start": float, "transition": "fade|fadeblack|slideleft|slideup|wipeleft|circleopen|dissolve|smoothup", "transition_sec": float, "on_screen_text": str, "sfx_key": str|null }],
  "voices": [{ "key": str, "start": float, "duration": float, "words": [{ "word": str, "start": float, "end": float }] }],
  "music_key": str|null,
  "whoosh_key": str|null,
  "end_card": str,
  "total_sec": float,
  "out_key": "reels/12/reel.mp4"
}
```
Res `{ "key": str, "duration": float }` — xfade transitions, voice placement, SFX, music ducked under voice (sidechain), loudnorm −14 LUFS, burned word-highlight ASS captions, overlays, end card; H.264 high / AAC 192k / faststart.

### `POST /thumbnail`
Req `{ "image_key": str, "text": str, "out_key": str }` → Res `{ "key": str }`

### `POST /probe`
Req `{ "key": str }` → Res `{ "duration": float }`

---

## 3. Backend REST API (`/api`, JSON, camelCase)

Auth: if `ADMIN_TOKEN` is set, every `/api/*` (except `/api/session`, `/api/login`), `/media/*` and `/oauth/*` route requires the `rf_session` cookie (set by `POST /api/login {token}`) or `Authorization: Bearer <ADMIN_TOKEN>`. 401 → `{ error }`.
Errors: `{ "error": "message" }` with 400/404/409/500.
Media files: `GET /media/{key}` (the backend streams from storage). API objects expose ready-made `…Url` fields.

The frontend reaches the backend through Next.js rewrites (`/api/*`, `/media/*`, `/oauth/*` → `BACKEND_URL`), so everything is same-origin.

### Types
```ts
type ReelStatus = "queued"|"generating"|"ready"|"approved"|"rejected"|"publishing"|"published"|"partially_published"|"failed";
type Platform = "youtube"|"instagram";
type PublicationStatus = "pending"|"scheduled"|"uploading"|"published"|"failed"|"cancelled";

interface DialogueLine { speaker: string; text: string; emotion: string }
interface Scene { index: number; narrative: string; visualPrompt: string; characters: string[]; location: string;
  camera: "zoom_in"|"zoom_out"|"pan_left"|"pan_right"|"pan_up"|"pan_down"|"static";
  dialogue: DialogueLine[]; onScreenText: string; sfx: string; transition: string; minDurationSec: number }
interface Script { title: string; hookLine: string; synopsis: string; musicMood: string; scenes: Scene[]; endCardText: string }
interface PublishMetadata { youtube: { title: string; description: string; tags: string[] }; instagram: { caption: string; hashtags: string[] }; thumbnailText: string }

interface Reel { id: number; ideaId: number|null; batch: string|null; status: ReelStatus; stage: string|null; progress: number;
  title: string|null; script: Script|null; metadata: PublishMetadata|null; videoUrl: string|null; thumbnailUrl: string|null;
  durationSec: number|null; error: string|null; feedback: string|null; usage: Record<string, unknown>|null;
  createdAt: string; updatedAt: string; approvedAt: string|null; rejectedAt: string|null }
interface ReelDetail extends Reel { assets: { kind: string; url: string; meta: Record<string, unknown>|null }[];
  publications: Publication[]; activity: AuditEntry[]; idea: Idea|null }
interface Publication { id: number; reelId: number; platform: Platform; status: PublicationStatus; scheduledFor: string|null;
  remoteId: string|null; remoteUrl: string|null; error: string|null; attempts: number; createdAt: string; publishedAt: string|null }
interface PublicationRow extends Publication { reelTitle: string|null; thumbnailUrl: string|null;
  stats: { views: number|null; likes: number|null; comments: number|null; shares: number|null; saves: number|null; reach: number|null; capturedAt: string }|null }
interface AuditEntry { id: number; entityType: string; entityId: number|null; action: string; level: "info"|"warn"|"error"; message: string; createdAt: string }
interface Character { id: number; name: string; role: "protagonist"|"supporting"|"narrator"; visualDescription: string; personality: string;
  voiceEngine: string|null; voiceId: string|null; voiceStyle: string|null; referenceUrl: string|null; seed: number; active: boolean }
interface ReferenceAnalysis { summary: string; format: string; niche: string; hook: { text: string; technique: string; secondsToHook: number };
  structure: { beat: string; purpose: string; approxSeconds: number }[]; pacing: { cutsPerMinute: number; averageShotSeconds: number; energy: string };
  visualStyle: { artStyle: string; palette: string[]; cameraWork: string; textOverlays: string };
  audioStyle: { voiceover: string; music: string; soundEffects: string }; storytellingTechniques: string[]; emotionalArc: string;
  retentionTactics: string[]; callToAction: string; whyItWorks: string; doNotCopy: string[] }
interface Reference { id: number; url: string; platform: string; status: "queued"|"analyzing"|"analyzed"|"failed"; title: string|null; author: string|null;
  durationSec: number|null; metadata: Record<string, unknown>|null; transcript: string|null; analysis: ReferenceAnalysis|null; notes: string|null; error: string|null; createdAt: string }
interface Idea { title: string; logline: string; hook: string; premise: string; twist: string; emotionalCore: string; characters: string[]; setting: string;
  borrowedTechniques: string[]; originalityNote: string; estimatedDurationSec: number; tags: string[] }
interface IdeaRow { id: number; referenceId: number|null; title: string; logline: string; hook: string; status: "new"|"used"|"discarded"; data: Idea; createdAt: string }
interface ChannelBible { channelName: string; niche: string; audience: string; language: string; tone: string; artStyle: string; colorPalette: string;
  recurringThemes: string[]; forbiddenTopics: string[]; targetDurationSec: number; callToAction: string; defaultHashtags: string[] }
interface VoiceSetting { engine: string|null; voiceId: string|null; style: string|null }
interface Settings { bible: ChannelBible; automation: { enabled: boolean; reelsPerDay: number; dailyCron: string };
  voices: Record<string, VoiceSetting>; youtubePrivacy: "public"|"unlisted"|"private"; defaultPlatforms: Platform[] }
interface Voice { engine: string; id: string; name: string; language: string }
interface Health { llm: { provider: string; model: string; ok: boolean; detail: string }; media: MediaHealth|null; mediaError: string|null;
  redis: boolean; database: boolean; providers: { llm: string; image: string; video: string; tts: string };
  youtube: { configured: boolean; connected: boolean; accountName: string|null };
  instagram: { oauthConfigured: boolean; connected: boolean; accountName: string|null; expiresAt: string|null };
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
  automation: { enabled: boolean; reelsPerDay: number; dailyCron: string; timezone: string; today: string } }
// MediaHealth = the media service /health payload, passed through unchanged.
```

### Endpoints
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/session` | — | `{ authed, authRequired }` |
| POST | `/api/login` | `{ token }` | `{ ok }` + cookie |
| GET | `/api/health` | — | `Health` |
| GET | `/api/events` | — | **SSE** stream (see §4) |
| GET / PUT | `/api/settings` | partial `Settings` | `Settings` / `{ ok }` |
| GET | `/api/references` | — | `Reference[]` |
| POST | `/api/references` | `{ urls: string[], notes?: string }` | `{ ids }` (201) |
| PATCH | `/api/references/:id` | `{ notes }` | `{ ok }` |
| POST | `/api/references/:id/analyze` | — | `{ ok }` |
| DELETE | `/api/references/:id` | — | `{ ok }` |
| GET | `/api/ideas?status=new\|used\|discarded` | — | `IdeaRow[]` |
| POST | `/api/ideas/generate` | `{ count?: number, referenceIds?: number[] }` | `{ ok }` (202) |
| PATCH | `/api/ideas/:id` | `{ status: "new"\|"discarded" }` | `{ ok }` |
| POST | `/api/ideas/:id/produce` | — | `{ reelId }` (201) |
| GET | `/api/characters` | — | `Character[]` |
| POST | `/api/characters` | `{ name, role, visualDescription, personality, voiceEngine, voiceId, voiceStyle, active }` | `{ id }` (201) |
| PUT | `/api/characters/:id` | same | `{ ok }` |
| POST | `/api/characters/:id/sheet` | — | `{ ok }` (202) |
| DELETE | `/api/characters/:id` | — | `{ ok }` (deactivates) |
| POST | `/api/characters/suggest` | `{ count }` | `Omit<Character,"id"\|"referenceUrl"\|"seed"\|"active"\|"voiceEngine"\|"voiceId">[]` |
| GET | `/api/voices` | — | `Voice[]` |
| GET | `/api/reels?status=a,b` | — | `Reel[]` |
| GET | `/api/reels/:id` | — | `ReelDetail` |
| POST | `/api/reels/generate` | `{ count }` | `{ ids }` (201) |
| POST | `/api/automation/run-now` | — | `{ ids }` |
| PATCH | `/api/reels/:id/metadata` | `{ metadata: PublishMetadata }` | `{ ok }` |
| POST | `/api/reels/:id/approve` | `{ platforms: Platform[], scheduledFor: ISOString\|null }` | `{ ok }` |
| POST | `/api/reels/:id/unapprove` | — | `{ ok, cancelled }` |
| POST | `/api/reels/:id/reject` | `{ feedback, regenerate }` | `{ ok, newReelId? }` |
| POST | `/api/reels/:id/retry` | `{ rewriteScript }` | `{ ok }` |
| DELETE | `/api/reels/:id` | — | `{ ok }` |
| GET | `/api/publications` | — | `PublicationRow[]` |
| POST | `/api/publications/:id/retry` | — | `{ ok }` |
| GET | `/api/analytics/summary` | — | `{ totals: {platform,posts,views,likes,comments}[], daily: {day,produced,approved,published}[], pipeline: {status,n}[], top: {id,platform,remoteUrl,title,views,likes,comments}[] }` |
| POST | `/api/analytics/refresh` | — | `{ ok }` (202) |
| POST | `/api/connections/instagram/manual` | `{ accessToken, igUserId? }` | instagram status |
| DELETE | `/api/connections/:platform` | — | `{ ok }` |
| GET | `/api/activity?limit=` | — | `AuditEntry[]` |
| GET | `/api/jobs` | — | `{ id, queue, name, status, attempts, error, entityType, entityId, createdAt, finishedAt }[]` |
| GET | `/oauth/youtube/start`, `/oauth/instagram/start` | — | 302 to provider; callback 302 → `FRONTEND_URL/settings?connected=<platform>[&error=]` |

## 4. Server-Sent Events (`GET /api/events`)

`text/event-stream`, heartbeat comment every 20 s. Each message: `event: <type>` + `data: <json>`.

| event | data |
|---|---|
| `reel` | `{ id, status, stage, progress, error }` |
| `reference` | `{ id, status, error }` |
| `idea` | `{ ids: number[] }` (new ideas created) |
| `character` | `{ id }` (sheet regenerated) |
| `publication` | `{ id, reelId, platform, status, remoteUrl, error }` |
| `activity` | `AuditEntry` |

Clients should treat events as invalidation signals (React Query `invalidateQueries`) and may patch caches optimistically with `reel` progress.
