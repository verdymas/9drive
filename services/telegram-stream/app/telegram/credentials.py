"""Per-account Telegram credentials, fetched from the 9Drive control plane.

telegram-stream has no database access by design. It asks the backend for
`{apiId, apiHash, session}` over the signed internal control plane, holds
the answer in memory, and never logs or persists it.

The session the backend returns is already in Telethon's `StringSession`
format (the backend repacks its stored GramJS session; see
`backend/src/modules/telegram/telethon-session.ts`).

Control-plane canonical string (matches
`backend/src/modules/telegram/telegram-stream-auth.middleware.ts`):
    <timestamp>\\n<METHOD>\\n<path-without-query>\\n<query-string>
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from app.core.config import settings
from app.core.errors import AppError

_CONTROL_PATH = "/telegram/stream/credentials"


@dataclass(frozen=True)
class Credentials:
    api_id: int
    api_hash: str
    session: str


def _sign(timestamp: int, method: str, path: str, query: str = "") -> str:
    canonical = "\n".join([str(timestamp), method.upper(), path, query])
    return hmac.new(settings.internal_secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()


def _fetch_blocking(provider_id: str) -> dict:
    if not settings.backend_url or not settings.internal_secret:
        raise AppError(
            "STREAM_NOT_CONFIGURED",
            "TELEGRAM_STREAM_BACKEND_URL / _INTERNAL_SECRET are not set.",
            503,
        )
    path = f"{_CONTROL_PATH}/{provider_id}"
    ts = int(time.time())
    request = urllib.request.Request(
        settings.backend_url.rstrip("/") + path,
        headers={"X-Stream-Timestamp": str(ts), "X-Stream-Signature": _sign(ts, "GET", path)},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        # The backend's codes are already caller-safe; the body never carries secrets.
        body = exc.read().decode(errors="replace")[:200]
        raise AppError(
            "CREDENTIALS_UNAVAILABLE",
            f"Control plane returned {exc.code}: {body}",
            503 if exc.code >= 500 else exc.code,
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise AppError("CREDENTIALS_UNAVAILABLE", "Control plane is unreachable.", 503) from exc


async def fetch_credentials(provider_id: str) -> Credentials:
    """Fetch credentials for one account. Raises AppError; never returns partial data."""
    payload = await asyncio.to_thread(_fetch_blocking, provider_id)
    try:
        return Credentials(
            api_id=int(payload["apiId"]),
            api_hash=str(payload["apiHash"]),
            session=str(payload["session"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise AppError("CREDENTIALS_UNAVAILABLE", "Malformed credentials payload.", 502) from exc


__all__ = ["Credentials", "fetch_credentials"]
