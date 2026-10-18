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

    # Read-ahead depth for `iter_bytes` (P2 in the roadmap). Parsed and
    # clamped for /ready visibility, but NOT consumed by the data path yet:
    # 0 keeps today's strictly sequential reads (one in-flight RPC per stream).
    prefetch_depth: int = 0

    # FileResolver cache TTL. Each miss costs two RPCs before the first byte,
    # so high-latency links may want a longer TTL; invalidate-on-stale
    # file_reference still overrides the TTL immediately.
    resolver_ttl_seconds: int = 60

    # HMAC clock-skew window in seconds.
    signature_max_skew_seconds: int = 30

    @property
    def effective_prefetch_depth(self) -> int:
        """Clamped view of `prefetch_depth` (P2 will consume this value)."""
        return max(0, min(4, self.prefetch_depth))

    @property
    def effective_resolver_ttl_seconds(self) -> int:
        """Clamped view of `resolver_ttl_seconds` (15-600)."""
        return max(15, min(600, self.resolver_ttl_seconds))


settings = Settings()
