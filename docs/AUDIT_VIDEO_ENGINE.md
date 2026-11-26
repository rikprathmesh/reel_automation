# ReelForge AI: video engine audit and upgrade plan

_Audited 2026-11-26 against the code in this repository, the database, the files in `storage/`, and this machine. Nothing in this report is assumed. Every claim is backed by a file, a database row or a measurement._

---

## 1. How a reel is made today

```
Content Studio → POST /reels/generate → production queue (concurrency 1)
  "new-reel"  StoryEngine.generate()  (backend/src/stories/stories.module.ts)
              one Ollama call (qwen2.5:7b, CPU) → StorySchema JSON: title, hook, scenes[ description,
              visualPrompt (1 line), characters, expressions, camera enum, transition, dialogue, sfx ]
              quality gate (length / narrator / hook) → optional narration repair call → Story + StoryScript + StoryScene rows
  "produce"   ProductionService.run()  (backend/src/production/production.service.ts)
     storyboard  per scene: prompt = style words + "(visualPrompt:1.2)" + character basePrompts + background
                 → media-service /image → ComfyUI SD1.5 DreamShaper 8 + LCM-LoRA (+ IP-Adapter Plus
                   when the character has a primary sheet) → ONE still PNG per scene
     voice       Kokoro TTS per dialogue line (character voice profile, narrator fallback)
     timing      scene length = its dialogue length (+head/tail)
     animation   media-service /animate mode "kenburns": ffmpeg zoompan over the still   ← no AI motion
     audio       library music / SFX (storage/library is empty, so no music)
     render      ffmpeg compose: xfade transitions, karaoke subtitles, loudnorm → 1080×1920 H.264/AAC
     validation  ffprobe (resolution, codecs, duration, black frames) → version "ready" → Review Studio
  approval → publishing (YouTube Data API v3 / Instagram Graph API), approval re-verified in the worker
```

## 2. Answers to your questions

| Question | Finding (evidence) |
|---|---|
| Real animated clips or static images? | **Static images.** One PNG per scene (`storage/projects/04a3…/v1/scene_0*.png`). The provider selected in the registry is `kenburns` (`providers.module.ts` `DEFAULT_SELECTION.video`). |
| Character reference images used? | **Partly.** A character's primary sheet goes to IP-Adapter at weight 0.45. With several characters the sheets are glued into one horizontal strip (`image.py _ref_strip`), and IP-Adapter blends that into a single identity. Only Rabbit and Squirrel have sheets. The 17 epic characters have none. |
| Scene-specific or generic prompts? | **Scene-specific, but very thin.** One LLM-written line per scene (`SceneSchema.visualPrompt`) wrapped in a fixed template. There are no sections for actions, movement, expressions, camera, continuity or environment, and no evaluation. The camera is a 7-value enum used only for zoompan. |
| Is identity kept across scenes? | **No, not reliably.** In the last reel, scene 3 should show Rabbit and Squirrel but shows two rabbit-like hybrids. The squirrel's orange colour and bushy tail are gone, because the strip reference merged both identities. |
| Real character movement? | **No.** Nothing moves except the virtual camera. |
| Camera movement? | **Only fake**: a zoom or pan crop of a still. |
| Image-to-video or text-to-video? | **Neither.** An `img2vid.json` (Stable Video Diffusion) workflow exists but is not selected, the model is not installed, and it needs an NVIDIA GPU. SVD also **ignores text prompts**: the `prompt` the code passes is unused. |
| Is FFmpeg only combining images and audio? | **Yes.** It produces all of the "animation" today. |
| How is voice synced? | Correctly. Scene duration follows the measured TTS duration, and subtitles use word timings. There is no lip-sync. |
| Why doesn't it look like professional AI animation? | See §3. |

## 3. Root causes, in order of impact

1. **No video model.** Stills plus zoompan are a slideshow. This is the single biggest gap, and it is a **hardware limit** (§5), not a code bug.
2. **Thin, unstructured prompts.** One line per scene with no action, pose, expression, camera, lighting or continuity detail. The LLM never sees the whole story's characters, locations or event order when it writes a scene.
3. **Identity comes from text plus a merged reference.** Multi-character scenes merge identities. There is no structured character profile (species, proportions, colours, accessories) to restate exactly in every prompt.
4. **Character sheets are generated only on demand**, from one front view. There are no side, back or close-up views, and the epic casts have no references at all.
5. **Look drift.** DreamShaper with words like "cinematic" or "dramatic" produces dark, photo-like lighting (visible in the last reel). There is no per-scene lighting or environment description.
6. **Too few scenes.** The last reel is 13.8 s with 3 scenes, so it fell well under the 60 s rule (the warning is logged, but the reel still went to review).
7. **No story understanding.** The AI invents every story. Your own idea or full story can't be used, and there is no episode continuation.

## 4. What is solid and stays as is

Approval gate (`publishing/gate.ts`, re-checked inside a SERIALIZABLE transaction in the worker), append-only Approval log, version supersede and invalidate, encrypted OAuth tokens, BullMQ serialization (one heavy model at a time), media validation, provider registry, character and voice profiles, Hindi voices, reference library with Agent Reach / yt-dlp / upload fallback, daily schedule (never publishes).

## 5. This machine's limits (measured 2026-11-26)

| Resource | Value |
|---|---|
| CPU | Intel i5-1035G1, 4 cores / 8 threads, 15 W laptop chip |
| RAM | 15.7 GB, **4.6 GB free** with all services running |
| GPU | Intel UHD (iGPU, 1 GB shared). **No NVIDIA, no CUDA** |
| Disk | C: 81 GB free, D: 173 GB free |
| Installed models | DreamShaper 8 (SD1.5), LCM-LoRA, TAESD, IP-Adapter Plus SD1.5 + CLIP-ViT-H, qwen2.5:7b, qwen2.5vl:3b, Kokoro-82M, faster-whisper small |
| Measured | SD1.5 + LCM still at 432×768, 4 steps: **~200 s** (~50 s per UNet step) |

### What each kind of video model needs, and whether it fits

| Model | Type | Hardware need | Fits here? |
|---|---|---|---|
| Wan 2.1 / 2.2 (1.3B, 5B, 14B), Apache-2.0 | T2V / I2V, best open quality | GPU. A 4090 takes about 4 min for 5 s at 480p. The 1.3B model's T5 encoder alone needs about 6.5 GB of RAM, and a 16 GB machine was reported failing to load it | **No** |
| LTX-Video 2B (distilled) | T2V / I2V, first and last frame | GPU (8 GB+ VRAM), T5 encoder about 5–9 GB | **No** |
| Stable Video Diffusion XT | I2V only, **no text control** | GPU 12 GB+ | **No** |
| HunyuanVideo, CogVideoX-5B, Mochi | T2V / I2V | GPU 24 GB+ | **No** |
| **AnimateDiff / AnimateLCM (SD1.5)** | T2V, image-guided through IP-Adapter and init frames | Reuses the installed SD1.5, IP-Adapter and LCM. About 1.8 GB motion module plus the AnimateDiff-Evolved node. **Runs on CPU, slowly** | **Yes, slowly.** Estimate: 16 frames (2 s at 8 fps) at 384×672, 4 LCM steps ≈ **15–30 min per clip**. Must be measured. The AnimateLCM weights licence must be checked before download (the AnimateDiff v3 modules are Apache-2.0). |
| Frame interpolation (RIFE / FILM) | 8 → 24–30 fps smoothing | CPU OK, about 1–2 min per clip | Yes |
| LivePortrait / SadTalker / Wav2Lip (lip-sync) | face animation | Built for human faces, poor on cartoon animals, several non-commercial licences | Not recommended |

**Honest throughput.** With AnimateLCM on this CPU, a 60 s reel of about 8 scenes at 2–4 s of real motion per scene (held or extended to the scene's length) takes about **3–6 hours**. That makes it 1–2 animated reels per night, not 5. **Five professionally animated reels per day needs an NVIDIA GPU** (an RTX 3060 12 GB runs Wan 2.1 1.3B / LTX-Video at minutes per clip), or a GPU ComfyUI reachable over the network. The provider layer is being built so that a GPU ComfyUI URL can be plugged in without code changes.

**What will not be done:** zoompan stills will never be labelled "animated". From Phase 4 on, every version records `animation.isAiAnimation`, and a Ken Burns reel shows a warning in Review.

## 6. Optional external tools (re-checked; see docs/IMPLEMENTATION_PLAN.md §2, verified 2026-11-24)

| Tool | Official API | MCP | Automatable | Free | Verdict |
|---|---|---|---|---|---|
| Google Flow | No public API or export. Veo is reachable only through the paid Gemini / Vertex API | No | No (only browser automation, which we won't do) | Limited credits in the UI | No integration. A paid Veo adapter could be added later behind the paid-provider switch. |
| Higgsfield MCP | Remote MCP endpoint is advertised; generation is metered | Yes (remote) | Yes, through MCP with your account | No (credits) | Optional paid adapter, off by default. Not built until you ask. |
| Clipchamp | No public API | No | No | — | No integration possible. |
| Agent Reach | CLI with JSON output (v1.6+) | No | Yes | Yes | **Already integrated** (reference-service). Instagram is experimental and needs login; single reels usually fall back to yt-dlp with your cookies, then manual upload. |

## 7. Files and modules to change

| Area | Files |
|---|---|
| Database (additive migration, no data loss) | `backend/prisma/schema.prisma`, `backend/prisma/migrations/20261126000000_story_prompt_engine/` |
| Story understanding, sources, age groups, episodes | `backend/src/stories/*`, `backend/src/common/lengths.ts`, `backend/src/references/platform.ts` (categories) |
| Character profiles and reference prompts | `backend/src/characters/profile.ts` (new), `characters.module.ts` |
| Prompt engine: spec, model adapters, evaluator, service, API | `backend/src/prompts/*` (new) |
| Production uses generated prompts; honest animation flag | `backend/src/production/production.service.ts` |
| Video providers (Phase 4) | `backend/src/providers/*`, `media-service/app/animate.py`, `media-service/workflows/animatediff*.json` |
| Dashboard | `frontend/src/app/content/page.tsx` (Story Studio inputs), `frontend/src/app/prompts/page.tsx` (new Prompt Studio), `frontend/src/lib/api.ts`, `app-shell.tsx` |

## 8. Phased plan

| Phase | Scope | Status |
|---|---|---|
| 1 | Audit (this document) | Done |
| 2 | Story understanding engine (idea, full story, continuation, age groups, new categories) → story bible → faithful scene breakdown (about 8 s scenes, configurable) → permanent character profiles and reference-view prompts → structured, story-aware scene prompts (sections A–J) → model adapters with declared capabilities → prompt evaluation and auto-improve → Prompt Studio (view, edit, regenerate, improve, shorten, expand, switch model, history, templates) | In progress |
| 2b | Async pipeline (moved up on 2026-11-26 at the owner's request): per-scene jobs (`SceneGenerationJob`) + merge job (BullMQ flow), resume after failure, single-scene regeneration, per-version timings; AI-story mode invents its premise and designs new characters; character designs self-check against the story | Done, end-to-end test running |
| 3 | Character consistency: generate master and multi-view references (front, side, back, ¾, close-up, expressions) from the profile prompts; one IP-Adapter per character (regional masks) instead of the merged strip; environment references; continuity metadata into keyframes | Next |
| 4 | Real animation: AnimateDiff/AnimateLCM provider (CPU; **needs your OK for about 2 GB of downloads** and a licence check), RIFE interpolation, "remote GPU ComfyUI" provider for Wan / LTX when a GPU exists, honest `isAiAnimation` flag | Needs your decision |
| 5 | Audio: emotion-aware narration, per-character voices (already partly there), SFX and ambience library (licensed CC0 packs), music ducking | |
| 6 | Composition: clip-based timeline (multi-shot scenes), subtitles, transitions | |
| 7 | Scene-level review and approval (scene approve/reject/regenerate one scene); approval invalidated on change (already true for versions) | |
| 8 | Publishing (exists; harden token refresh, thumbnails) | |
| 9 | Daily scheduler made hardware-aware (exists; becomes animation-time-aware) | |
