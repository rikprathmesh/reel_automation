from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment configuration (reference-service/.env). Secrets here are never logged or returned."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    storage_root: Path = Path("../storage")
    service_token: str = ""
    agent_reach_path: str = str(Path.home() / ".local" / "bin" / "agent-reach.exe")
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    # Netscape cookies.txt exported from YOUR logged-in browser; lets yt-dlp read reels Instagram hides from anonymous users.
    ytdlp_cookies_file: str = ""
    whisper_model: str = "small"
    whisper_compute_type: str = "int8"
    hf_home: str = "D:/ai-models/hf"
    max_video_seconds: int = 600
    frames_to_sample: int = 8


settings = Settings()
