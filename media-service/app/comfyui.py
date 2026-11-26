"""Minimal ComfyUI API client + workflow templating.

Workflows live in WORKFLOWS_DIR as ComfyUI *API format* JSON. String values may contain tokens:
{{PROMPT}} {{NEGATIVE}} {{SEED}} {{WIDTH}} {{HEIGHT}} {{CHECKPOINT}} {{SVD_CHECKPOINT}}
{{REF_IMAGE}} {{INPUT_IMAGE}} {{FRAMES}} {{FPS}} {{PREFIX}}
A string that is exactly one numeric token (e.g. "{{SEED}}") is replaced by the number itself.
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from .config import get_settings

log = logging.getLogger("media.comfyui")


class ComfyUnavailable(RuntimeError):
    """ComfyUI is down or a workflow is missing (mapped to HTTP 503)."""


class ComfyFailed(RuntimeError):
    """ComfyUI accepted the job but it failed."""


def _client() -> httpx.Client:
    return httpx.Client(base_url=get_settings().comfyui_url, timeout=60)


def available_workflows() -> list[str]:
    d = get_settings().workflows_dir
    return sorted(p.stem for p in d.glob("*.json")) if d.is_dir() else []


def status() -> dict:
    s = get_settings()
    try:
        with _client() as c:
            r = c.get("/system_stats", timeout=5)
            r.raise_for_status()
            info = r.json()
        dev = (info.get("devices") or [{}])[0]
        detail = f"ComfyUI {info.get('system', {}).get('comfyui_version', '')} on {dev.get('name', 'unknown device')}".strip()
        return {"ok": True, "url": s.comfyui_url, "detail": detail, "workflows": available_workflows(), "runnable": runnable_workflows()}
    except Exception as e:
        return {"ok": False, "url": s.comfyui_url, "detail": f"unreachable: {e}", "workflows": available_workflows(), "runnable": []}


# input name → ComfyUI model folder, for checking that a workflow's model files are really installed
_MODEL_INPUTS = {
    "ckpt_name": "checkpoints", "lora_name": "loras", "vae_name": "vae", "unet_name": "diffusion_models",
    "clip_name": "text_encoders", "model_name": "animatediff_models", "ipadapter_file": "ipadapter", "clip_vision": "clip_vision",
}
_runnable_cache: tuple[float, list[str]] = (0.0, [])


def _token_values() -> dict[str, str]:
    s = get_settings()
    return {"CHECKPOINT": s.comfyui_checkpoint, "SVD_CHECKPOINT": s.comfyui_svd_checkpoint, "LCM_LORA": s.comfyui_lcm_lora, "MOTION_MODEL": s.animatediff_motion_model}


def runnable_workflows() -> list[str]:
    """Workflows whose node classes AND model files all exist in the running ComfyUI (cached 60 s).

    A workflow file alone proves nothing: img2vid.json ships with the repo, but without svd_xt.safetensors it cannot run.
    """
    global _runnable_cache
    if time.monotonic() - _runnable_cache[0] < 60:
        return _runnable_cache[1]
    tokens = _token_values()
    out: list[str] = []
    try:
        with _client() as c:
            folders: dict[str, set[str]] = {}
            classes: dict[str, bool] = {}

            def has_model(folder: str, name: str) -> bool:
                if folder not in folders:
                    r = c.get(f"/models/{folder}", timeout=5)
                    folders[folder] = set(r.json()) if r.status_code == 200 else set()
                return name in folders[folder]

            def has_class(cls: str) -> bool:
                if cls not in classes:
                    r = c.get(f"/object_info/{cls}", timeout=5)
                    classes[cls] = r.status_code == 200 and bool(r.json())
                return classes[cls]

            for name in available_workflows():
                graph = json.loads((get_settings().workflows_dir / f"{name}.json").read_text("utf-8"))
                graph.pop("_comment", None)
                ok = True
                for node in graph.values():
                    if not isinstance(node, dict) or not has_class(node.get("class_type", "")):
                        ok = False
                        break
                    for key, val in (node.get("inputs") or {}).items():
                        folder = _MODEL_INPUTS.get(key)
                        if folder and isinstance(val, str):
                            m = re.fullmatch(r"\{\{(\w+)\}\}", val)
                            file = tokens.get(m.group(1), "") if m else val
                            if not file or not has_model(folder, file):
                                ok = False
                                break
                    if not ok:
                        break
                if ok:
                    out.append(name)
    except Exception as e:  # ComfyUI down: nothing is runnable
        log.warning("runnable check failed: %s", e)
        return []
    _runnable_cache = (time.monotonic(), out)
    return out


def load_workflow(name: str, tokens: dict[str, Any]) -> dict:
    path = get_settings().workflows_dir / f"{name}.json"
    if not path.is_file():
        raise ComfyUnavailable(f"ComfyUI workflow '{name}' not found in {path.parent}")
    graph = json.loads(path.read_text("utf-8"))
    graph.pop("_comment", None)

    def sub(v: Any) -> Any:
        if isinstance(v, str):
            for k, val in tokens.items():
                token = "{{" + k + "}}"
                if v == token:
                    return val  # keep numeric types intact
                if token in v:
                    v = v.replace(token, str(val))
            return v
        if isinstance(v, list):
            return [sub(x) for x in v]
        if isinstance(v, dict):
            return {k: sub(x) for k, x in v.items()}
        return v

    return sub(graph)


def upload_image(path: Path) -> str:
    """Uploads an image into ComfyUI's input folder; returns the name to reference in LoadImage."""
    name = f"rf_{uuid.uuid4().hex[:10]}_{path.name}"
    try:
        with _client() as c, path.open("rb") as f:
            r = c.post("/upload/image", files={"image": (name, f, "image/png")}, data={"overwrite": "true", "type": "input"})
            r.raise_for_status()
            return r.json()["name"]
    except httpx.HTTPError as e:
        raise ComfyUnavailable(f"ComfyUI unreachable at {get_settings().comfyui_url}: {e}") from e


def use_fast_vae(graph: dict) -> dict:
    """Decodes with the tiny TAESD decoder instead of the checkpoint VAE (seconds instead of minutes on CPU)."""
    s = get_settings()
    if s.comfyui_vae:
        graph["20vae"] = {"class_type": "VAELoader", "inputs": {"vae_name": s.comfyui_vae}}
        for node in graph.values():
            if node.get("class_type") == "VAEDecode":
                node["inputs"]["vae"] = ["20vae", 0]
    return graph


def run_workflow(graph: dict, timeout_sec: int | None = None) -> list[bytes]:
    """Queues a prompt, waits for it, returns the produced images (in output order)."""
    s = get_settings()
    timeout = timeout_sec or s.comfyui_timeout_sec
    client_id = uuid.uuid4().hex
    try:
        with _client() as c:
            r = c.post("/prompt", json={"prompt": graph, "client_id": client_id})
            if r.status_code == 400:
                raise ComfyFailed(f"ComfyUI rejected the workflow: {r.text[:800]}")
            r.raise_for_status()
            prompt_id = r.json()["prompt_id"]
            deadline = time.monotonic() + timeout
            missing = 0
            while True:
                h = c.get(f"/history/{prompt_id}")
                h.raise_for_status()
                entry = h.json().get(prompt_id)
                if not entry:
                    # ComfyUI restarted/crashed → the prompt is neither queued, running nor finished: fail fast
                    q = c.get("/queue").json()
                    queued = {item[1] for key in ("queue_running", "queue_pending") for item in q.get(key, []) if len(item) > 1}
                    missing = 0 if prompt_id in queued else missing + 1
                    if missing >= 3:
                        raise ComfyUnavailable("ComfyUI lost the job (it crashed or restarted, usually from running out of memory)")
                if entry:
                    st = entry.get("status", {})
                    if st.get("status_str") == "error":
                        msgs = [m for m in st.get("messages", []) if m and m[0] == "execution_error"]
                        raise ComfyFailed(f"ComfyUI execution error: {json.dumps(msgs)[:800]}")
                    if st.get("completed", False) or entry.get("outputs"):
                        break
                if time.monotonic() > deadline:
                    raise ComfyFailed(f"ComfyUI job {prompt_id} timed out after {timeout}s")
                time.sleep(1.5)
            images: list[bytes] = []
            for node_id in sorted(entry["outputs"], key=lambda x: int(x) if str(x).isdigit() else 0):
                for img in entry["outputs"][node_id].get("images", []):
                    if img.get("type") != "output":
                        continue
                    v = c.get("/view", params={"filename": img["filename"], "subfolder": img.get("subfolder", ""), "type": "output"})
                    v.raise_for_status()
                    images.append(v.content)
    except httpx.HTTPError as e:
        raise ComfyUnavailable(f"ComfyUI unreachable at {s.comfyui_url}: {e}") from e
    if not images:
        raise ComfyFailed("ComfyUI finished without producing an image")
    return images


def free_memory() -> bool:
    """Asks ComfyUI to unload its models (call before running the LLM on a RAM-limited machine)."""
    try:
        with _client() as c:
            r = c.post("/free", json={"unload_models": True, "free_memory": True}, timeout=30)
            return r.status_code == 200
    except httpx.HTTPError:
        return False
