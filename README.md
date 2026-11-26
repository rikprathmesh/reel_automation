# ReelForge AI

A personal, local-first AI studio for animated storytelling reels. It studies reference reels, writes original Rabbit & Squirrel stories (English, Hindi or Hinglish), renders them as 1080×1920 vertical videos with consistent characters, voices, music, transitions and subtitles, and publishes them to **YouTube Shorts** and **Instagram Reels**, but only after you approve each one.

- **How to run it:** [RUNNING_NOTES.txt](RUNNING_NOTES.txt) (one command: `scripts\start-all.ps1`)
- **Plan, hardware report, decisions:** [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- **API reference (generated from the live route table):** [docs/API.md](docs/API.md)

## Architecture

```
Browser ─▶ frontend/ (Next.js 16, :3000) ──/api proxy──▶ backend/ (NestJS 12, :4000)
                                                          │  Prisma ─▶ PostgreSQL 18
                                                          │  BullMQ ─▶ Redis 8 (job queues)
                                                          │  SSE (live progress)
                                       ┌──────────────────┼───────────────────────┐
                              reference-service (:8100)   media-service (:8000)   Ollama (:11434)
                              Agent Reach · yt-dlp ·      ComfyUI client · Kokoro  qwen2.5:7b-instruct
                              FFmpeg · faster-whisper     · faster-whisper ·       qwen2.5vl:3b
                                                          FFmpeg compose/validate
                                                                  │
                                                          ComfyUI (:8188, CPU)
                                                          DreamShaper 8 + LCM-LoRA + IP-Adapter
          storage/ (shared local media; StorageAdapter ready for S3)
```

| App | Stack |
|---|---|
| `frontend/` | Next.js 16, TypeScript, Tailwind v4, shadcn/ui, Framer Motion, React Query (server data), Zustand (UI state) |
| `backend/` | NestJS 12, TypeScript, Prisma 7 + PostgreSQL, BullMQ + Redis, SSE, argon2id auth, AES-256-GCM token storage |
| `reference-service/` | Python 3.12, FastAPI, Agent Reach 1.6.1 (official uv install), yt-dlp, FFmpeg, faster-whisper |
| `media-service/` | Python 3.12, FastAPI, ComfyUI workflows, Kokoro TTS (EN + Hindi voices), faster-whisper word timing, FFmpeg |
| `infra/` | `docker-compose.dev.yml` (Postgres + Redis), `docker-compose.yml` (full stack for a Docker/GPU host) |
| `scripts/` | `start-all.ps1`, `backup.ps1`, `restore.ps1` |

Every AI capability sits behind a provider interface (`TextGenerationProvider`, `ImageGenerationProvider`, `VideoGenerationProvider`, `VoiceGenerationProvider`, `TranscriptionProvider`, `ReferenceExtractionProvider`) and an integration registry (Settings → AI providers). All defaults are local and free. Paid adapters would need explicit confirmation and are logged.

## Phase status

| Phase | Status |
|---|---|
| 1. Environment & plan | ✅ CPU-only i5 laptop, 16 GB RAM; decisions in the plan |
| 1b. Setup | ✅ Python 3.12, Ollama + 2 models, PostgreSQL 18 (native) + migration + seed, Redis 8 |
| 2. Backend foundation | ✅ Auth/roles/rate limits, activity log, storage + validated uploads, queues + job tracking, provider registry, CRUD APIs |
| 3. Frontend | ✅ All 8 sections on real APIs; live updates; skeleton/empty/error states |
| 4. Agent Reach & references | ✅ Reel 1 analyzed from real content; reel 2 honestly marked *needs upload* (Instagram blocked the anonymous download) |
| 5. Story engine | ✅ 16-field stories, EN/HI/Hinglish, duplicate detection, quality gates, revisions with feedback |
| 6. Media production | ✅ Built and running: storyboard → voice → animation → audio → editing → render → **validation** |
| 7. Approval workflow | ✅ Review Studio: approve (user + timestamp, SERIALIZABLE transaction), reject (cancels publishing), request changes (LLM revision → new version), regenerate, edit title/caption/script, download |
| 8. Publishing | ✅ Code complete: YouTube Data API v3 (OAuth) and Instagram Graph API (Reels, resumable upload), scheduling, duplicate-safe retries, manual-publish fallback, analytics. **Needs your Google Cloud and Meta app credentials to go live** |
| 9. Testing & deployment | ✅ 21 unit tests (12 cover the approval gate), API integration runs, e2e browser smoke test, Dockerfiles + compose, tested backup |

### Video engine upgrade (2026-11-26, see [docs/AUDIT_VIDEO_ENGINE.md](docs/AUDIT_VIDEO_ENGINE.md))

| Phase | Status |
|---|---|
| 1. Audit | ✅ Root causes: stills + Ken Burns (no video model), one-line prompts, merged character references, no story understanding |
| 2. Story & prompt engine | ✅ Story sources (AI / my idea / my full story / next episode), age groups, 6 new categories, **story bible** (characters, locations, objects, chronological events), faithfulness checks, permanent character profiles + 6 reference-view prompts, structured scene prompts (sections A–J) written per scene with whole-story context, model adapters that declare what each model can and cannot do, quality rubric + automatic improvement, **Prompt Studio** (view, edit, regenerate, improve, shorten, expand, instruct, switch model, history/restore, templates) |
| Async pipeline | ✅ Each reel fans out into independent **scene jobs** (keyframe image → voices → AI clip when a video model is selected), stored in `SceneGenerationJob`; a **merge job** runs when all are done (timing, camera motion, music, render, validation). Retries, crashes and restarts resume from finished scenes. **Regenerate one scene** in Review Studio → Scenes (new version, other scenes reused). Every version records its timings (per scene, merge, wall clock). AI-story mode now invents its own premise and designs new characters; character designs self-check against the story's details |
| 3. Character consistency (multi-view references, one IP-Adapter per character) | Next |
| 4. Real AI animation (AnimateDiff/AnimateLCM on CPU, or Wan/LTX on a GPU) | Needs your decision: ~2 GB download + licence check |

## Non-negotiable rules (how they are enforced)

| Rule | Enforcement |
|---|---|
| Never publish without approval | The publishing worker re-checks the approval **in the database**, inside a locked SERIALIZABLE transaction, right before every upload (`backend/src/publishing/gate.ts`, tested) |
| Rejected videos never enter the queue | Rejecting cancels every not-yet-uploaded job; the gate blocks any version whose latest decision isn't an approval |
| Same video never published twice | Unique `(versionId, platform)` in PostgreSQL + idempotent worker |
| No paid APIs without asking | All defaults local; paid providers need explicit confirmation and are logged |
| No fake integrations | A missing dependency fails with a clear error. Nothing returns placeholder output |
| Every important operation recorded | `ActivityLog` table + live feed on the Overview |

## Configuration

Settings live in `.env` files that are never committed: `backend/.env`, `reference-service/.env`, `media-service/.env`. Every backend variable, with its default, is defined in [`backend/src/config/env.ts`](backend/src/config/env.ts), and the backend refuses to start with a readable error if one is invalid. The key ones are `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SERVICE_TOKEN`, `OLLAMA_*`, and, for publishing, `GOOGLE_CLIENT_ID/SECRET` and `META_APP_ID/SECRET`.

## Tests

```powershell
cd backend;  npm test                  # unit + approval-gate tests
cd frontend; $env:E2E_EMAIL="…"; $env:E2E_PASSWORD="…"; npm run test:e2e   # signs in and opens every page
```

## Known limits on this laptop (honest)

- **No real character animation yet.** There's no NVIDIA GPU, so today motion is camera movement over still frames, and every such reel is labelled "Not AI-animated" in Review. The only real-animation model that can run on this CPU is AnimateDiff/AnimateLCM (estimated 15–30 min per 2 s clip). Wan 2.1, LTX-Video and SVD need an NVIDIA GPU. Prompt Studio → Models shows what can actually run (workflow, nodes and model files all present).
- **Speed.** Measured: ~5–6 min per image when the machine isn't swapping, ~10 min per story. One reel takes about an hour, so five per day means an overnight batch. Close other heavy apps while rendering.
- **Instagram references.** Agent Reach 1.6.1's Instagram channel can't read single reels, so the pipeline uses yt-dlp, which Instagram often blocks without login. Upload the video, or provide your own browser cookies.
- **Publishing.** This needs your Google Cloud OAuth client (YouTube) and a Meta app plus an Instagram Professional account. Until then, approved reels can be published manually and recorded.
