"""Maps storage keys (POSIX relative paths) to files under STORAGE_ROOT."""
from __future__ import annotations

from pathlib import Path, PurePosixPath

from .config import get_settings


class StorageKeyError(ValueError):
    pass


def _root() -> Path:
    return get_settings().storage_root.resolve()


def path_for(key: str) -> Path:
    """Absolute path for a key. Rejects absolute keys and traversal outside the root."""
    if not key or key.startswith(("/", "\\")) or ":" in key:
        raise StorageKeyError(f"Invalid storage key: {key!r}")
    pure = PurePosixPath(key.replace("\\", "/"))
    if any(part in ("..", "") for part in pure.parts):
        raise StorageKeyError(f"Invalid storage key: {key!r}")
    root = _root()
    p = (root / Path(*pure.parts)).resolve()
    if root != p and root not in p.parents:
        raise StorageKeyError(f"Storage key escapes root: {key!r}")
    return p


def existing(key: str) -> Path:
    p = path_for(key)
    if not p.is_file():
        raise FileNotFoundError(f"Storage key not found: {key}")
    return p


def ensure_parent(key: str) -> Path:
    p = path_for(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def key_for(path: Path) -> str:
    rel = path.resolve().relative_to(_root())
    return rel.as_posix()
