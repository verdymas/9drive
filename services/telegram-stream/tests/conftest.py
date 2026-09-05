"""Shared pytest fixtures."""
from __future__ import annotations

import os
import time
from typing import AsyncGenerator

import pytest
from fastapi.testclient import TestClient

from app.api import stream as stream_module
from app.core.config import settings
from app.main import create_app
from app.security.internal_auth import sign


class FakeLocation:
    """Stands in for a resolved Telegram document."""

    def __init__(self, size: int) -> None:
        self.raw_location = object()
        self.file_size = size
        self.mime_type = "video/x-matroska"
        self.dc_id = 5


@pytest.fixture(autouse=True)
def fake_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace Telegram with deterministic bytes: `byte i == i % 256`.

    The handler keeps its real range math, its real pre-commit resolution
    and its real header/status logic — only MTProto is stubbed, so the
    contract tests still assert exact bytes without a network.
    """

    async def resolve_document(*, provider_id: str, channel_id: str, message_id: int):
        return object(), FakeLocation(10)

    async def iter_bytes(_client, _location, *, start, length, metrics) -> AsyncGenerator[bytes, None]:
        data = bytes((start + i) & 0xFF for i in range(length))
        metrics.mark_first_byte()
        metrics.add_chunk(len(data))
        yield data

    monkeypatch.setattr(stream_module, "resolve_document", resolve_document)
    monkeypatch.setattr(stream_module, "iter_bytes", iter_bytes)


@pytest.fixture
def secret() -> str:
    return "test-secret-please-rotate"


@pytest.fixture
def client(secret: str) -> TestClient:
    # Ensure the app picks up the test secret BEFORE create_app() is called.
    os.environ["TELEGRAM_STREAM_INTERNAL_SECRET"] = secret
    settings.internal_secret = secret
    return TestClient(create_app())


def signed_headers(
    *,
    method: str,
    path: str,
    provider_id: str,
    channel_id: str,
    message_id: str,
    range_header: str | None,
    secret: str,
    ts: int | None = None,
) -> dict[str, str]:
    timestamp = ts if ts is not None else int(time.time())
    sig = sign(
        timestamp=timestamp,
        method=method,
        path=path,
        provider_id=provider_id,
        channel_id=channel_id,
        message_id=message_id,
        range_header=range_header,
        secret=secret,
    )
    return {"X-Stream-Timestamp": str(timestamp), "X-Stream-Signature": sig}
