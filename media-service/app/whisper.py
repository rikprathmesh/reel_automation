"""faster-whisper: transcription and word-level alignment. The model is loaded lazily, once.

Audio is decoded with FFmpeg and passed as samples: faster-whisper's own PyAV decoder breaks on
current PyAV releases ("unexpected keyword argument 'metadata_errors'").
"""
from __future__ import annotations

import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

from .config import ffmpeg_bin, get_settings

log = logging.getLogger("media.whisper")
_model: Any = None
_lock = threading.Lock()
_load_error: str | None = None


def get_model() -> Any:
    global _model, _load_error
    with _lock:
        if _model is None:
            s = get_settings()
            os.environ.setdefault("HF_HOME", s.hf_home)
            try:
                from faster_whisper import WhisperModel  # heavy import, deferred

                device = s.whisper_device
                compute = s.whisper_compute_type
                if device == "auto":
                    try:
                        import ctranslate2

                        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
                    except Exception:
                        device = "cpu"
                if device == "cuda" and compute == "int8":
                    compute = "int8_float16"
                log.info("loading faster-whisper model=%s device=%s compute=%s", s.whisper_model, device, compute)
                _model = WhisperModel(s.whisper_model, device=device, compute_type=compute)
                _load_error = None
            except Exception as e:
                _load_error = f"{type(e).__name__}: {e}"
                raise
        return _model


def status() -> dict:
    s = get_settings()
    if _model is not None:
        return {"ok": True, "model": s.whisper_model}
    try:
        import faster_whisper  # noqa: F401

        return {"ok": _load_error is None, "model": s.whisper_model, **({"detail": _load_error} if _load_error else {})}
    except Exception as e:
        return {"ok": False, "model": s.whisper_model, "detail": f"faster-whisper not installed: {e}"}


def pcm16k(path: Path):
    import numpy as np

    p = subprocess.run(
        [ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True, timeout=900, check=True,
    )
    return np.frombuffer(p.stdout, dtype=np.float32)


def _words(segments) -> list[dict]:
    words: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"word": text, "start": round(float(w.start), 3), "end": round(float(w.end), 3)})
    return words


def transcribe(path: Path, language: str | None = None) -> dict:
    model = get_model()
    segments, info = model.transcribe(pcm16k(path), language=language, word_timestamps=True, vad_filter=True)
    segments = list(segments)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return {"text": text, "language": info.language, "words": _words(segments)}


def word_timings(path: Path, language: str | None = None) -> list[dict]:
    model = get_model()
    segments, _info = model.transcribe(pcm16k(path), word_timestamps=True, language=language, vad_filter=False)
    return _words(segments)
