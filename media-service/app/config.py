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
    # VAE used to decode images: "taesd" (tiny decoder, ~1 s on CPU instead of minutes; models/vae_approx/taesd_*.pth)
    # or "" for the checkpoint's own VAE (slightly sharper, very slow on CPU)
    comfyui_vae: str = "taesd"
    # LCM guidance. 1.0 skips the negative-prompt pass entirely (half the UNet work per step on CPU); 1.5 = old behaviour
    comfyui_cfg: float = 1.0
    comfyui_ref_weight: float = 0.7
    # fraction of sampling done before character references apply (0 = from the start: references then dictate pose and
    # backdrop, which made every scene a portrait on the model sheet's grey background, observed 2026-11-26)
    comfyui_ref_start: float = 0.3
    comfyui_svd_checkpoint: str = "svd_xt.safetensors"
    # real AI animation (AnimateDiff v3 motion module, Apache-2.0) on the SD1.5 checkpoint + LCM-LoRA
    animatediff_motion_model: str = "v3_sd15_mm.ckpt"
    animatediff_frames: int = 16  # 16 frames = 2 s of motion at 8 fps (one AnimateDiff context window)
    animatediff_fps: int = 8
    animatediff_steps: int = 4
    animatediff_cfg: float = 1.0
    animatediff_denoise: float = 0.65  # how far each frame may move away from the keyframe
    animatediff_width: int = 256  # 384x672 ran out of memory on this 16 GB CPU laptop (measured 2026-11-26)
    animatediff_height: int = 448
    animatediff_timeout_sec: int = 7200
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
