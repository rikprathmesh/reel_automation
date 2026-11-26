"""Clips made outside ReelForge (Google Flow / Veo): unpack an uploaded scene clip for the merge step."""
from __future__ import annotations

import re

from .ffmpeg import probe_duration, run_ffmpeg, run_ffmpeg_capture
from .storage import ensure_parent, existing, key_for


def clip_assets(video_key: str, out_prefix: str) -> dict:
    """Duration, whether the clip has sound, its audio track (mono WAV) and a still frame (1080x1920 PNG).

    The audio track goes through the normal voice mix (music is ducked under it) and is transcribed for subtitles;
    the frame is used for the thumbnail and the scene preview.
    """
    src = existing(video_key)
    duration = probe_duration(src)
    if duration <= 0.2:
        raise ValueError(f"{video_key} is too short or not a video")
    info = run_ffmpeg_capture(["-i", str(src)], timeout=60)
    has_video = bool(re.search(r"Stream #\S+.*: Video:", info))
    if not has_video:
        raise ValueError(f"{video_key} has no video stream")
    has_audio = bool(re.search(r"Stream #\S+.*: Audio:", info))

    frame = ensure_parent(f"{out_prefix}_frame.png")
    at = min(0.5, duration / 2)
    run_ffmpeg(["-ss", f"{at:.2f}", "-i", str(src), "-frames:v", "1",
                "-vf", "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920", str(frame)])
    audio_key = None
    if has_audio:
        audio = ensure_parent(f"{out_prefix}_audio.wav")
        run_ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(audio)])
        audio_key = key_for(audio)
    return {"duration": round(duration, 3), "has_audio": has_audio, "audio_key": audio_key, "frame_key": key_for(frame)}
