# ReelForge AI — Phase 1: Environment Report & Implementation Plan

_Inspected 2026-11-24 on the target machine. Nothing has been downloaded or installed for AI models yet._

---

## 1. What this machine has

| Resource | Found | Impact |
|---|---|---|
| CPU | Intel Core i5-1035G1 (Ice Lake, 15 W laptop), 4 cores / 8 threads | Every AI workload runs on CPU. It will be slow and the laptop will run hot. |
| RAM | 15.7 GB total, **3.4 GB free** at inspection time | We can't hold an LLM, an image model and the dev stack in memory together. Stages must run **one model at a time** and unload between stages. |
| GPU | Intel UHD Graphics (integrated, shares system RAM). **No NVIDIA GPU, no CUDA.** | CUDA-only tools (Stable Video Diffusion, Wan, AnimateDiff, xFormers) can't run. Image generation needs CPU or Intel OpenVINO. |
| Disk | C: 78 GB free · **D: 190 GB free** | Plenty of room. Models go on D:. |
| OS | Windows 11 Pro | |
| Node.js | v24.19 (npm, pnpm) | OK |
| Python | 3.14.7 only | Too new for parts of the AI stack (PyTorch and ComfyUI wheels target 3.10–3.12). **Install Python 3.12 alongside it.** |
| Git | 2.55 | OK |
| Docker | **Not installed** | |
| WSL | **Not installed**; firmware virtualization reports **disabled** | Docker Desktop needs WSL2, and WSL2 needs VT-x turned on in BIOS. |
| PostgreSQL, Redis, Ollama, FFmpeg | Not installed | FFmpeg ships as a bundled binary (already proven). The rest need installing. |

### What this means

1. **Local text-to-video and image-to-video are out of reach on this hardware.** These are generative video models such as SVD, Wan 2.x and LTX-Video. They need an NVIDIA GPU with 8–24 GB of VRAM. As your spec says, we start with **image-based cinematic production**: high-quality stills, Ken Burns camera moves, parallax and layered motion, transitions, word-highlighted subtitles, voice, music and SFX.
2. **Images are the bottleneck.** On this CPU, a quality 9:16 image takes roughly 1–3 minutes with an SD 1.5-class model plus an LCM speed-up LoRA. With SDXL it takes 5–10+ minutes, and SDXL also pushes 16 GB of RAM to its limit.
3. **Five reels a day is feasible only as an overnight batch** (estimate in §6). Expect about 2.5–5 hours of unattended work per day, with the laptop plugged in.

---

## 2. Verified external tools (read from their current docs today)

| Tool | Verdict |
|---|---|
| **Agent Reach** (github.com/Panniantong/Agent-Reach) | **Install:** `uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip`, then `agent-reach setup`. Never install the unrelated PyPI package. **Commands:** `agent-reach version`, `channels`, `read <url>`, `<channel> <action>`, `login <channel>`. Since v1.6, each command prints one JSON object (`ok`, `result`, `error.hint`). No `doctor` command is documented; `agent-reach channels` is the diagnostic. **Instagram** is *experimental* and needs a login. Its documented capabilities are user search, profiles and user posts. **Nothing documents reading a single reel URL.** YouTube can return info, subtitles and search results. Speech-to-text needs a paid Groq or OpenAI key, so we use local faster-whisper instead. Logins live in its own browser profile under `~/.agent-reach/`. No MCP server is documented. |
| **Higgsfield MCP** | A remote MCP endpoint is advertised (`https://mcp.higgsfield.ai/mcp`). Its auth and transport aren't documented on the page, and the page talks about showing "the price before starting", so generation is metered. **Not zero-cost.** It stays an optional adapter that is off by default. |
| **Google Flow / Veo** | flow.google.com shows only a sign-in page, and I found no public Flow API, MCP or export API. Veo 3.1 Preview in the Gemini API was **shut down on 22 Oct 2026**. Its successor (Gemini Omni Flash) and Vertex Veo are paid. **Not zero-cost**, and no integration is planned. |
| **Microsoft Clipchamp** | No public API, SDK or programmatic export is documented; export is a manual UI action. **No integration is possible.** |

**Consequence for your two reference reels:** the pipeline tries Agent Reach first. If `agent-reach channels` shows it can't read a single reel (likely), it moves on to **yt-dlp with your browser cookies**. That is read-only, uses your own logged-in session, and the cookie file never leaves the reference service. If that also fails, the UI shows the exact error and offers **manual upload** (processed with FFmpeg and faster-whisper). A reference is marked *analyzed* only when real content was extracted.

---

## 3. Architecture

```
                         ┌───────────────────────────────┐
 Browser ───────────────▶│ frontend/  Next.js 16 (3000)  │  shadcn/ui · Tailwind · Framer Motion
                         │ React Query (server state)    │  Zustand (UI state)
                         └──────────────┬────────────────┘
                     same-origin rewrites│ /api /media /oauth  + SSE /api/events
                         ┌──────────────▼────────────────┐
                         │ backend/  NestJS (4000)        │  Auth (argon2 + JWT cookie), RBAC
                         │  REST + SSE · Prisma · BullMQ  │  Approval gate · Publishing · Scheduler
                         │  Provider registry (TS ifaces) │  StorageAdapter (Local → S3 later)
                         └───┬──────────┬───────────┬─────┘
                  PostgreSQL │   Redis  │           │ HTTP (typed clients, health checks)
                  ┌──────────▼┐ ┌───────▼─┐  ┌──────▼───────────────┐  ┌────────────────────────┐
                  │ Postgres  │ │ Redis   │  │ media-service/ (8000)│  │ reference-service/(8100)│
                  │ 17        │ │ (BullMQ)│  │ FastAPI · FFmpeg     │  │ FastAPI · Agent Reach  │
                  └───────────┘ └─────────┘  │ Kokoro/Piper · whisper│  │ yt-dlp · upload intake │
                                             │ ComfyUI client        │  │ (isolated cookies)     │
                                             └──────┬────────────────┘  └────────────────────────┘
                                   ┌────────────────┴───────┐
                                   │ Ollama (11434)         │  local LLM + vision
                                   │ ComfyUI (8188)         │  image workflows (CPU / OpenVINO)
                                   └────────────────────────┘
          shared ./storage (keys like reels/<uuid>/v2/reel.mp4) — mounted by backend + both Python services
```

**Why two Python services?** Your spec asks for an independent Agent Reach integration. Keeping it in a separate process also keeps browser sessions and cookies isolated from everything else. The backend only knows its HTTP contract.

**Provider interfaces** (backend, TypeScript): `TextGenerationProvider`, `ImageGenerationProvider`, `VideoGenerationProvider`, `VoiceGenerationProvider`, `TranscriptionProvider`, `ReferenceExtractionProvider`. Each has `health()` and typed errors. An **integration registry** (`IntegrationSetting` rows plus env vars) enables or disables providers without pipeline changes. Paid providers (Claude, Higgsfield…) exist only as adapters and are **disabled by default**. They can't be enabled without an explicit setting change, and that change is recorded in the activity log.

### Infrastructure on this machine (decision needed: Q1)

- **Recommended:** turn on Intel VT-x in BIOS, then install WSL2 and Docker Desktop (free for personal use). Docker runs **only PostgreSQL and Redis**, which are light. Ollama, ComfyUI and the Python services run **natively on Windows**, because Docker on WSL can't use the Intel iGPU and adds memory overhead we can't afford.
- **Fallback (no BIOS change):** the native PostgreSQL 17 Windows installer, plus **Memurai Developer** (a free, Redis-compatible Windows build) for BullMQ.
- `docker-compose.yml` for all services ships either way, for a future GPU machine or server.

---

## 4. Folder structure

```
reel-creator-automation/
├─ frontend/            Next.js app (own package.json, own Dockerfile)
├─ backend/             NestJS app (own package.json, prisma/, Dockerfile)
│  └─ src/modules/      auth, users, references, stories, characters, voices, media-assets,
│                       projects, generation, review(approval), publishing, analytics,
│                       schedule, settings, integrations, activity, events(SSE), storage
├─ media-service/       Python 3.12 FastAPI: TTS, whisper, ComfyUI client, FFmpeg compose/validate
├─ reference-service/   Python 3.12 FastAPI: Agent Reach + yt-dlp + upload intake
├─ storage/             local media (git-ignored); library/music, library/sfx (licensed assets only)
├─ infra/               docker-compose.yml, backup scripts (pg_dump + storage snapshot)
└─ docs/                IMPLEMENTATION_PLAN.md, CONTRACTS.md, per-phase reports
```

### Existing code from earlier in this session (inventoried, nothing deleted)

| Folder | State | Plan |
|---|---|---|
| `backend/` | Express 5 + Prisma 7 + BullMQ. Typechecks and builds. Integer IDs, no auth. | **Port to NestJS.** Pipeline logic, the YouTube/Instagram publishers, the approval guard, the Ollama/Claude providers, the storage adapter and SSE move into Nest modules. The schema gets rebuilt to the §5 design. |
| `frontend/` | Next.js 16 + shadcn scaffold (~45 files) using **Redux**. Unfinished and unverified. | Keep the shadcn setup and components, **replace Redux with Zustand**, and rebuild the pages to the new IA (Review Studio, Content Studio…). |
| `media-service/` | FastAPI modules + ComfyUI workflow templates. **Unverified.** The `.venv` (502 MB, Python 3.14) has faster-whisper, piper, yt-dlp and fastapi. No PyTorch. | Recreate the venv on Python 3.12 and verify each endpoint in Phase 6. Move the reference code to `reference-service/`. |
| `docs/CONTRACTS.md` | Written for the Express design | Gets updated to UUIDs, auth and the new resources in Phase 2. |

---

## 5. Database schema (PostgreSQL + Prisma, UUID PKs, `createdAt`/`updatedAt` everywhere)

| Model | Key fields | Notes |
|---|---|---|
| **User** | email (unique), passwordHash (argon2id), role `owner\|editor\|viewer`, lastLoginAt, deletedAt | Single owner to start, with RBAC ready |
| **ReferenceVideo** | url?, platform, source `url\|upload`, status `queued\|extracting\|extracted\|analyzing\|analyzed\|failed\|needs_upload`, title, author, caption, transcript, durationSec, thumbnailKey, videoKey?, category, extractor (`agent-reach\|yt-dlp\|upload`), error, deletedAt | Never `analyzed` without real extracted content |
| **ReferenceAnalysis** | referenceId (1:1), hook, structure JSON, pacing JSON, transitions JSON, visualStyle, characterTraits, narration/voice, emotionalArc, retentionTactics, doNotCopy[], model, promptVersion | Structured, versioned by model |
| **Story** | title, category (enum), language `en\|hi\|hinglish`, targetAudience, emotionalObjective, hook, moral, conceptFingerprint, status, referenceIds (m2m via StoryReference) | Fingerprint plus embedding text blocks near-duplicate concepts |
| **StoryScript** | storyId, version, narration, musicDirection, voiceInstructions, ytTitle, igCaption, hashtags[], feedback?, isCurrent | Every edit or revision is a new version |
| **StoryScene** | scriptId, index, description, visualPrompt, camera, transition, sfx, onScreenText, dialogue JSON, durationHint | |
| **StorySceneCharacter** | sceneId, characterId, expressionPreset | Ties characters to scenes |
| **Character** | name, description, appearance, furColors, clothingColors, personality, basePrompt, negativePrompt, seed, expressionPresets JSON, voiceProfileId, active, deletedAt | Rabbit and Squirrel seeded |
| **CharacterReferenceImage** | characterId, mediaAssetId, kind `sheet\|pose\|expression\|uploaded`, isPrimary | Used as IP-Adapter references |
| **VoiceProfile** | name, engine `kokoro\|piper`, voiceId, language, speed, pitchHint, style | Narrator + per-character |
| **MediaAsset** | kind (image/audio/video/subtitle/thumbnail/…), storageKey, mime, bytes, sha256, width, height, durationSec, provider, meta JSON, deletedAt | Files on disk/object store, metadata in DB |
| **VideoProject** | storyId, scheduleRunId?, status, category, targetPlatforms[] | One project per reel idea |
| **VideoGenerationJob** | projectId, bullJobId (unique), stage, status, progress %, attempt, maxAttempts, error JSON, startedAt, completedAt | Exactly the tracking fields in your §8 |
| **VideoVersion** | projectId, versionNo, scriptId, videoAssetId, thumbnailAssetId, durationSec, validation JSON, status `rendering\|ready\|approved\|rejected\|changes_requested\|superseded` | Only `ready` after the validation pass |
| **Approval** | versionId, decision `approved\|rejected\|changes_requested`, userId, platforms[], notes, decidedAt | Append-only; the publisher checks this table |
| **PublishingAccount** | platform, accountId, accountName, encryptedTokens (AES-256-GCM), scopes, expiresAt, status | Tokens never reach the frontend |
| **PublishingJob** | versionId, platform, approvalId, status `scheduled\|queued\|uploading\|published\|failed\|cancelled`, scheduledFor, idempotencyKey, attempts, lastError, bullJobId | **Unique (versionId, platform)**, so the same video can't be published twice |
| **PublishedVideo** | publishingJobId (1:1), platform, remoteId (unique per platform), url, publishedAt | |
| **VideoAnalytics** | publishedVideoId, capturedAt, views, likes, comments, shares, saves, reach, raw | Time series |
| **DailySchedule** | enabled, targetCount (5), startTime, timezone, categories[], language, maxConcurrency | Plus **ScheduleRun** (date, planned/produced/failed) |
| **SystemSetting** | key, value JSON, updatedBy | Includes the integration registry |
| **ActivityLog** | actorUserId?, entityType, entityId, action, level, message, data JSON, ip | Every important operation |

**Approval transaction rule:** `approve()` runs in a single `SERIALIZABLE` transaction. It inserts the `Approval` row, sets `VideoVersion.status = approved`, and creates `PublishingJob` rows. The publish worker opens its own transaction, re-reads the latest `Approval` for that exact version and the version status, and takes a row lock (`SELECT … FOR UPDATE`) on the `PublishingJob` before uploading. A rejected version has no valid approval, so it can never pass this check from any endpoint, cron job or worker.

---

## 6. Models, resource use and the five-a-day estimate (CPU-only)

All of these are free and open-source. **None are downloaded until you approve (Q2).** Everything goes on `D:\ai-models`.

| Role | Recommended | Download | RAM in use |
|---|---|---|---|
| Story LLM (EN/HI/Hinglish) | `qwen2.5:7b-instruct` (Q4_K_M) via Ollama — good Hindi and Hinglish | ~4.7 GB | ~6 GB |
| Lighter fallback LLM | `qwen2.5:3b-instruct` | ~1.9 GB | ~3 GB |
| Vision (reference frames) | `qwen2.5vl:3b` via Ollama | ~3.2 GB | ~4.5 GB |
| Image model | ComfyUI + an SD 1.5 3D/cartoon checkpoint (e.g. a "3D animation"-style SD1.5 model, licence-checked) + **LCM-LoRA** (4–8 steps) | ~2.3 GB | ~4–5 GB |
| Character consistency | IP-Adapter Plus (SD 1.5) + CLIP-ViT-H image encoder; fixed seeds and locked base prompts; character sheets | ~2.6 GB | +1.5 GB |
| Optional speed-up | ComfyUI OpenVINO node (Intel iGPU/CPU) — benchmarked before adoption | — | — |
| TTS | **Kokoro-82M** (EN + Hindi voices); **Piper** as the faster fallback | ~0.35 GB + ~60 MB/voice | ~1 GB |
| Transcription / subtitle timing | faster-whisper `small` int8 (alignment); `base` if speed matters | ~0.5 GB | ~1 GB |
| Python runtime for ComfyUI | PyTorch CPU build | ~1 GB | — |
| **Total disk** | | **≈ 16–18 GB** | peak ≈ 7 GB if one model is loaded at a time |

**Estimated time per 45 s reel (8 scenes) on this laptop:**

| Stage | Estimate |
|---|---|
| Story + script + scene breakdown (7B LLM, ~2–3k tokens at ~3–5 tok/s) | 8–15 min |
| 8 scene images at 512×896 + 2× upscale (LCM, IP-Adapter) | 10–25 min |
| Voices (Kokoro) + whisper word alignment | 2–4 min |
| Camera motion clips + composition + subtitles + render + validation (FFmpeg, 1080×1920) | 5–8 min |
| **Total** | **≈ 25–50 min per reel → 5 reels ≈ 2–4 h overnight** |

**Measured 2026-11-24 (qwen2.5:7b-instruct, Q4, CPU):** cold model load 40 s; prompt processing ~17 tok/s; generation **4.1 tok/s**; schema-constrained JSON was valid on the first try. → a 2,000–2,500-token script ≈ 9–11 min, consistent with the estimate above.

**Measured 2026-11-24 (images, DreamShaper 8 + LCM-LoRA, ComfyUI 0.46 on CPU):** ~70 s per sampling step at 768×768 when RAM is available; 6 steps + model load = 619 s for the first image, 4 steps ≈ 5–6 min. Under memory pressure (other heavy apps open, < 1 GB free) a single step rose to 876 s, so **do not run other heavy work while rendering**. Kokoro TTS: ~4 s of speech per line; Whisper `small` word alignment works on CPU. Reference analysis of a 108 s reel (download + cuts + Hindi transcript + vision + 7B analysis): ≈ 15 min.

**Quality ceiling, honestly:** you'll get good stylized 3D-cartoon stills with a consistent rabbit and squirrel (IP-Adapter plus fixed specs), cinematic camera motion, transitions, layered subtitles, natural Kokoro voices and a mixed soundtrack. You will **not** get true character animation (moving mouths and limbs) on this hardware. The zero-cost routes to that later are: (a) a desktop NVIDIA GPU with 12 GB+ VRAM, or (b) running ComfyUI on a free GPU notebook (Kaggle gives ~30 GPU-hours per week). Option (b) is zero-cost but not local, so it needs your decision (Q4).

---

## 7. Phases & exit criteria

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **1. Environment** _(this doc)_ | Hardware report, plan, decisions | You approve the plan + answer Q1–Q4 |
| **1b. Setup** | Python 3.12; Postgres + Redis (Docker or native); the backend migrated to NestJS skeleton; Prisma schema §5 + first migration; seed owner user, Rabbit, Squirrel, voice profiles | `prisma migrate` runs; `/health` green for DB + Redis |
| **2. Backend foundation** | Auth (argon2 + httpOnly JWT, RBAC, rate limit), CRUD modules, StorageAdapter, BullMQ queues + JobRun mirror, ActivityLog, SSE, provider registry with health checks | Unit tests for auth, the approval guard and storage; integration tests against real Postgres/Redis |
| **3. Frontend** | Overview, Reference Library, Character Studio, Content Studio, Review Studio, Publishing Center, Analytics, Settings — real API, Zustand UI state, skeletons/empty/error states | Builds; every button wired to a real endpoint; Playwright smoke test |
| **4. Agent Reach** | Install via official uv method, `agent-reach channels` capture, `reference-service`, Instagram login *only if supported*, yt-dlp cookie path, **manual upload fallback**, analysis of your 2 reels | Both reels either analyzed from real content or shown as `needs_upload` with the exact reason |
| **5. Story engine** | Ollama setup (after approval), categories, EN/HI/Hinglish, all 16 story fields, dedup via fingerprints, revisions with feedback | 10 generated stories pass schema validation; no near-duplicates |
| **6. Media production** | ComfyUI + models (after approval), character sheets, IP-Adapter scenes, Kokoro voices, whisper alignment, FFmpeg compose + **validation (ffprobe: 1080×1920, H.264/AAC, 30 fps, duration, audio present, no black frames)** | **Milestone 1: one complete rabbit & squirrel reel in Review Studio** |
| **7. Approval** | Approve / Reject / Request changes / Regenerate / edits / download; transactional gate | Tests prove a rejected or unapproved version can't publish from any path |
| **8. Publishing** | YouTube OAuth + upload, Instagram Graph API Reels (requires Professional account + Meta app), scheduling, idempotent retries, manual-publish option when API access is missing | Real upload to your account (private/unlisted first) |
| **9. Hardening** | Unit/integration/E2E tests, Docker Compose, backups (nightly `pg_dump` + storage copy), deployment docs | All tests green; restore drill done |

Each phase ends with a report and a README update, and the next phase does not start while critical failures remain.

---

## 8. Decisions (answered 2026-11-24)

| # | Decision |
|---|---|
| Q1 | **Owner will enable Intel VT-x in BIOS** → WSL2 + Docker Desktop runs PostgreSQL + Redis only; AI services run natively. |
| Q2 | **Full model set approved** (~16–18 GB to `D:\ai-models`). |
| Q3 | **Python 3.12 approved** alongside 3.14 (venvs for media-service and reference-service). |
| Q4 | **100 % local** for now (stills + camera motion); revisit animation with a future NVIDIA GPU. |
| Q5 | Open — Instagram cookies vs manual upload; asked again in Phase 4. |

### Original questions

- **Q1 — Infrastructure:** Can you enable Intel VT-x in BIOS so we can use WSL2 + Docker Desktop for Postgres and Redis? If not, I'll install native PostgreSQL 17 and Memurai Developer (both free).
- **Q2 — Model downloads (~16–18 GB to D:):** Approve the §6 set? (Ollama, qwen2.5:7b, qwen2.5vl:3b, ComfyUI + PyTorch CPU + SD 1.5 cartoon checkpoint + LCM-LoRA + IP-Adapter, Kokoro, faster-whisper small.)
- **Q3 — Python 3.12:** OK to install Python 3.12 alongside your 3.14? ComfyUI and PyTorch don't support 3.14 yet.
- **Q4 — Quality vs. strictly local:** Stay 100 % local (stills + camera motion) for now, or also plan an optional free Kaggle/Colab GPU route for ComfyUI animation later?
- **Q5 — Instagram:** Your two reference reels will most likely need your browser's Instagram cookies (via yt-dlp) or manual upload. Is exporting a cookies file from your logged-in browser acceptable? It stays inside `reference-service`, is git-ignored and is never logged.
