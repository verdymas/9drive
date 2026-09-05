"""HMAC-SHA256 verification for the internal 9Drive -> telegram-stream API.

Canonical string (newline-joined, ASCII):
    <timestamp>\\n<method>\\n<path>\\n<providerId>\\n<channelId>\\n<messageId>\\n<Range-or-empty>

Headers:
    X-Stream-Timestamp: <unix-seconds>
    X-Stream-Signature: <hex-hmac-sha256>

The Range header is in the canonical string on purpose: a MITM (or a buggy caller) must not be able to
swap the requested range after the request was signed. Constant-time compare via hmac.compare_digest.
"""
from __future__ import annotations

import hashlib
import hmac
import time

from fastapi import Header, HTTPException, Request, status

from app.core.config import settings


def canonical_string(
    *,
    timestamp: int | str,
    method: str,
    path: str,
    provider_id: str,
    channel_id: str,
    message_id: str | int,
    range_header: str | None,
) -> str:
    return "\n".join(
        [
            str(timestamp),
            method.upper(),
            path,
            str(provider_id),
            str(channel_id),
            str(message_id),
            range_header or "",
        ]
    )


def sign(
    *,
    timestamp: int,
    method: str,
    path: str,
    provider_id: str,
    channel_id: str,
    message_id: str | int,
    range_header: str | None,
    secret: str,
) -> str:
    canonical = canonical_string(
        timestamp=timestamp,
        method=method,
        path=path,
        provider_id=provider_id,
        channel_id=channel_id,
        message_id=message_id,
        range_header=range_header,
    )
    mac = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256)
    return mac.hexdigest()


def verify(
    *,
    timestamp: int,
    method: str,
    path: str,
    provider_id: str,
    channel_id: str,
    message_id: str | int,
    range_header: str | None,
    signature: str,
    secret: str,
    now: int | None = None,
    max_skew_seconds: int | None = None,
) -> None:
    """Raise HTTPException(401) on any mismatch. Returns nothing on success."""
    if not secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="internal auth not configured")
    skew = max_skew_seconds if max_skew_seconds is not None else settings.signature_max_skew_seconds
    current = int(now if now is not None else time.time())
    if abs(current - int(timestamp)) > skew:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="signature expired")
    expected = sign(
        timestamp=timestamp,
        method=method,
        path=path,
        provider_id=provider_id,
        channel_id=channel_id,
        message_id=message_id,
        range_header=range_header,
        secret=secret,
    )
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid signature")


async def require_internal_signature(
    request: Request,
    x_stream_timestamp: str = Header(..., alias="X-Stream-Timestamp"),
    x_stream_signature: str = Header(..., alias="X-Stream-Signature"),
) -> None:
    """FastAPI dependency. Reads the request scope and the Range header, then verifies."""
    if not settings.internal_secret:
        # 401 (not 500) keeps the wire shape consistent for callers; logged as a misconfig.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="internal auth not configured")
    try:
        ts = int(x_stream_timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="bad timestamp") from exc
    qs = request.query_params
    provider_id = qs.get("providerId", "")
    channel_id = qs.get("channelId", "")
    message_id = qs.get("messageId", "")
    if not (provider_id and channel_id and message_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="missing identity fields")
    range_header = request.headers.get("range") or request.headers.get("Range")
    verify(
        timestamp=ts,
        method=request.method,
        path=request.url.path,
        provider_id=provider_id,
        channel_id=channel_id,
        message_id=message_id,
        range_header=range_header,
        signature=x_stream_signature,
        secret=settings.internal_secret,
    )
