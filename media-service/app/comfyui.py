"""Minimal ComfyUI API client + workflow templating.

Workflows live in WORKFLOWS_DIR as ComfyUI *API format* JSON. String values may contain tokens:
{{PROMPT}} {{NEGATIVE}} {{SEED}} {{WIDTH}} {{HEIGHT}} {{CHECKPOINT}} {{SVD_CHECKPOINT}}
{{REF_IMAGE}} {{INPUT_IMAGE}} {{FRAMES}} {{FPS}} {{PREFIX}}
A string that is exactly one numeric token (e.g. "{{SEED}}") is replaced by the number itself.
"""
from __future__ import annotations

import json
import logging
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
        return {"ok": True, "url": s.comfyui_url, "detail": detail, "workflows": available_workflows()}
    except Exception as e:
        return {"ok": False, "url": s.comfyui_url, "detail": f"unreachable: {e}", "workflows": available_workflows()}


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


def run_workflow(graph: dict) -> list[bytes]:
    """Queues a prompt, waits for it, returns the produced images (in output order)."""
    s = get_settings()
    client_id = uuid.uuid4().hex
    try:
        with _client() as c:
            r = c.post("/prompt", json={"prompt": graph, "client_id": client_id})
            if r.status_code == 400:
                raise ComfyFailed(f"ComfyUI rejected the workflow: {r.text[:800]}")
            r.raise_for_status()
            prompt_id = r.json()["prompt_id"]
            deadline = time.monotonic() + s.comfyui_timeout_sec
            while True:
                h = c.get(f"/history/{prompt_id}")
                h.raise_for_status()
                entry = h.json().get(prompt_id)
                if entry:
                    st = entry.get("status", {})
                    if st.get("status_str") == "error":
                        msgs = [m for m in st.get("messages", []) if m and m[0] == "execution_error"]
                        raise ComfyFailed(f"ComfyUI execution error: {json.dumps(msgs)[:800]}")
                    if st.get("completed", False) or entry.get("outputs"):
                        break
                if time.monotonic() > deadline:
                    raise ComfyFailed(f"ComfyUI job {prompt_id} timed out after {s.comfyui_timeout_sec}s")
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
