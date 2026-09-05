"""Bounded prefetch, ordered output, backpressure, cancellation (Phase 05).

Design (from the audit doc, §6; not a copy of telegram-stremio's source):
  - A producer launches up to `parallelism` concurrent upload.GetFile
    tasks, each fetching a chunk into an in-memory results buffer keyed
    by sequence index.
  - A consumer drains the buffer in order, yields bytes to the FastAPI
    `StreamingResponse`.
  - The producer is bounded by `prefetch` (max chunks in flight or
    ready). The queue is the backpressure signal: when the consumer is
    slow, the queue fills and the producer blocks on put().
  - A `stop_event` cancels everything. Once set, the producer aborts new
    tasks and the consumer stops yielding. The caller (FastAPI handler)
    sets it when the underlying request is disconnected.
  - FloodWait: bounded retries; wait the requested seconds + jitter,
    but never more than `flood_wait_max_attempts` times per range.
  - FILE_REFERENCE: on a stale reference, refresh the file_resolver
    entry and retry once.

This module is pure: it takes a `GetFileClient` and a `RangeRequest`
and yields bytes. It does not know about HTTP, FastAPI, or clients.
"""
from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Awaitable, Callable, Optional

from app.telegram.byte_streamer import (
    GetFileRequest,
    RangeNotSatisfiable,
    RangeRequest,
    stream_range,
)
from app.telegram.file_resolver import FileResolver

logger = logging.getLogger(__name__)


# The protocol the prefetched streamer expects. `fetch_chunk(offset, limit)`
# returns a `bytes` object (or None on short read past EOF).
FetchChunk = Callable[[int, int], Awaitable[Optional[bytes]]]


@dataclass
class PrefetchConfig:
    chunk_size: int = 1 * 1024 * 1024
    prefetch: int = 3
    parallelism: int = 2
    flood_wait_max_attempts: int = 5
    flood_wait_max_seconds: float = 60.0
    file_reference_refresh_attempts: int = 1


class _CancelledError(Exception):
    """Internal: raised when the producer/consumer should stop."""


async def _fetch_chunk_with_retries(
    fetcher: FetchChunk,
    offset: int,
    limit: int,
    stop_event: asyncio.Event,
    cfg: PrefetchConfig,
    *,
    on_file_reference_expired: Callable[[], Awaitable[None]] | None = None,
    total_range_end: int,
) -> bytes:
    """Fetch one chunk, with bounded retries for FloodWait and FILE_REFERENCE.

    `total_range_end` is the end of the *requested* range (exclusive).
    A short read is fatal only if the chunk is short of `limit` AND the
    chunk does not reach the end of the requested range.
    """
    for _ in range(max(1, cfg.flood_wait_max_attempts)):
        if stop_event.is_set():
            raise _CancelledError()
        try:
            data = await fetcher(offset, limit)
            if data is None:
                raise RangeNotSatisfiable(f"short read at offset={offset}, limit={limit}")
            if len(data) < limit and offset + len(data) < total_range_end:
                raise RangeNotSatisfiable(
                    f"short read at offset={offset}, wanted={limit}, got={len(data)}"
                )
            return data
        except _FloodWaitError as exc:
            wait = min(exc.seconds + random.uniform(0.5, 2.0), cfg.flood_wait_max_seconds)
            logger.info("telegram-stream: flood-wait %.1fs", wait)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass
            if stop_event.is_set():
                raise _CancelledError()
        except _FileReferenceExpiredError:
            if on_file_reference_expired is None:
                raise
            await on_file_reference_expired()
            continue
    raise RangeNotSatisfiable("exceeded flood-wait retries")


class _FloodWaitError(Exception):
    def __init__(self, seconds: float) -> None:
        super().__init__(f"flood-wait {seconds}s")
        self.seconds = seconds


class _FileReferenceExpiredError(Exception):
    pass


async def stream_range_prefetched(
    fetcher: FetchChunk,
    request: RangeRequest,
    cfg: PrefetchConfig,
    stop_event: asyncio.Event,
    *,
    on_file_reference_expired: Callable[[], Awaitable[None]] | None = None,
) -> AsyncGenerator[bytes, None]:
    """Yield the requested range with bounded prefetch and ordered output."""
    if request.offset < 0 or request.limit <= 0:
        raise RangeNotSatisfiable("invalid range")

    total = request.offset + request.limit
    queue: asyncio.Queue[tuple[int, bytes | Exception | None]] = asyncio.Queue(maxsize=cfg.prefetch)
    producer_done = asyncio.Event()
    producer_task: asyncio.Task[None] | None = None

    async def producer() -> None:
        try:
            offsets = list(range(request.offset, total, cfg.chunk_size))
            sem = asyncio.Semaphore(cfg.parallelism)
            next_seq = 0
            inflight: dict[int, asyncio.Task[bytes]] = {}

            async def launch(idx: int, offset: int) -> None:
                limit = min(cfg.chunk_size, total - offset)
                async with sem:
                    if stop_event.is_set():
                        return
                    try:
                        chunk = await _fetch_chunk_with_retries(
                            fetcher,
                            offset,
                            limit,
                            stop_event,
                            cfg,
                            on_file_reference_expired=on_file_reference_expired,
                            total_range_end=total,
                        )
                    except _CancelledError:
                        await queue.put((idx, None))
                        return
                    except Exception as exc:  # noqa: BLE001 — surface to the consumer
                        await queue.put((idx, exc))
                        return
                await queue.put((idx, chunk))

            # Launch up to `parallelism` in flight, refill as we go.
            for offset in offsets:
                if stop_event.is_set():
                    break
                idx = next_seq
                next_seq += 1
                task = asyncio.create_task(launch(idx, offset))
                inflight[idx] = task

            # Wait for all inflight tasks to finish (each will put on the queue).
            if inflight:
                await asyncio.gather(*inflight.values(), return_exceptions=True)
        finally:
            producer_done.set()
            # Sentinel for the consumer.
            await queue.put((-1, None))

    producer_task = asyncio.create_task(producer())

    # Consumer: drain in index order, yield bytes.
    next_idx = 0
    buffer: dict[int, bytes | Exception | None] = {}
    try:
        while True:
            if stop_event.is_set():
                raise _CancelledError()
            try:
                idx, payload = await asyncio.wait_for(queue.get(), timeout=60.0)
            except asyncio.TimeoutError:
                raise RangeNotSatisfiable("producer stalled")
            if idx == -1:
                # Producer done. If we still have buffered items, that's a bug.
                break
            buffer[idx] = payload
            while next_idx in buffer:
                value = buffer.pop(next_idx)
                if isinstance(value, Exception):
                    raise value
                if value is None:
                    raise _CancelledError()
                yield value
                next_idx += 1
            if producer_done.is_set() and next_idx >= (total - request.offset + cfg.chunk_size - 1) // cfg.chunk_size:
                break
    finally:
        stop_event.set()
        if producer_task is not None and not producer_task.done():
            producer_task.cancel()
            try:
                await producer_task
            except (asyncio.CancelledError, Exception):
                pass


__all__ = [
    "FetchChunk",
    "PrefetchConfig",
    "stream_range_prefetched",
    "_FloodWaitError",
    "_FileReferenceExpiredError",
    "FileResolver",
]
