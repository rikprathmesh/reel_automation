"""Environment-based configuration for the media service."""
from __future__ import annotations

import shutil
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    storage_root: Path = SERVICE_DIR.parent / "storage"
    service_token: str = ""
    max_concurrent_jobs: int = 2
    log_level: str = "INFO"

    # binaries
    ffmpeg_path: str = ""
    ffprobe_path: str = ""

    # ComfyUI
    comfyui_url: str = "http://127.0.0.1:8188"
    comfyui_checkpoint: str = "DreamShaper_8_pruned.safetensors"
    comfyui_lcm_lora: str = "lcm-lora-sdv1-5.safetensors"
    comfyui_steps: int = 6
    comfyui_ref_weight: float = 0.7
    comfyui_svd_checkpoint: str = "svd_xt.safetensors"
    comfyui_timeout_sec: int = 1800
    workflows_dir: Path = SERVICE_DIR / "workflows"
    image_gen_width: int = 512
    image_gen_height: int = 912

    # speech
    tts_engine: str = "kokoro"  # kokoro | piper
    kokoro_default_voice: str = "af_heart"
    kokoro_lang_code: str = "a"  # a = American English, b = British English
    piper_voices_dir: Path = SERVICE_DIR / "voices" / "piper"
    piper_default_voice: str = ""
    whisper_model: str = "small"
    whisper_device: str = "auto"  # auto | cpu | cuda
    whisper_compute_type: str = "int8"
    hf_home: str = "D:/ai-models/hf"

    # output video
    video_width: int = 1080
    video_height: int = 1920
    video_fps: int = 30


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.storage_root.mkdir(parents=True, exist_ok=True)
    return s


@lru_cache
def ffmpeg_bin() -> str:
    s = get_settings()
    if s.ffmpeg_path:
        return s.ffmpeg_path
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:  # bundled fallback for local dev without system ffmpeg
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # pragma: no cover
        raise RuntimeError("ffmpeg not found: install it or set FFMPEG_PATH") from e


@lru_cache
def ffprobe_bin() -> str | None:
    s = get_settings()
    if s.ffprobe_path:
        return s.ffprobe_path
    return shutil.which("ffprobe")
