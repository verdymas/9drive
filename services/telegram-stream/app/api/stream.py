"""Stream endpoint.

Contract (this phase; the engine is a deterministic byte stub for now):
- GET /v1/stream?providerId=...&channelId=...&messageId=...&knownSize=N
- Reads the Range header (single byte-range only; multipart is out of scope per phase spec).
- 200 full read, 206 valid range, 416 invalid range.
- Never a fake 206.
- Requires the signed internal auth (Phase 02). At Phase 01 the auth is wired but
  TELEGRAM_STREAM_INTERNAL_SECRET may be empty in tests; the dependency allows that
  only in non-prod (see core/config.py).

Observability (Phase 08):
  - Each request gets a `request_id` (carried via `X-Request-Id` if the
    backend supplied one, otherwise generated).
  - One `stream_start` JSON line is emitted on entry; `stream_end` on exit.
  - All log lines are redacted (see app/observability.py).
"""
from __future__ import annotations

import re
import uuid
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.errors import AppError
from app.observability import StreamMetrics, dec_active, emit, emit_error, inc_active
from app.security.internal_auth import require_internal_signature

router = APIRouter()

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_BODY_CHUNK = 64 * 1024  # 64 KiB wire chunks; engine chunk size is configurable in core/config.py


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


async def _stub_bytes(total: int, start: int, length: int, metrics: StreamMetrics) -> AsyncGenerator[bytes, None]:
    """Deterministic byte fixture: byte i = i % 256. Phase 01 only; replaced by the engine in Phase 04."""
    i = start
    remaining = length
    while remaining > 0:
        n = min(_BODY_CHUNK, remaining)
        chunk = bytes((b + i) & 0xFF for b in range(n))  # type: ignore[arg-type]
        metrics.mark_first_byte()
        metrics.add_chunk(n)
        yield chunk
        i += n
        remaining -= n


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
    inc_active()
    emit(
        "stream_start",
        request_id=request_id,
        provider_id=providerId,
        channel_id=channelId,
        message_id=messageId,
        file_size=knownSize,
        range=range_header,
    )

    if rng is None:
        body = _stub_bytes(knownSize, 0, knownSize, metrics)
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(knownSize),
            "X-Request-Id": request_id,
        }

        async def finalize() -> None:
            dec_active()
            metrics.finish(200)

        response = StreamingResponse(body, status_code=200, headers=headers, media_type="application/octet-stream")
        response.background = finalize  # type: ignore[attr-defined]
        return response

    start, end = rng
    length = end - start + 1
    body = _stub_bytes(knownSize, start, length, metrics)
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Range": f"bytes {start}-{end}/{knownSize}",
        "Content-Length": str(length),
        "X-Request-Id": request_id,
    }

    async def finalize() -> None:
        dec_active()
        metrics.finish(206)

    response = StreamingResponse(body, status_code=206, headers=headers, media_type="application/octet-stream")
    response.background = finalize  # type: ignore[attr-defined]
    return response


# Exposed for the global error handler; 416 must include Content-Range per RFC 7233.
async def _range_not_satisfiable_handler(_: Request, exc: AppError) -> JSONResponse:
    if exc.code == "RANGE_NOT_SATISFIABLE":
        total = int(exc.details.get("total", 0)) if isinstance(exc.details, dict) else 0
        return JSONResponse(
            status_code=416,
            content={"error": {"code": exc.code, "message": exc.message}},
            headers={"Content-Range": f"bytes */{total}"},
        )
    return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}})
