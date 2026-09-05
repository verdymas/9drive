"""Stream endpoint.

Contract:
- GET /v1/stream?providerId=...&channelId=...&messageId=...&knownSize=N
- Reads the Range header (single byte-range only; multipart is out of scope per phase spec).
- 200 full read, 206 valid range, 416 invalid range.
- Never a fake 206.
- Requires the signed internal auth.

The document is resolved (and the Telegram session proven live) *before* the
response is committed, so a dead session or a deleted message becomes a real
status code instead of a well-formed 206 carrying nothing.

Observability (Phase 08):
  - Each request gets a `request_id` (carried via `X-Request-Id` if the
    backend supplied one, otherwise generated).
  - One `stream_start` JSON line is emitted on entry; `stream_end` on exit.
  - All log lines are redacted (see app/observability.py).
"""
from __future__ import annotations

import asyncio
import re
import uuid
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse

from app.core.errors import AppError
from app.observability import (
    StreamMetrics,
    dec_active,
    emit,
    emit_error,
    inc_active,
    inc_cancellation,
)
from app.security.internal_auth import require_internal_signature
from app.telegram.engine import TelethonAdapter, iter_bytes, resolve_document
from app.telegram.file_resolver import ResolvedLocation

router = APIRouter()

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _resolve_range(range_header: str | None, total: int) -> tuple[int, int] | None:
    """Returns (start, end) inclusive, or None for full read. Raises 416 for invalid."""
    if range_header is None or range_header.strip() == "":
        return None
    m = _RANGE_RE.match(range_header.strip())
    if not m:
        raise AppError("INVALID_RANGE", "Range header must be 'bytes=START-END'.", 416, details={"total": total})
    s, e = m.group(1), m.group(2)
    if s == "" and e == "":
        raise AppError("INVALID_RANGE", "Range header is empty.", 416, details={"total": total})
    if s == "":
        # bytes=-N (suffix range): last N bytes
        try:
            n = int(e)
        except ValueError as exc:
            raise AppError("INVALID_RANGE", "Invalid suffix range.", 416, details={"total": total}) from exc
        if n <= 0:
            raise AppError("INVALID_RANGE", "Invalid suffix range.", 416, details={"total": total})
        start = max(0, total - n)
        end = total - 1
    else:
        try:
            start = int(s)
        except ValueError as exc:
            raise AppError("INVALID_RANGE", "Invalid range start.", 416, details={"total": total}) from exc
        if e == "":
            end = total - 1
        else:
            try:
                end = int(e)
            except ValueError as exc:
                raise AppError("INVALID_RANGE", "Invalid range end.", 416, details={"total": total}) from exc
    if start < 0 or end < start or start >= total:
        raise AppError("RANGE_NOT_SATISFIABLE", "Requested range is not satisfiable.", 416, details={"total": total})
    end = min(end, total - 1)
    return start, end


async def _body(
    client: TelethonAdapter,
    location: ResolvedLocation,
    *,
    start: int,
    length: int,
    status: int,
    metrics: StreamMetrics,
) -> AsyncGenerator[bytes, None]:
    """Stream the range and own the stream's bookkeeping.

    Finalization lives in `finally` rather than a Starlette background task:
    a background task is skipped when the client disconnects, which is the
    common case here (every Jellyfin seek abandons the previous range), and
    the active-stream gauge would drift up forever.

    Cancellation needs no stop flag either — Starlette throws CancelledError
    into this generator, which unwinds `iter_bytes` and closes the download
    iterator, releasing the Telegram sender.
    """
    inc_active()
    try:
        async for chunk in iter_bytes(client, location, start=start, length=length, metrics=metrics):
            yield chunk
    except asyncio.CancelledError:
        metrics.cancelled = True
        inc_cancellation()
        raise
    except AppError as exc:
        metrics.error = exc.code
        emit_error("stream_failed", request_id=metrics.request_id, code=exc.code, status=exc.status)
        raise
    except Exception as exc:
        # Headers are already sent, so the status cannot change — but an
        # undiagnosable torn connection is worse than a logged one.
        metrics.error = type(exc).__name__
        emit_error("stream_failed", request_id=metrics.request_id, code=type(exc).__name__)
        raise
    finally:
        dec_active()
        metrics.finish(status, cancelled=metrics.cancelled, error=metrics.error)


@router.get("/v1/stream")
async def stream(
    request: Request,
    providerId: str = Query(""),
    channelId: str = Query(""),
    messageId: str = Query(""),
    knownSize: int = Query(0, ge=0),
    _: None = Depends(require_internal_signature),
) -> Response:
    request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex
    if knownSize == 0:
        emit("stream_skip", request_id=request_id, reason="zero_size", provider_id=providerId, channel_id=channelId, message_id=messageId)
        raise AppError("FILE_NOT_FOUND", "Telegram file is not available.", 404)
    range_header = request.headers.get("range") or request.headers.get("Range")
    try:
        rng = _resolve_range(range_header, knownSize)
    except AppError as exc:
        emit("stream_reject", request_id=request_id, code=exc.code, status=exc.status, range=range_header)
        raise

    metrics = StreamMetrics(
        request_id=request_id,
        provider_id=providerId,
        channel_id=channelId,
        message_id=messageId,
        file_size=knownSize,
        range_start=rng[0] if rng else 0,
        range_end=rng[1] if rng else knownSize - 1,
    )
    emit(
        "stream_start",
        request_id=request_id,
        provider_id=providerId,
        channel_id=channelId,
        message_id=messageId,
        file_size=knownSize,
        range=range_header,
    )

    # Resolve BEFORE committing a status: a revoked session or a deleted
    # message must become 503/404, never a well-formed 206 carrying nothing.
    try:
        client, location = await resolve_document(
            provider_id=providerId, channel_id=channelId, message_id=int(messageId or 0)
        )
    except AppError as exc:
        emit_error("stream_resolve_failed", request_id=request_id, code=exc.code, status=exc.status)
        raise
    except ValueError as exc:
        raise AppError("INVALID_MESSAGE_ID", "messageId must be an integer.", 400) from exc

    start, end = rng if rng is not None else (0, knownSize - 1)
    length = end - start + 1
    status = 206 if rng is not None else 200
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "X-Request-Id": request_id,
    }
    if rng is not None:
        headers["Content-Range"] = f"bytes {start}-{end}/{knownSize}"

    return StreamingResponse(
        _body(client, location, start=start, length=length, status=status, metrics=metrics),
        status_code=status,
        headers=headers,
        media_type="application/octet-stream",
    )
