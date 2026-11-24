"""ReelForge reference-service: Agent Reach + yt-dlp + FFmpeg + faster-whisper, isolated from the main backend.

Browser cookies (optional, for yt-dlp) live only in this service's config; they are never logged or returned.
"""

import logging
import secrets
import shutil
import subprocess
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import agent_reach, media
from .config import settings
from .storage import key_path, to_key

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
log = logging.getLogger("reference-service")
app = FastAPI(title="ReelForge reference-service", version="1.0.0")


def auth(x_service_token: str | None = Header(default=None)) -> None:
    if settings.service_token and not secrets.compare_digest(x_service_token or "", settings.service_token):
        raise HTTPException(401, "Invalid service token")


class ExtractRequest(BaseModel):
    url: str = Field(pattern=r"^https?://")
    work_key: str


class UploadRequest(BaseModel):
    video_key: str
    work_key: str


class ExtractionResult(BaseModel):
    ok: bool
    extractor: str
    title: str | None = None
    author: str | None = None
    caption: str | None = None
    transcript: str | None = None
    transcriptLanguage: str | None = None
    durationSec: float | None = None
    metadata: dict = {}
    frameKeys: list[str] = []
    videoKey: str | None = None
    thumbnailKey: str | None = None
    cuts: list[float] = []
    warnings: list[str] = []
    error: str | None = None


def _tool_ok(cmd: str) -> bool:
    try:
        return subprocess.run([cmd, "-version"], capture_output=True, timeout=20).returncode == 0
    except Exception:  # noqa: BLE001
        return False


@app.get("/health")
def health() -> dict:
    v = agent_reach.version()
    ff = _tool_ok(settings.ffmpeg_path) and _tool_ok(settings.ffprobe_path)
    return {
        "ok": ff,
        "agent_reach": {"installed": v is not None, "version": v},
        "ytdlp": True,
        "ffmpeg": ff,
        "cookies_configured": bool(settings.ytdlp_cookies_file and Path(settings.ytdlp_cookies_file).is_file()),
        "whisper_model": settings.whisper_model,
    }


def _analyze_video(video: Path, work: Path, res: ExtractionResult) -> None:
    """FFmpeg + whisper on a local video file; fills duration, cuts, frames, thumbnail, transcript."""
    res.videoKey = to_key(video)
    res.durationSec = media.ffprobe_duration(video)
    if not res.durationSec:
        raise ValueError("The file is not a readable video (ffprobe could not read its duration)")
    res.cuts = media.scene_cuts(video)
    frames = media.sample_frames(video, res.durationSec, work / "frames", settings.frames_to_sample)
    res.frameKeys = [to_key(f) for f in frames]
    if not res.thumbnailKey:
        t = media.thumbnail_from_video(video, work / "thumbnail.jpg")
        res.thumbnailKey = to_key(t) if t else None
    if media.has_audio(video):
        try:
            tr = media.transcribe(media.extract_audio(video, work / "audio.wav"))
            res.transcript = tr["text"] or None
            res.transcriptLanguage = tr["language"]
            if not tr["text"]:
                res.warnings.append("No speech detected in the audio")
        except Exception as e:  # noqa: BLE001
            res.warnings.append(f"Transcription failed: {e}")
        finally:
            (work / "audio.wav").unlink(missing_ok=True)
    else:
        res.warnings.append("Video has no audio track")


@app.post("/extract", response_model=ExtractionResult, dependencies=[Depends(auth)])
def extract(req: ExtractRequest) -> ExtractionResult:
    work = key_path(req.work_key)
    work.mkdir(parents=True, exist_ok=True)
    res = ExtractionResult(ok=False, extractor="agent-reach")

    # 1. Agent Reach: readable text (caption/title/cover) via the matching channel
    ar = agent_reach.read(req.url)
    if ar.get("ok"):
        res.title, res.author, res.caption = ar.get("title"), ar.get("author"), ar.get("text")
        res.metadata["agentReach"] = {"channel": ar.get("channel"), "backend": ar.get("backend")}
        if ar.get("image_url"):
            t = media.download_image(ar["image_url"], work / "thumbnail.jpg")
            res.thumbnailKey = to_key(t) if t else None
    else:
        res.warnings.append(ar.get("error") or "Agent Reach returned nothing")

    # 2. yt-dlp: the video itself
    video, meta, err = media.download_video(req.url, work)
    if meta:
        res.metadata["ytdlp"] = meta
        res.title = res.title or meta.get("title")
        res.author = res.author or meta.get("uploader") or meta.get("channel")
        res.caption = res.caption or meta.get("description")
    if not video:
        hint = (
            "Instagram did not allow an anonymous download. Upload the video file here, or set YTDLP_COOKIES_FILE in reference-service/.env (cookies exported from your own logged-in browser)."
            if "instagram.com" in req.url
            else "Upload the video file here instead."
        )
        res.error = f"Video could not be downloaded ({(err or 'unknown error').splitlines()[0][:300]}). {hint}"
        res.extractor = "agent-reach" if ar.get("ok") else "none"
        return res  # caption/thumbnail kept, but NOT marked as analyzable

    # 3. FFmpeg + whisper
    res.extractor = "agent-reach+yt-dlp" if ar.get("ok") else "yt-dlp"
    try:
        _analyze_video(video, work, res)
        res.ok = True
    except Exception as e:  # noqa: BLE001
        res.error = f"Downloaded video could not be processed: {e}"
    return res


@app.post("/process-upload", response_model=ExtractionResult, dependencies=[Depends(auth)])
def process_upload(req: UploadRequest) -> ExtractionResult:
    video = key_path(req.video_key)
    if not video.is_file():
        raise HTTPException(404, "Uploaded video not found in storage")
    work = key_path(req.work_key)
    work.mkdir(parents=True, exist_ok=True)
    res = ExtractionResult(ok=False, extractor="upload")
    try:
        _analyze_video(video, work, res)
        res.ok = True
    except Exception as e:  # noqa: BLE001
        res.error = f"Uploaded video could not be processed: {e}"
    return res


@app.on_event("startup")
def _startup() -> None:
    log.info("reference-service ready (agent-reach %s, ffmpeg %s, cookies %s)",
             agent_reach.version() or "missing",
             "ok" if shutil.which(settings.ffmpeg_path) or Path(settings.ffmpeg_path).exists() else "missing",
             "configured" if settings.ytdlp_cookies_file else "not configured")
