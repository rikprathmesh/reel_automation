"""ReelForge media service — FastAPI app (contract: docs/CONTRACTS.md §2)."""
from __future__ import annotations

import hmac
import logging
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import TypeVar

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import animate, comfyui, compose, image, library, tts, whisper
from .config import get_settings
from .ffmpeg import FFmpegError, ffmpeg_available, probe_duration
from .models import (
    AnimateRequest, AnimateResponse, ComposeRequest, ComposeResponse, Health, ImageRequest, ImageResponse,
    KeyResponse, LibraryRequest, LibraryResponse, ProbeRequest, ProbeResponse,
    ThumbnailRequest, TranscribeRequest, TranscribeResponse, TTSRequest, TTSResponse, Voice,
)
from .storage import StorageKeyError, existing

settings = get_settings()
logging.basicConfig(level=settings.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("media")

app = FastAPI(title="ReelForge media service", version="1.0.0")

# Limits concurrent CPU/GPU-heavy work (ffmpeg renders, ComfyUI, TTS) across worker threads.
_heavy = threading.BoundedSemaphore(max(1, settings.max_concurrent_jobs))


@contextmanager
def heavy(op: str) -> Iterator[None]:
    t0 = time.monotonic()
    with _heavy:
        log.info("start %s", op)
        try:
            yield
        finally:
            log.info("done %s in %.1fs", op, time.monotonic() - t0)


T = TypeVar("T")


def guarded(op: str, fn: Callable[[], T]) -> T:
    """Runs a heavy operation and maps domain errors to HTTP errors (never fake success)."""
    try:
        with heavy(op):
            return fn()
    except (StorageKeyError, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except (comfyui.ComfyUnavailable, tts.TTSUnavailable) as e:
        raise HTTPException(503, str(e)) from e
    except (comfyui.ComfyFailed, FFmpegError) as e:
        log.error("%s failed: %s", op, e)
        raise HTTPException(500, str(e)) from e
    except HTTPException:
        raise
    except Exception as e:
        log.exception("%s crashed", op)
        raise HTTPException(500, f"{op} failed: {type(e).__name__}: {e}") from e


@app.middleware("http")
async def token_auth(request: Request, call_next):
    if settings.service_token and request.url.path not in ("/health", "/docs", "/openapi.json"):
        given = request.headers.get("x-service-token", "")
        if not hmac.compare_digest(given, settings.service_token):
            return JSONResponse({"detail": "Invalid or missing X-Service-Token"}, status_code=401)
    return await call_next(request)


# ---------------------------------------------------------------- health


@app.get("/health", response_model=Health)
def health() -> Health:
    return Health(
        ffmpeg=ffmpeg_available(),
        comfyui=comfyui.status(),
        tts={"kokoro": tts.kokoro_available(), "piper": tts.piper_available(), "default_engine": settings.tts_engine},
        whisper=whisper.status(),
    )


@app.get("/voices", response_model=list[Voice])
def voices() -> list[dict]:
    return tts.list_voices()


# ------------------------------------------------------------ operations


@app.post("/tts", response_model=TTSResponse)
def synthesize(req: TTSRequest) -> dict:
    return guarded("tts", lambda: tts.synthesize(req.text, req.engine, req.voice, req.speed, req.out_key, req.language))


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(req: TranscribeRequest) -> dict:
    return guarded("transcribe", lambda: whisper.transcribe(existing(req.key), req.language))


@app.post("/image", response_model=ImageResponse)
def generate_image(req: ImageRequest) -> dict:
    return guarded("image", lambda: image.generate(req.prompt, req.negative_prompt, req.reference_keys, req.seed, req.width, req.height, req.out_key))


@app.post("/animate", response_model=AnimateResponse)
def animate_scene(req: AnimateRequest) -> dict:
    return guarded("animate", lambda: animate.animate(req.image_key, req.duration, req.camera, req.prompt, req.mode, req.out_key))


@app.post("/free")
def free() -> dict:
    """Releases ComfyUI's models so the LLM can use the RAM."""
    return {"comfyui_freed": comfyui.free_memory()}


@app.post("/library/pick", response_model=LibraryResponse)
def library_pick(req: LibraryRequest) -> dict:
    try:
        return {"key": library.pick(req.kind, req.query, req.salt)}
    except (StorageKeyError, ValueError) as e:
        raise HTTPException(400, str(e)) from e


@app.post("/compose", response_model=ComposeResponse)
def compose_reel(req: ComposeRequest) -> dict:
    return guarded("compose", lambda: compose.compose(req))


@app.post("/thumbnail", response_model=KeyResponse)
def make_thumbnail(req: ThumbnailRequest) -> dict:
    return guarded("thumbnail", lambda: compose.thumbnail(req.image_key, req.text, req.out_key))


@app.post("/probe", response_model=ProbeResponse)
def probe(req: ProbeRequest) -> dict:
    try:
        return {"duration": round(probe_duration(existing(req.key)), 3)}
    except (StorageKeyError, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except FFmpegError as e:
        raise HTTPException(500, str(e)) from e
