from __future__ import annotations

import pytest

from app.telegram.byte_streamer import (
    GetFileRequest,
    RangeNotSatisfiable,
    RangeRequest,
    stream_range,
    validate_range,
)


class _FileResponse:
    def __init__(self, data: bytes) -> None:
        self.bytes = data


class FakeTelegramClient:
    """Returns deterministic bytes for any (offset, limit).

    The fixture data is `bytes(range(N))[:total]`. Asking for bytes
    [off:off+lim] returns the matching slice.
    """

    def __init__(self, total: int) -> None:
        self._data = bytes((b & 0xFF) for b in range(total))
        self.calls: list[GetFileRequest] = []

    async def invoke(self, request: GetFileRequest) -> _FileResponse:
        self.calls.append(request)
        # Simulate Telegram: the chunk returned may be the full slice
        # requested, or shorter near EOF.
        end = min(request.offset + request.limit, len(self._data))
        return _FileResponse(self._data[request.offset:end])


async def test_validate_range_rejects_offset_past_eof() -> None:
    with pytest.raises(RangeNotSatisfiable):
        validate_range(total_size=10, request=RangeRequest(offset=10, limit=1))


async def test_validate_range_rejects_zero_limit() -> None:
    with pytest.raises(RangeNotSatisfiable):
        validate_range(total_size=10, request=RangeRequest(offset=0, limit=0))


async def test_full_read_returns_all_bytes() -> None:
    client = FakeTelegramClient(total=10_000)
    chunks: list[bytes] = []
    async for c in stream_range(client, location=object(), request=RangeRequest(offset=0, limit=10_000), chunk_size=1024):
        chunks.append(c)
    assert b"".join(chunks) == client._data
    # One GetFile per chunk.
    assert len(client.calls) == 10
    assert all(c.limit == 1024 for c in client.calls[:-1])
    assert client.calls[-1].limit == 10_000 - 9 * 1024


async def test_first_range_returns_exact_bytes() -> None:
    client = FakeTelegramClient(total=10_000)
    chunks: list[bytes] = []
    async for c in stream_range(client, location=object(), request=RangeRequest(offset=0, limit=4), chunk_size=1024):
        chunks.append(c)
    assert b"".join(chunks) == client._data[0:4]


async def test_middle_range_returns_exact_bytes() -> None:
    client = FakeTelegramClient(total=10_000)
    chunks: list[bytes] = []
    async for c in stream_range(client, location=object(), request=RangeRequest(offset=4_000, limit=4), chunk_size=1024):
        chunks.append(c)
    assert b"".join(chunks) == client._data[4_000:4_004]
    # First call is exactly what was asked; no padding to a chunk boundary.
    assert client.calls[0].offset == 4_000
    assert client.calls[0].limit == 4


async def test_last_range_returns_exact_bytes() -> None:
    client = FakeTelegramClient(total=10_000)
    chunks: list[bytes] = []
    async for c in stream_range(client, location=object(), request=RangeRequest(offset=9_998, limit=2), chunk_size=1024):
        chunks.append(c)
    assert b"".join(chunks) == client._data[9_998:10_000]


async def test_open_ended_to_eof() -> None:
    client = FakeTelegramClient(total=10_000)
    chunks: list[bytes] = []
    async for c in stream_range(client, location=object(), request=RangeRequest(offset=9_900, limit=100), chunk_size=1024):
        chunks.append(c)
    assert b"".join(chunks) == client._data[9_900:10_000]


async def test_trims_overrun_response() -> None:
    """If Telegram returns more than we asked, we trim the suffix."""

    class OverrunClient:
        def __init__(self) -> None:
            self.calls: list[GetFileRequest] = []

        async def invoke(self, request: GetFileRequest) -> _FileResponse:
            self.calls.append(request)
            return _FileResponse(b"x" * (request.limit + 50))

    client = OverrunClient()
    chunks: list[bytes] = []
    async for c in stream_range(client, location=object(), request=RangeRequest(offset=0, limit=4), chunk_size=1024):
        chunks.append(c)
    assert b"".join(chunks) == b"x" * 4
    assert len(client.calls) == 1


async def test_raises_on_short_read_within_eof() -> None:
    class ShortClient:
        async def invoke(self, request: GetFileRequest) -> _FileResponse:
            return _FileResponse(b"")  # never any bytes

    with pytest.raises(RangeNotSatisfiable):
        async for _ in stream_range(ShortClient(), location=object(), request=RangeRequest(offset=0, limit=4), chunk_size=1024):
            pass
