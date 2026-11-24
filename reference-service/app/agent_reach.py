"""Agent Reach CLI integration (https://github.com/Panniantong/Agent-Reach, installed via `uv tool install`).

Every Agent Reach >=1.6 command prints one JSON object. We only call read-only commands.
"""

import json
import logging
import re
import subprocess

from .config import settings

log = logging.getLogger("agent-reach")


def _run(args: list[str], timeout: int = 180) -> dict:
    proc = subprocess.run(
        [settings.agent_reach_path, *args],
        capture_output=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )
    out = (proc.stdout or "").lstrip("﻿").strip()
    if not out:
        raise RuntimeError(f"agent-reach produced no output (exit {proc.returncode})")
    return json.loads(out)


def version() -> str | None:
    try:
        d = _run(["version"], timeout=30)
        return (d.get("result") or {}).get("version")
    except Exception:  # noqa: BLE001 - health check
        return None


_IMG = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)")


def read(url: str) -> dict:
    """`agent-reach read <url>`: picks the matching channel (for Instagram reels: the public web reader).

    Returns {ok, channel, backend, title, author, text, image_url, error}. Text content only — it never
    includes a downloadable video.
    """
    try:
        d = _run(["read", url])
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"Agent Reach failed: {e}"}
    if not d.get("ok"):
        err = d.get("error") or {}
        return {"ok": False, "error": f"Agent Reach: {err.get('message') or 'unknown error'}"}
    items = d.get("items") or []
    item = items[0] if items else {}
    text = item.get("text") or ""
    m = _IMG.search(text)
    clean = _IMG.sub("", text).strip()
    return {
        "ok": True,
        "channel": d.get("channel"),
        "backend": d.get("backend"),
        "title": item.get("title"),
        "author": item.get("author"),
        "text": clean[:20000] or None,
        "image_url": m.group(1) if m else None,
        "error": None,
    }
