# ReelForge media service

A Python FastAPI service that handles every heavy media operation for ReelForge. It runs fully on your machine:

| Capability | Engine |
|---|---|
| Reading reference videos (metadata, subtitles, download, shot cuts, frames) | `yt-dlp`, [Agent Reach](https://github.com/Panniantong/Agent-Reach) (optional), ffmpeg scene detection |
| Transcription and word-level caption timing | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| Voices | [Kokoro](https://github.com/hexgrad/kokoro) (default) or [Piper](https://github.com/rhasspy/piper) |
| Scene images (with character reference conditioning) | [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (SDXL, plus IPAdapter Plus for references) |
| Scene motion | Ken Burns pan/zoom (ffmpeg), or Stable Video Diffusion through ComfyUI |
| Final edit | ffmpeg: xfade transitions, voice placement, SFX, music ducked under voice, −14 LUFS loudness, burned word-highlight captions |

The HTTP contract is in [`../docs/CONTRACTS.md`](../docs/CONTRACTS.md) §2. There are **no fake fallbacks**: if ComfyUI or a TTS engine is unavailable, the request fails with 503 and a clear message.

## Run locally

Python 3.12 is recommended; some wheels may not exist yet for newer Python versions.

```bash
cd media-service
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
create .env                        # settings below; never committed
uvicorn app.main:app --port 8000
```

Open `http://localhost:8000/health` to see which engines are available, or `http://localhost:8000/docs` for the interactive API.

- **ffmpeg**: a system ffmpeg on `PATH` is used if present. Otherwise the binary bundled with `imageio-ffmpeg` is used. Set `FFMPEG_PATH` to force a specific one.
- **Kokoro** needs `espeak-ng` installed (`apt install espeak-ng`, `brew install espeak-ng`, or the Windows installer from the espeak-ng releases page).
- **Piper**: download voice models (`*.onnx` plus `*.onnx.json`) from [rhasspy/piper voices](https://huggingface.co/rhasspy/piper-voices) into `PIPER_VOICES_DIR`, then set `TTS_ENGINE=piper`.
- **faster-whisper** downloads the `WHISPER_MODEL` (default `small`) on first use.
- **ComfyUI**: run it separately (`python main.py --listen`), install the models and custom nodes listed in [`workflows/README.md`](workflows/README.md), and point `COMFYUI_URL` at it.
- **Agent Reach** (optional): install it per its README. `agent-reach read <url>` must work in the shell that runs this service.

## Docker

```bash
docker build -t reelforge-media .
docker run -p 8000:8000 -v $(pwd)/../storage:/storage --env-file .env -e COMFYUI_URL=http://host.docker.internal:8188 reelforge-media
```

The image installs CPU-only PyTorch. For GPU Kokoro or Whisper, switch the torch index URL in the `Dockerfile` to a CUDA build and set `WHISPER_DEVICE=cuda`.

## Storage

Every request and response refers to files by **storage key** (a relative POSIX path under `STORAGE_ROOT`). The backend mounts the same folder. Absolute paths, `..` segments and drive letters are rejected. Music and SFX libraries live in `library/music` and `library/sfx`, matched by keywords in file names plus optional `library.json` tags. A custom caption font can go in `library/fonts`.

## Configuration

All settings are environment variables (read from `.env`). The most important ones:

| Var | Default | Purpose |
|---|---|---|
| `STORAGE_ROOT` | `../storage` | Shared media folder |
| `MEDIA_SERVICE_TOKEN` | empty | When set, requests need an `X-Media-Token` header (`/health` stays open for health checks) |
| `MAX_CONCURRENT_JOBS` | `2` | Concurrency limit for renders, ComfyUI jobs and TTS |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI server |
| `TTS_ENGINE` | `kokoro` | `kokoro` or `piper` |
| `WHISPER_MODEL` | `small` | faster-whisper model size |
| `YTDLP_COOKIES_FILE` | empty | Browser cookies file; most Instagram reels need it |
