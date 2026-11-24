"""Scene / character image generation through ComfyUI. No placeholder fallback."""
from __future__ import annotations

import random
import tempfile
from pathlib import Path

from . import comfyui
from .config import get_settings
from .ffmpeg import run_ffmpeg
from .storage import ensure_parent, existing, key_for

DEFAULT_NEGATIVE = "text, letters, watermark, logo, signature, blurry, deformed, extra limbs, bad anatomy, lowres, jpeg artifacts"


def generate(prompt: str, negative: str | None, reference_keys: list[str], seed: int, width: int, height: int, out_key: str) -> dict:
    s = get_settings()
    refs = [existing(k) for k in reference_keys]
    use_ref = bool(refs) and "txt2img_ref" in comfyui.available_workflows()
    workflow = "txt2img_ref" if use_ref else "txt2img"

    # Generate at a model-friendly size with the requested aspect ratio, then scale to the exact output size.
    aspect = width / height
    if aspect < 1:
        gw, gh = s.image_gen_width, s.image_gen_height
    elif aspect > 1:
        gw, gh = s.image_gen_height, s.image_gen_width
    else:
        gw = gh = 768
    tokens = {
        "PROMPT": prompt, "NEGATIVE": negative or DEFAULT_NEGATIVE, "SEED": int(seed) % (2**31) or random.randint(1, 2**31 - 1),
        "WIDTH": gw, "HEIGHT": gh, "CHECKPOINT": s.comfyui_checkpoint, "PREFIX": "reelforge",
        "LCM_LORA": s.comfyui_lcm_lora, "STEPS": s.comfyui_steps, "REF_WEIGHT": s.comfyui_ref_weight,
    }
    if use_ref:
        # IPAdapter takes one image; with several characters use a horizontal strip of their sheets.
        tokens["REF_IMAGE"] = comfyui.upload_image(refs[0] if len(refs) == 1 else _ref_strip(refs))
    graph = comfyui.load_workflow(workflow, tokens)
    data = comfyui.run_workflow(graph)[0]

    out = ensure_parent(out_key)
    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / "raw.png"
        raw.write_bytes(data)
        run_ffmpeg(["-i", str(raw), "-vf", f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,crop={width}:{height}", "-frames:v", "1", str(out)])
    return {"key": key_for(out), "workflow": workflow}


def _ref_strip(refs: list[Path]) -> Path:
    out = Path(tempfile.mkdtemp()) / "ref_strip.png"
    inputs: list[str] = []
    for r in refs[:4]:
        inputs += ["-i", str(r)]
    n = min(len(refs), 4)
    scaled = ";".join(f"[{i}:v]scale=-2:768[s{i}]" for i in range(n))
    stack = "".join(f"[s{i}]" for i in range(n)) + f"hstack=inputs={n}"
    run_ffmpeg([*inputs, "-filter_complex", f"{scaled};{stack}", "-frames:v", "1", str(out)])
    return out
