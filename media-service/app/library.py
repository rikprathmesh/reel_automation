"""Keyword-matched picks from the music / SFX library in storage (library/music, library/sfx)."""
from __future__ import annotations

import hashlib
import json
import re

from .storage import key_for, path_for

AUDIO_EXT = re.compile(r"\.(mp3|wav|m4a|ogg|flac)$", re.I)


def _tokens(s: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if len(t) > 2]


def pick(kind: str, query: str, salt: str = "") -> str | None:
    """Returns the storage key of the best-matching file, or None.

    Files are matched by keywords in their names (e.g. uplifting_piano_warm.mp3) plus optional
    tags from library/<kind>/library.json ({"file.mp3": "mood tags"}). SFX require at least one
    keyword hit so a random effect is never played.
    """
    if kind not in ("music", "sfx"):
        raise ValueError("kind must be music or sfx")
    d = path_for(f"library/{kind}")
    if not d.is_dir():
        return None
    files = sorted(f for f in d.iterdir() if f.is_file() and AUDIO_EXT.search(f.name))
    if not files:
        return None
    tags: dict[str, str] = {}
    lib = d / "library.json"
    if lib.is_file():
        try:
            tags = json.loads(lib.read_text("utf-8"))
        except (ValueError, OSError):
            tags = {}
    q = set(_tokens(query))
    scored: list[tuple[float, str]] = []
    for f in files:
        toks = _tokens(f"{f.name} {tags.get(f.name, '')}")
        score = sum(1 for t in toks if t in q)
        # deterministic tiebreak so different reels get different tracks
        tie = hashlib.md5((f.name + salt).encode()).digest()[0] / 255
        scored.append((score + tie * 0.5, f.name))
    scored.sort(reverse=True)
    best_score, best = scored[0]
    if kind == "sfx" and best_score < 1:
        return None
    return key_for(d / best)
