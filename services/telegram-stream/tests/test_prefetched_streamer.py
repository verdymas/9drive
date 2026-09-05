from __future__ import annotations

import asyncio
import time

import pytest

from app.telegram.byte_streamer import RangeNotSatisfiable, RangeRequest
from app.telegram.prefetched_streamer import (
    PrefetchConfig,
    _FloodWaitError,
    stream_range_prefetched,
)


class _FakeFetcher:
    """Simulates Telegram upload.GetFile with per-call latency and a counter."""

    def __init__(self, data: bytes, latency_ms: int = 0) -> None:
        self._data = data
        self._latency = latency_ms / 1000.0
        self.calls: list[tuple[int, int]] = []
        self._lock = asyncio.Lock()

    async def __call__(self, offset: int, limit: int) -> bytes | None:
        async with self._lock:
            self.calls.append((offset, limit))
        if self._latency:
            await asyncio.sleep(self._latency)
        end = min(offset + limit, len(self._data))
        if offset >= len(self._data):
            return None
        return self._data[offset:end]


async def test_ordered_output_under_parallelism() -> None:
    data = bytes((b & 0xFF) for b in range(2_000_000))
    fetcher = _FakeFetcher(data, latency_ms=2)
    cfg = PrefetchConfig(chunk_size=64 * 1024, prefetch=3, parallelism=2)
    stop = asyncio.Event()
    received: bytes = bytearray()  # type: ignore[assignment]
    async for chunk in stream_range_prefetched(
        fetcher, RangeRequest(offset=0, limit=len(data)), cfg, stop
    ):
        received += chunk
    assert received == data
    # We issued 2_000_000 / 64KiB = ~30 chunks; with parallelism=2 the fetcher
    # saw each call, but the consumer must have received them in order.
    assert fetcher.calls  # many calls
    offsets_in_order = [c[0] for c in fetcher.calls]
    assert offsets_in_order == sorted(offsets_in_order)


async def test_cancellation_stops_downloads() -> None:
    """Set the stop event early; no more bytes must be yielded after that."""
    data = bytes((b & 0xFF) for b in range(1_000_000))
    fetcher = _FakeFetcher(data, latency_ms=5)
    cfg = PrefetchConfig(chunk_size=16 * 1024, prefetch=3, parallelism=2)
    stop = asyncio.Event()
    yielded = 0

    async def consume() -> None:
        nonlocal yielded
        async for _ in stream_range_prefetched(
            fetcher, RangeRequest(offset=0, limit=len(data)), cfg, stop
        ):
            yielded += 1
            if yielded >= 2:
                stop.set()
                return

    await consume()
    # Give the producer a moment to react to the stop.
    await asyncio.sleep(0.1)
    # The fetcher should not have been called for every chunk — only a
    # bounded number. We allow a small fudge for in-flight tasks.
    assert len(fetcher.calls) < 60, f"too many fetcher calls after cancel: {len(fetcher.calls)}"


async def test_short_read_raises() -> None:
    class Truncated:
        def __init__(self) -> None:
            self.calls = 0

        async def __call__(self, offset: int, limit: int) -> bytes | None:
            self.calls += 1
            # Return only 1 byte for any call.
            return b"x"

    cfg = PrefetchConfig(chunk_size=16, prefetch=2, parallelism=1)
    stop = asyncio.Event()
    with pytest.raises(RangeNotSatisfiable):
        async for _ in stream_range_prefetched(
            Truncated(), RangeRequest(offset=0, limit=64), cfg, stop
        ):
            pass


async def test_flood_wait_is_retried_bounded() -> None:
    """A flood-wait that exceeds the cap raises RangeNotSatisfiable."""

    attempts = 0

    async def fetcher(offset: int, limit: int) -> bytes:
        nonlocal attempts
        attempts += 1
        if attempts <= 10:
            raise _FloodWaitError(0.001)
        return b"ok"

    cfg = PrefetchConfig(
        chunk_size=8, prefetch=2, parallelism=1, flood_wait_max_attempts=3
    )
    stop = asyncio.Event()
    with pytest.raises(RangeNotSatisfiable):
        async for _ in stream_range_prefetched(
            fetcher, RangeRequest(offset=0, limit=8), cfg, stop
        ):
            pass
    # The fetcher is called per attempt: up to 3 flood-waits + 1 success.
    assert attempts <= 4
