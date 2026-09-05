"""Structured logging + per-stream metrics for telegram-stream.

All log lines are JSON. Secrets are redacted in a `redact()` pass before
emission (defense in depth: the caller should already not log them, but
we don't trust the caller).
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any


REDACT_KEYS = {
    "session",
    "session_string",
    "pyrofork_session",
    "stream_session",
    "api_id",
    "api_hash",
    "otp",
    "password",
    "code",
    "secret",
    "internal_secret",
    "TELEGRAM_STREAM_INTERNAL_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "auth_key",
    "ciphertext",
}

# Substrings (case-insensitive) that mark a value as needing redaction
# even if the field name is not in REDACT_KEYS.
REDACT_VALUE_NEEDLES = (
    "pyrofork",
    "telegram-stream-internal",
    "session_string",
    "otp",
    "auth_key",
)


def _redact_value(value: Any) -> Any:
    if isinstance(value, str):
        if not value:
            return value
        if any(needle in value.lower() for needle in REDACT_VALUE_NEEDLES):
            return "[REDACTED]"
        # Anything that looks like a base64 string longer than 60 chars is
        # probably a session string. Redact it.
        if len(value) > 60 and re.fullmatch(r"[A-Za-z0-9_+/=\-]+", value):
            return "[REDACTED]"
        return value
    if isinstance(value, dict):
        return {k: _redact_value(v) for k, v in value.items() if k.lower() not in REDACT_KEYS}
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    return value


def emit(event: str, **fields: Any) -> None:
    """Emit one structured log line to stdout. Redacted."""
    payload = {
        "ts": time.time(),
        "event": event,
        "service": "telegram-stream",
        "level": "info",
    }
    payload.update(_redact_value(fields))
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def emit_error(event: str, **fields: Any) -> None:
    payload = {
        "ts": time.time(),
        "event": event,
        "service": "telegram-stream",
        "level": "error",
    }
    payload.update(_redact_value(fields))
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


@dataclass
class StreamMetrics:
    """Per-stream counters. One instance per request."""
    request_id: str
    provider_id: str
    channel_id: str
    message_id: str
    file_size: int
    range_start: int
    range_end: int | None  # None for open-ended
    started_at: float = field(default_factory=time.time)
    first_byte_at: float | None = None
    last_byte_at: float | None = None
    bytes_emitted: int = 0
    chunks: int = 0
    parallel_chunks: int = 0
    queue_depth: int = 0
    file_reference_refreshes: int = 0
    flood_waits: int = 0
    cancelled: bool = False
    error: str | None = None
    status: int | None = None

    def mark_first_byte(self) -> None:
        if self.first_byte_at is None:
            self.first_byte_at = time.time()

    def add_chunk(self, n: int) -> None:
        self.chunks += 1
        self.bytes_emitted += n
        self.last_byte_at = time.time()

    def finish(self, status: int, *, cancelled: bool = False, error: str | None = None) -> None:
        self.status = status
        self.cancelled = cancelled
        self.error = error
        if self.last_byte_at is None:
            self.last_byte_at = time.time()
        duration = (self.last_byte_at or self.started_at) - self.started_at
        ttfb = (self.first_byte_at - self.started_at) if self.first_byte_at else None
        avg_mbps = (self.bytes_emitted * 8 / 1_000_000) / duration if duration > 0 else 0.0
        emit(
            "stream_end",
            request_id=self.request_id,
            provider_id=self.provider_id,
            channel_id=self.channel_id,
            message_id=self.message_id,
            file_size=self.file_size,
            range=[self.range_start, self.range_end],
            bytes=self.bytes_emitted,
            chunks=self.chunks,
            parallel_chunks=self.parallel_chunks,
            duration_ms=int(duration * 1000),
            ttfb_ms=int(ttfb * 1000) if ttfb is not None else None,
            avg_mbps=round(avg_mbps, 3),
            cancelled=self.cancelled,
            error=self.error,
            status=self.status,
        )


# Module-level simple counters (process-wide). These are best-effort and
# reset on process restart. They are exposed via /health.
ACTIVE_STREAMS = 0
TOTAL_STREAMS = 0
TOTAL_CANCELLATIONS = 0
TOTAL_FILE_REFERENCE_REFRESHES = 0
TOTAL_FLOOD_WAITS = 0


def inc_active() -> None:
    global ACTIVE_STREAMS, TOTAL_STREAMS
    ACTIVE_STREAMS += 1
    TOTAL_STREAMS += 1


def dec_active() -> None:
    global ACTIVE_STREAMS
    ACTIVE_STREAMS = max(0, ACTIVE_STREAMS - 1)


def inc_cancellation() -> None:
    global TOTAL_CANCELLATIONS
    TOTAL_CANCELLATIONS += 1


def inc_file_reference_refresh() -> None:
    global TOTAL_FILE_REFERENCE_REFRESHES
    TOTAL_FILE_REFERENCE_REFRESHES += 1


def inc_flood_wait() -> None:
    global TOTAL_FLOOD_WAITS
    TOTAL_FLOOD_WAITS += 1
