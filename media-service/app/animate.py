"""Scene animation: deterministic Ken Burns motion (ffmpeg) or generative img2vid (ComfyUI SVD)."""
from __future__ import annotations

import logging
import shutil
import zlib
import tempfile
from pathlib import Path

from . import comfyui
from .config import get_settings
from .ffmpeg import run_ffmpeg
from .storage import ensure_parent, existing, key_for

log = logging.getLogger("media.animate")

CAMERAS = ("zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "static")


def ken_burns(image: Path, duration: float, camera: str, out: Path) -> None:
    s = get_settings()
    W, H, FPS = s.video_width, s.video_height, s.video_fps
    frames = max(1, round(duration * FPS))
    SW, SH = round(W * 1.5), round(H * 1.5)
    center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    p = f"(on/{frames})"
    motion = {
        "zoom_in": f"z='1+0.18*{p}':{center}",
        "zoom_out": f"z='1.18-0.18*{p}':{center}",
        "pan_left": f"z='1.15':x='(iw-iw/zoom)*(1-{p})':y='ih/2-(ih/zoom/2)'",
        "pan_right": f"z='1.15':x='(iw-iw/zoom)*{p}':y='ih/2-(ih/zoom/2)'",
        "pan_up": f"z='1.15':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-{p})'",
        "pan_down": f"z='1.15':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*{p}'",
        "static": f"z='1.04+0.02*{p}':{center}",
    }[camera]
    run_ffmpeg([
        "-loop", "1", "-framerate", str(FPS), "-i", str(image),
        "-vf", f"scale={SW}:{SH}:force_original_aspect_ratio=increase,crop={SW}:{SH},zoompan={motion}:d=1:s={W}x{H}:fps={FPS},setsar=1,format=yuv420p",
        "-frames:v", str(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(out),
    ])


def normalize_clip(src: Path, duration: float, out: Path, input_args: list[str] | None = None) -> None:
    """Any clip/frame sequence → 1080x1920@30, exact duration, no audio (loops if shorter)."""
    s = get_settings()
    W, H, FPS = s.video_width, s.video_height, s.video_fps
    run_ffmpeg([
        *(input_args or ["-stream_loop", "-1"]), "-i", str(src), "-t", f"{duration:.3f}", "-an",
        "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},setsar=1,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(out),
    ])


def comfy_img2vid(image: Path, duration: float, prompt: str, out: Path) -> None:
    """Stable Video Diffusion via ComfyUI: frames are saved as PNGs and assembled here with ffmpeg."""
    s = get_settings()
    frames = 25
    gen_fps = max(1, round(frames / max(duration, 0.5)))  # stretch the generated motion over the scene
    tokens = {
        "INPUT_IMAGE": comfyui.upload_image(image), "FRAMES": frames, "FPS": min(gen_fps, 30), "SEED": zlib.crc32(prompt.encode()) % (2**31),
        "SVD_CHECKPOINT": s.comfyui_svd_checkpoint, "PROMPT": prompt, "PREFIX": "reelforge_vid",
        "WIDTH": 576, "HEIGHT": 1024,
    }
    images = comfyui.run_workflow(comfyui.load_workflow("img2vid", tokens))
    if len(images) < 2:
        raise comfyui.ComfyFailed("img2vid produced fewer than 2 frames")
    td = Path(tempfile.mkdtemp())
    try:
        for i, data in enumerate(images):
            (td / f"f_{i:04d}.png").write_bytes(data)
        normalize_clip(td / "f_%04d.png", duration, out, input_args=["-framerate", f"{len(images) / max(duration, 0.5):.4f}"])
    finally:
        shutil.rmtree(td, ignore_errors=True)


def animate(image_key: str, duration: float, camera: str, prompt: str, mode: str, out_key: str) -> dict:
    if camera not in CAMERAS:
        raise ValueError(f"Unknown camera move: {camera}")
    if duration <= 0 or duration > 120:
        raise ValueError("duration must be between 0 and 120 seconds")
    image = existing(image_key)
    out = ensure_parent(out_key)
    used = "kenburns"
    if mode == "comfyui":
        if "img2vid" in comfyui.available_workflows():
            comfy_img2vid(image, duration, prompt, out)  # errors propagate: no silent downgrade on failure
            used = "comfyui"
        else:
            log.warning("img2vid workflow missing; using Ken Burns (reported in response)")
            ken_burns(image, duration, camera, out)
    else:
        ken_burns(image, duration, camera, out)
    return {"key": key_for(out), "mode": used}
