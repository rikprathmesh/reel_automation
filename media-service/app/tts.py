"""Local text-to-speech (Kokoro or Piper) with word timings aligned by faster-whisper."""
from __future__ import annotations

import logging
import threading
import wave
from pathlib import Path
from typing import Any

from . import whisper
from .config import get_settings
from .ffmpeg import probe_duration
from .storage import ensure_parent, key_for

log = logging.getLogger("media.tts")

KOKORO_VOICES: list[tuple[str, str, str]] = [
    ("af_heart", "Heart (US female)", "en-us"), ("af_bella", "Bella (US female)", "en-us"), ("af_nicole", "Nicole (US female, soft)", "en-us"),
    ("af_sky", "Sky (US female)", "en-us"), ("af_nova", "Nova (US female)", "en-us"), ("am_michael", "Michael (US male)", "en-us"),
    ("am_adam", "Adam (US male)", "en-us"), ("am_fenrir", "Fenrir (US male, deep)", "en-us"), ("am_puck", "Puck (US male, playful)", "en-us"),
    ("bf_emma", "Emma (UK female)", "en-gb"), ("bf_isabella", "Isabella (UK female)", "en-gb"), ("bm_george", "George (UK male)", "en-gb"),
    ("bm_fable", "Fable (UK male, storyteller)", "en-gb"), ("bm_lewis", "Lewis (UK male)", "en-gb"),
    ("hf_alpha", "Alpha (Hindi female)", "hi"), ("hf_beta", "Beta (Hindi female)", "hi"),
    ("hm_omega", "Omega (Hindi male)", "hi"), ("hm_psi", "Psi (Hindi male)", "hi"),
]
KOKORO_SAMPLE_RATE = 24000


class TTSUnavailable(RuntimeError):
    pass


_kokoro_pipelines: dict[str, Any] = {}
_kokoro_lock = threading.Lock()
_piper_voices: dict[str, Any] = {}


def _kokoro_pipeline(lang_code: str) -> Any:
    with _kokoro_lock:
        if lang_code not in _kokoro_pipelines:
            try:
                from kokoro import KPipeline
            except Exception as e:
                raise TTSUnavailable(f"Kokoro is not installed: {e}") from e
            _kokoro_pipelines[lang_code] = KPipeline(lang_code=lang_code)
        return _kokoro_pipelines[lang_code]


def kokoro_available() -> bool:
    try:
        import kokoro  # noqa: F401

        return True
    except Exception:
        return False


def piper_models() -> list[Path]:
    d = get_settings().piper_voices_dir
    return sorted(d.glob("*.onnx")) if d.is_dir() else []


def piper_available() -> bool:
    try:
        import piper  # noqa: F401
    except Exception:
        return False
    return bool(piper_models())


def list_voices() -> list[dict]:
    out: list[dict] = []
    if kokoro_available():
        out += [{"engine": "kokoro", "id": v, "name": n, "language": lang} for v, n, lang in KOKORO_VOICES]
    if piper_available():
        for m in piper_models():
            # piper model names look like en_US-lessac-medium
            lang = m.stem.split("-")[0].replace("_", "-").lower()
            out.append({"engine": "piper", "id": m.stem, "name": m.stem.replace("-", " "), "language": lang})
    return out


def kokoro_lang(voice: str, language: str | None) -> str:
    """Kokoro pipeline (G2P) language: 'h' Hindi for Devanagari scripts, otherwise the voice's English variant.
    Hinglish is written in Roman script, so it uses the English pipeline."""
    if language == "hi":
        return "h"
    return voice[0] if voice[:1] in ("a", "b") else get_settings().kokoro_lang_code


def _synth_kokoro(text: str, voice: str | None, speed: float, out: Path, language: str | None) -> str:
    import numpy as np
    import soundfile as sf

    voice = voice or get_settings().kokoro_default_voice
    lang = kokoro_lang(voice, language)
    pipeline = _kokoro_pipeline(lang)
    chunks = [np.asarray(audio, dtype="float32") for _, _, audio in pipeline(text, voice=voice, speed=speed) if audio is not None]
    if not chunks:
        raise RuntimeError("Kokoro produced no audio")
    audio = np.concatenate(chunks)
    if float(np.abs(audio).max()) < 1e-4:
        raise RuntimeError("Kokoro produced silent audio")
    sf.write(str(out), audio, KOKORO_SAMPLE_RATE)
    return voice


def _synth_piper(text: str, voice: str | None, speed: float, out: Path) -> str:
    try:
        from piper import PiperVoice
    except Exception as e:
        raise TTSUnavailable(f"Piper is not installed: {e}") from e
    models = {m.stem: m for m in piper_models()}
    if not models:
        raise TTSUnavailable(f"No Piper voice models (*.onnx) in {get_settings().piper_voices_dir}")
    name = voice if voice in models else (get_settings().piper_default_voice or next(iter(models)))
    if name not in _piper_voices:
        _piper_voices[name] = PiperVoice.load(str(models[name]))
    pv = _piper_voices[name]
    with wave.open(str(out), "wb") as wf:
        # piper-tts >= 1.3 API; length_scale < 1 speaks faster
        try:
            from piper import SynthesisConfig

            pv.synthesize_wav(text, wf, syn_config=SynthesisConfig(length_scale=1.0 / max(speed, 0.1)))
        except ImportError:  # older piper-tts
            pv.synthesize(text, wf, length_scale=1.0 / max(speed, 0.1))
    if out.stat().st_size < 1000:
        raise RuntimeError("Piper produced no audio")
    return name


def estimate_words(text: str, duration: float, lead: float = 0.05) -> list[dict]:
    words = text.split()
    weights = [len(w) + 2 for w in words]
    total = sum(weights) or 1
    usable = max(0.1, duration - lead * 2)
    t = lead
    out = []
    for w, wt in zip(words, weights):
        d = wt / total * usable
        out.append({"word": w, "start": round(t, 3), "end": round(t + d, 3)})
        t += d
    return out


def _norm(w: str) -> str:
    return "".join(ch for ch in w.lower() if ch.isalnum())


def align_script_words(text: str, recognised: list[dict], duration: float) -> list[dict]:
    """Keeps the script's exact words (captions must match the script) and takes timings from whisper.

    Words are matched greedily by normalised text; unmatched script words are interpolated between
    their matched neighbours.
    """
    script = text.split()
    if not script:
        return []
    times: list[tuple[float, float] | None] = [None] * len(script)
    j = 0
    for i, w in enumerate(script):
        nw = _norm(w)
        for k in range(j, min(j + 4, len(recognised))):
            if nw and _norm(recognised[k]["word"]) == nw:
                times[i] = (recognised[k]["start"], recognised[k]["end"])
                j = k + 1
                break
    if not any(times):
        if len(recognised) == len(script):
            return [{"word": w, "start": r["start"], "end": r["end"]} for w, r in zip(script, recognised)]
        return estimate_words(text, duration)
    out: list[dict] = []
    i = 0
    while i < len(script):
        if times[i] is not None:
            s, e = times[i]  # type: ignore[misc]
            out.append({"word": script[i], "start": s, "end": e})
            i += 1
            continue
        # run of unmatched words between prev end and next matched start
        j = i
        while j < len(script) and times[j] is None:
            j += 1
        start = out[-1]["end"] if out else 0.05
        end = times[j][0] if j < len(script) else max(start + 0.2, duration - 0.05)  # type: ignore[index]
        span = max(0.05, end - start)
        n = j - i
        for k in range(n):
            out.append({"word": script[i + k], "start": round(start + span * k / n, 3), "end": round(start + span * (k + 1) / n, 3)})
        i = j
    return out


def synthesize(text: str, engine: str | None, voice: str | None, speed: float, out_key: str, language: str | None = None) -> dict:
    text = text.strip()
    if not text:
        raise ValueError("text is empty")
    engine = engine or get_settings().tts_engine
    out = ensure_parent(f"{out_key}.wav")
    if engine == "kokoro":
        used_voice = _synth_kokoro(text, voice, speed, out, language)
    elif engine == "piper":
        used_voice = _synth_piper(text, voice, speed, out)
    else:
        raise ValueError(f"Unknown TTS engine: {engine}")
    duration = probe_duration(out)
    try:
        recognised = whisper.word_timings(out, language={"en": "en", "hi": "hi"}.get(language or ""))
        if not recognised:
            raise RuntimeError("no words recognised")
        words = align_script_words(text, recognised, duration)
    except Exception as e:  # timing only; the audio itself is real
        log.warning("whisper alignment failed (%s); using proportional word timing", e)
        words = estimate_words(text, duration)
    return {"key": key_for(out), "duration": round(duration, 3), "engine": engine, "voice": used_voice, "words": words}
