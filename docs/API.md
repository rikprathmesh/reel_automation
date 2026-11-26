# ReelForge API reference (generated from the running NestJS route table, 2026-11-24)

All routes are under `/api`, JSON, and require the `rf_session` cookie (sign in via `POST /api/auth/login`) unless marked public. Roles: owner > editor > viewer; write actions name the roles they need in the controllers. Live updates: `GET /api/events` (Server-Sent Events: project, job, reference, story, character, publishing, activity).

| Method | Path |
|---|---|
| GET | `/api/activity` |
| POST | `/api/analytics/refresh` |
| GET | `/api/analytics` |
| POST | `/api/auth/login` |
| POST | `/api/auth/logout` |
| GET | `/api/auth/me` |
| POST | `/api/auth/password` |
| POST | `/api/automation/run-now` |
| POST | `/api/characters/:id/images/:imageId/primary` |
| DELETE | `/api/characters/:id/images/:imageId` |
| POST | `/api/characters/:id/images` |
| DELETE | `/api/characters/:id` |
| GET | `/api/characters/:id` |
| PUT | `/api/characters/:id` |
| GET | `/api/characters` |
| POST | `/api/characters` |
| GET | `/api/events` |
| GET | `/api/health` |
| GET | `/api/integrations` |
| PUT | `/api/integrations` |
| GET | `/api/jobs` |
| GET | `/api/prompts/models` (adapter capabilities + whether each can actually run) |
| GET | `/api/prompts/story/:id` (bible, scenes with current prompts, character prompts, pending jobs) |
| POST | `/api/prompts/story/:id/generate` (queued) |
| GET | `/api/prompts/scene/:id/versions` |
| POST | `/api/prompts/scene/:id/generate` (queued) |
| POST | `/api/prompts/:id/transform` (improve / shorten / expand / instruct; queued) |
| PUT | `/api/prompts/:id` (manual edit → new version) |
| POST | `/api/prompts/:id/model` (re-render for another model, no LLM) |
| POST | `/api/prompts/:id/restore` |
| POST | `/api/prompts/:id/apply-template` |
| GET | `/api/prompts/templates` |
| POST | `/api/prompts/templates` |
| POST | `/api/prompts/character/:id/profile` (queued) |
| GET | `/api/media/*key` |
| GET | `/api/oauth/instagram/callback` |
| GET | `/api/oauth/instagram/start` |
| GET | `/api/oauth/youtube/callback` |
| GET | `/api/oauth/youtube/start` |
| POST | `/api/projects/:id/regenerate` |
| DELETE | `/api/projects/:id` |
| GET | `/api/projects/:id` |
| GET | `/api/projects` |
| POST | `/api/publishing/:id/manual` |
| POST | `/api/publishing/:id/retry` |
| DELETE | `/api/publishing/accounts/:platform` |
| POST | `/api/publishing/accounts/instagram/token` |
| GET | `/api/publishing/accounts` |
| GET | `/api/publishing` |
| GET | `/api/queues` |
| POST | `/api/reels/generate` |
| POST | `/api/references/:id/analyze` |
| DELETE | `/api/references/:id` |
| GET | `/api/references/:id` |
| PATCH | `/api/references/:id` |
| POST | `/api/references/upload` |
| GET | `/api/references` |
| POST | `/api/references` |
| GET | `/api/review` |
| PUT | `/api/settings/generation` |
| PUT | `/api/settings/schedule` |
| GET | `/api/settings` |
| GET | `/api/stats` |
| POST | `/api/stories/:id/produce` |
| PUT | `/api/stories/:id/script` |
| GET | `/api/stories/:id` |
| POST | `/api/stories/generate` |
| GET | `/api/stories` |
| POST | `/api/versions/:id/approve` |
| PATCH | `/api/versions/:id/metadata` |
| POST | `/api/versions/:id/reject` |
| POST | `/api/versions/:id/request-changes` |
| DELETE | `/api/voice-profiles/:id` |
| PUT | `/api/voice-profiles/:id` |
| GET | `/api/voice-profiles/available` |
| GET | `/api/voice-profiles` |
| POST | `/api/voice-profiles` |

Internal services (called only by the backend, protected by `X-Service-Token`):

- **media-service :8000** — `GET /health`, `GET /voices`, `POST /image`, `/animate`, `/tts`, `/transcribe`, `/library/pick`, `/compose` (returns render validation), `/thumbnail`, `/probe`
- **reference-service :8100** — `GET /health`, `POST /extract` (Agent Reach + yt-dlp + FFmpeg + whisper), `POST /process-upload`
