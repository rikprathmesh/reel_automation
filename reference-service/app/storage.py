from pathlib import Path

from .config import settings


def root() -> Path:
    r = settings.storage_root.resolve()
    r.mkdir(parents=True, exist_ok=True)
    return r


def key_path(key: str) -> Path:
    """Resolve a storage key to a path inside the storage root; reject traversal."""
    k = key.replace("\\", "/").lstrip("/")
    parts = k.split("/")
    if not k or any(p in ("", ".", "..") for p in parts) or ":" in parts[0]:
        raise ValueError(f"Invalid storage key: {key}")
    p = (root() / k).resolve()
    if root() not in p.parents:
        raise ValueError("Storage key escapes the storage root")
    return p


def to_key(p: Path) -> str:
    return p.resolve().relative_to(root()).as_posix()
