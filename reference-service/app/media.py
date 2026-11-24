"""yt-dlp download + FFmpeg analysis (duration, shot cuts, frames, audio) + local faster-whisper transcription."""

import json
import logging
import os
import re
import subprocess
import threading
from pathlib import Path

import httpx

from .config import settings

log = logging.getLogger("media")


def ffprobe_duration(path: Path) -> float | None:
    p = subprocess.run(
        [settings.ffprobe_path, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    try:
        return float(json.loads(p.stdout)["format"]["duration"])
    except Exception:  # noqa: BLE001
        return None


def has_audio(path: Path) -> bool:
    p = subprocess.run(
        [settings.ffprobe_path, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    return bool(p.stdout.strip())


def scene_cuts(path: Path, threshold: float = 0.3) -> list[float]:
    """Shot boundaries via FFmpeg's scene-change score."""
    p = subprocess.run(
        [settings.ffmpeg_path, "-hide_banner", "-i", str(path), "-vf", f"scale=320:-2,select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"],
        capture_output=True, text=True, timeout=900, errors="replace",
    )
    return [round(float(t), 2) for t in re.findall(r"pts_time:([\d.]+)", p.stderr)]


def sample_frames(path: Path, duration: float, out_dir: Path, count: int) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    frames: list[Path] = []
    # first frame near the hook, then evenly spaced
    times = [min(0.5, duration / 10)] + [duration * (i + 1) / (count + 1) for i in range(count - 1)]
    for i, t in enumerate(times):
        f = out_dir / f"frame_{i:02d}.jpg"
        subprocess.run(
            [settings.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4", str(f)],
            capture_output=True, timeout=120,
        )
        if f.exists() and f.stat().st_size > 0:
            frames.append(f)
    return frames


def extract_audio(path: Path, out: Path) -> Path:
    subprocess.run(
        [settings.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", str(out)],
        check=True, capture_output=True, timeout=600,
    )
    return out


_whisper = None
_whisper_lock = threading.Lock()


def _pcm16k(audio: Path):
    """Decode to 16 kHz mono float32 with FFmpeg (avoids faster-whisper's PyAV decoder, which breaks on new PyAV releases)."""
    import numpy as np

    p = subprocess.run(
        [settings.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-i", str(audio), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True, timeout=600, check=True,
    )
    return np.frombuffer(p.stdout, dtype=np.float32)


def transcribe(audio: Path) -> dict:
    """Local faster-whisper. Model downloads once to HF_HOME (D:/ai-models/hf)."""
    global _whisper
    os.environ.setdefault("HF_HOME", settings.hf_home)
    samples = _pcm16k(audio)
    with _whisper_lock:
        if _whisper is None:
            from faster_whisper import WhisperModel

            _whisper = WhisperModel(settings.whisper_model, device="cpu", compute_type=settings.whisper_compute_type)
        segments, info = _whisper.transcribe(samples, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "language_probability": round(info.language_probability, 3)}


def download_video(url: str, out_dir: Path) -> tuple[Path | None, dict, str | None]:
    """yt-dlp download (<=720p). Returns (path, metadata, error). Cookies (if configured) are never logged."""
    import yt_dlp

    out_dir.mkdir(parents=True, exist_ok=True)
    opts: dict = {
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "format": "bv*[height<=720]+ba/b[height<=720]/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "ffmpeg_location": str(Path(settings.ffmpeg_path).parent) if os.path.sep in settings.ffmpeg_path or "/" in settings.ffmpeg_path else None,
        "socket_timeout": 30,
        # "<=?" lets videos without duration metadata through (common on Instagram)
        "match_filter": yt_dlp.utils.match_filter_func(f"duration <=? {settings.max_video_seconds}"),
    }
    opts = {k: v for k, v in opts.items() if v is not None}
    if settings.ytdlp_cookies_file and Path(settings.ytdlp_cookies_file).is_file():
        opts["cookiefile"] = settings.ytdlp_cookies_file
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:  # noqa: BLE001
        msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))
        return None, {}, msg[:600]
    meta = {
        k: info.get(k)
        for k in ("id", "title", "uploader", "channel", "duration", "view_count", "like_count", "comment_count", "upload_date", "description", "thumbnail", "tags", "width", "height")
        if info.get(k) is not None
    }
    files = sorted(f for f in out_dir.glob("source.*") if f.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov"))
    if not files:
        if (info.get("duration") or 0) > settings.max_video_seconds:
            return None, meta, f"video is longer than {settings.max_video_seconds}s"
        return None, meta, "the platform returned metadata but no downloadable video stream"
    return files[0], meta, None


def download_image(url: str, out: Path) -> Path | None:
    try:
        r = httpx.get(url, timeout=30, follow_redirects=True)
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image/"):
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(r.content)
            return out
    except Exception:  # noqa: BLE001
        pass
    return None


def thumbnail_from_video(video: Path, out: Path) -> Path | None:
    subprocess.run(
        [settings.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y", "-ss", "0.5", "-i", str(video), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", str(out)],
        capture_output=True, timeout=120,
    )
    return out if out.exists() else None
