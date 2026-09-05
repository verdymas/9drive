"""Byte-range streaming engine (Phase 04).

Reads `offset..offset+limit-1` from a Telegram document via
`raw.functions.upload.GetFile(location, offset, limit)` on a media
session. Yields bytes in order, stops exactly at the requested end.

Contract:
  - Never download the whole file.
  - Never start at byte 0 for a mid-file range.
  - Never Buffer.concat the file.
  - Misaligned offsets are handled: telegram-stremio confirmed in its
    source that `upload.GetFile` accepts arbitrary offsets. We therefore
    do not align, we just trim the first/last chunk to the requested
    range.
  - The Telegram protocol returns `raw.types.upload.File` with a `bytes`
    field; we yield those bytes as-is.

Tests use a fake client with deterministic bytes (no real MTProto).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Protocol

logger = logging.getLogger(__name__)


# The "raw" GetFile function tuple: (id, access_hash, file_reference, thumb_size)
# plus the `offset` and `limit` we set per call. We don't decode the
# PyroFork FileId here — the test fixture passes a pre-built location
# object. The real code path in Phase 06 will use
# `pyrogram.file_id.FileId.decode(document.file_id)` and
# `raw.types.InputDocumentFileLocation(...)` from the spec.
@dataclass
class GetFileRequest:
    location: Any
    offset: int
    limit: int


class TelegramClientLike(Protocol):
    async def invoke(self, request: GetFileRequest) -> Any: ...


@dataclass
class RangeRequest:
    offset: int
    limit: int  # number of bytes to deliver


class RangeNotSatisfiable(Exception):
    """Raised when the requested range cannot be served."""


def validate_range(total_size: int, request: RangeRequest) -> None:
    if total_size <= 0:
        raise RangeNotSatisfiable("file is empty")
    if request.offset < 0 or request.limit <= 0:
        raise RangeNotSatisfiable("invalid range")
    if request.offset >= total_size:
        raise RangeNotSatisfiable("offset beyond EOF")


async def stream_range(
    client: TelegramClientLike,
    location: Any,
    request: RangeRequest,
    *,
    chunk_size: int,
) -> AsyncGenerator[bytes, None]:
    """Yield exactly `request.limit` bytes starting at `request.offset`.

    Issues `upload.GetFile` calls in `chunk_size` slices, in order, and
    trims the last slice to fit `request.limit` exactly. Raises
    `RangeNotSatisfiable` on invalid input.
    """
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    validate_range(total_size=request.offset + request.limit, request=request)

    remaining = request.limit
    current = request.offset
    while remaining > 0:
        this_limit = min(chunk_size, remaining)
        response = await client.invoke(GetFileRequest(location=location, offset=current, limit=this_limit))
        chunk = getattr(response, "bytes", None)
        if not chunk:
            # Empty response is a short read — the file ended earlier than
            # the caller asked for. This is fatal for a partial read.
            raise RangeNotSatisfiable(f"short read at offset={current}, wanted={this_limit}")
        if len(chunk) > this_limit:
            # Provider returned more than requested; trim the suffix so the
            # caller gets exactly `this_limit` bytes for this slice.
            chunk = chunk[:this_limit]
        if len(chunk) < this_limit and current + len(chunk) < request.offset + request.limit:
            # Short read mid-range: the file is shorter than the caller
            # was told. Surface the error rather than silently emit a
            # truncated body — a partial body under 200/206 is forbidden.
            raise RangeNotSatisfiable(
                f"short read at offset={current}, wanted={this_limit}, got={len(chunk)}"
            )
        yield chunk
        current += len(chunk)
        remaining -= len(chunk)


__all__ = [
    "GetFileRequest",
    "RangeRequest",
    "RangeNotSatisfiable",
    "stream_range",
    "validate_range",
]
