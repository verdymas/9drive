"""Configuration for telegram-stream. Reads env at import time, validates via pydantic."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="TELEGRAM_STREAM_",
        env_file=None,
        extra="ignore",
        case_sensitive=False,
    )

    host: str = "0.0.0.0"
    port: int = 8081

    # HMAC shared secret with the 9Drive backend. Required in production.
    internal_secret: str = ""

    # 9Drive backend base URL, for the credentials control plane
    # (e.g. http://backend:4000). Required in production.
    backend_url: str = ""

    # Tuning. Telethon floors a download request to 4 KiB and caps it at
    # 512 KiB, so 512 KiB is both the default and the ceiling that matters.
    chunk_size_bytes: int = 512 * 1024
    log_level: str = "info"

    # HMAC clock-skew window in seconds.
    signature_max_skew_seconds: int = 30


settings = Settings()
