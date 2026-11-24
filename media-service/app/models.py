"""Request/response models — mirror docs/CONTRACTS.md §2 exactly."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Camera = Literal["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "static"]
Transition = Literal["fade", "fadeblack", "slideleft", "slideup", "wipeleft", "circleopen", "dissolve", "smoothup"]


class Word(BaseModel):
    word: str
    start: float
    end: float


# --- health / voices ---
class ComfyStatus(BaseModel):
    ok: bool
    url: str
    detail: str
    workflows: list[str]


class TTSStatus(BaseModel):
    kokoro: bool
    piper: bool
    default_engine: str


class WhisperStatus(BaseModel):
    ok: bool
    model: str
    detail: str | None = None


class Health(BaseModel):
    ffmpeg: bool
    comfyui: ComfyStatus
    tts: TTSStatus
    whisper: WhisperStatus


class Voice(BaseModel):
    engine: str
    id: str
    name: str
    language: str


# --- tts ---
class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    engine: Literal["kokoro", "piper"] | None = None
    voice: str | None = None
    speed: float = Field(1.0, gt=0.3, le=3.0)
    language: Literal["en", "hi", "hinglish"] | None = None
    out_key: str


class TranscribeRequest(BaseModel):
    key: str
    language: str | None = None


class TranscribeResponse(BaseModel):
    text: str
    language: str
    words: list[Word]


class TTSResponse(BaseModel):
    key: str
    duration: float
    engine: str
    voice: str
    words: list[Word]


# --- image ---
class ImageRequest(BaseModel):
    prompt: str = Field(min_length=1)
    negative_prompt: str | None = None
    reference_keys: list[str] = []
    seed: int = 0
    width: int = Field(1080, ge=256, le=4096)
    height: int = Field(1920, ge=256, le=4096)
    out_key: str


class ImageResponse(BaseModel):
    key: str
    workflow: Literal["txt2img", "txt2img_ref"]


# --- animate ---
class AnimateRequest(BaseModel):
    image_key: str
    duration: float = Field(gt=0, le=120)
    camera: Camera = "static"
    prompt: str = ""
    mode: Literal["kenburns", "comfyui"] = "kenburns"
    out_key: str


class AnimateResponse(BaseModel):
    key: str
    mode: Literal["kenburns", "comfyui"]


# --- library ---
class LibraryRequest(BaseModel):
    kind: Literal["music", "sfx"]
    query: str = ""
    salt: str = ""


class LibraryResponse(BaseModel):
    key: str | None


# --- compose ---
class TimelineScene(BaseModel):
    clip_key: str
    duration: float = Field(gt=0)
    start: float = Field(ge=0)
    transition: Transition = "fade"
    transition_sec: float = Field(0.45, ge=0)
    on_screen_text: str = ""
    sfx_key: str | None = None


class TimelineVoice(BaseModel):
    key: str
    start: float = Field(ge=0)
    duration: float = Field(gt=0)
    words: list[Word] = []


class ComposeRequest(BaseModel):
    work_key: str
    scenes: list[TimelineScene]
    voices: list[TimelineVoice] = []
    music_key: str | None = None
    whoosh_key: str | None = None
    end_card: str = ""
    total_sec: float = Field(gt=0, le=600)
    out_key: str


class Validation(BaseModel):
    ok: bool
    problems: list[str]
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    duration: float | None = None
    black_ratio: float | None = None


class ComposeResponse(BaseModel):
    key: str
    duration: float
    validation: Validation


# --- thumbnail / probe ---
class ThumbnailRequest(BaseModel):
    image_key: str
    text: str = ""
    out_key: str


class KeyResponse(BaseModel):
    key: str


class ProbeRequest(BaseModel):
    key: str


class ProbeResponse(BaseModel):
    duration: float
