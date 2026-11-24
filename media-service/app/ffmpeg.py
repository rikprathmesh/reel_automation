"""Thin, shell-free wrappers around ffmpeg/ffprobe."""
from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path

from .config import ffmpeg_bin, ffprobe_bin

log = logging.getLogger("media.ffmpeg")


class FFmpegError(RuntimeError):
    pass


def run_ffmpeg(args: list[str], cwd: Path | None = None, timeout: int = 1800) -> None:
    cmd = [ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y", *args]
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    if res.returncode != 0:
        raise FFmpegError(f"ffmpeg exited {res.returncode}: {res.stderr[-1500:]}")


def run_ffmpeg_capture(args: list[str], timeout: int = 600) -> str:
    """Runs ffmpeg with info-level logging and returns stderr (for filters such as showinfo)."""
    cmd = [ffmpeg_bin(), "-hide_banner", *args]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    return res.stderr


def probe_duration(path: Path) -> float:
    probe = ffprobe_bin()
    if probe:
        res = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        try:
            return float(res.stdout.strip())
        except ValueError as e:
            raise FFmpegError(f"Could not probe duration of {path.name}") from e
    # no ffprobe: parse ffmpeg's banner
    err = run_ffmpeg_capture(["-i", str(path)], timeout=60)
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if not m:
        raise FFmpegError(f"Could not probe duration of {path.name}")
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def ffmpeg_available() -> bool:
    try:
        subprocess.run([ffmpeg_bin(), "-version"], capture_output=True, timeout=20, check=True)
        return True
    except Exception:
        return False
