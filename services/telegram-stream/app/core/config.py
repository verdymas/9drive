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

    # Tuning. Conservative defaults; tune only after Phase 10/11 measurements.
    chunk_size_bytes: int = 1 * 1024 * 1024  # 1 MiB
    prefetch: int = 3
    parallelism: int = 2
    log_level: str = "info"

    # HMAC clock-skew window in seconds.
    signature_max_skew_seconds: int = 30


settings = Settings()
