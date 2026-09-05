"""Shared pytest fixtures."""
from __future__ import annotations

import os
import time

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import create_app
from app.security.internal_auth import sign


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
