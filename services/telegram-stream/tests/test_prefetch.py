"""Prefetch (`_iter_bytes_prefetch`) behavior: in-order merge with staggered
workers, exact byte math, bounded fan-out, cancellation cleanup, and error /
CDN-redirect propagation. Offline — the fakes mimic the parts of Telethon's
strided `iter_download` the engine relies on (one chunk per request, short
chunk = EOF).
"""
from __future__ import annotations

import asyncio

import pytest

from app import observability as obs
from app.core.config import settings
from app.core.errors import AppError
from app.observability import StreamMetrics
from app.telegram import engine
from app.telegram.engine import iter_bytes
from app.telegram.file_resolver import ResolvedLocation

REQUEST = 4096
DATA = bytes(i & 0xFF for i in range(20_000))  # 4 full chunks + a partial one


class _CdnRedirect(Exception):
    """Name-matches what Telethon raises; `_is_cdn_redirect` only checks the name."""


class FakeStridedDownload:
    """`iter_download` with stride: yields chunks at offset, offset+stride, ..."""

    def __init__(
        self,
        data: bytes,
        *,
        offset: int,
        stride: int,
        request_size: int,
        limit: int,
        delay: float = 0.0,
        fail_after: int | None = None,
        fail_exc: BaseException | None = None,
    ) -> None:
        self._data = data
        self._offset = offset
        self._stride = stride
        self._request_size = request_size
        self._limit = limit
        self._delay = delay
        self._fail_after = fail_after
        self._fail_exc = fail_exc
        self._served = 0
        self.closed = False

    def __aiter__(self) -> "FakeStridedDownload":
        return self

    async def __anext__(self) -> bytes:
        if self._served >= self._limit or self._offset >= len(self._data):
            raise StopAsyncIteration
        if self._fail_after is not None and self._served >= self._fail_after:
            raise self._fail_exc or RuntimeError("simulated upstream failure")
        if self._delay:
            await asyncio.sleep(self._delay)
        chunk = self._data[self._offset : self._offset + self._request_size]
        self._offset += self._stride
        self._served += 1
        return chunk

    async def close(self) -> None:
        self.closed = True


class FakeClient:
    """Records the `iter_download` kwargs; optional per-worker delays/failures."""

    def __init__(
        self,
        data: bytes,
        *,
        slow_worker: int | None = None,
        delay: float = 0.0,
        fail_worker: int | None = None,
        fail_after: int = 1,
        fail_exc: BaseException | None = None,
    ) -> None:
        self._data = data
        self._slow_worker = slow_worker
        self._delay = delay
        self._fail_worker = fail_worker
        self._fail_after = fail_after
        self._fail_exc = fail_exc
        self.calls: list[dict] = []
        self.streams: list[FakeStridedDownload] = []
        self.raw = self

    def iter_download(self, _location, **kwargs):  # noqa: ANN001, ANN201
        index = len(self.calls)
        self.calls.append(kwargs)
        request_size = kwargs["request_size"]
        stream = FakeStridedDownload(
            self._data,
            offset=kwargs["offset"],
            stride=kwargs.get("stride", request_size),
            request_size=request_size,
            limit=kwargs.get("limit") or 10**9,
            delay=self._delay if index == self._slow_worker else 0.0,
            fail_after=self._fail_after if index == self._fail_worker else None,
            fail_exc=self._fail_exc,
        )
        self.streams.append(stream)
        return stream


def _location(size: int) -> ResolvedLocation:
    return ResolvedLocation(raw_location=object(), file_size=size, mime_type=None, dc_id=5)


def _metrics() -> StreamMetrics:
    return StreamMetrics(
        request_id="r", provider_id="p", channel_id="c", message_id="1",
        file_size=len(DATA), range_start=0, range_end=None,
    )


async def _collect(client: FakeClient, *, start: int, length: int) -> bytes:
    out = b""
    metrics = _metrics()
    async for chunk in iter_bytes(client, _location(len(DATA)), start=start, length=length, metrics=metrics):
        out += chunk
    return out


@pytest.fixture(autouse=True)
def small_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "chunk_size_bytes", REQUEST)


@pytest.fixture
def prefetch_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "prefetch_depth", 2)


@pytest.mark.parametrize(
    ("start", "length"),
    [
        (0, REQUEST),                  # aligned, single chunk
        (1000, REQUEST + 17),          # unaligned: prefix skip + partial tail
        (REQUEST, 2 * REQUEST + 1),    # aligned, spans three chunks
        (8190, 3),                     # inside one chunk
        (0, len(DATA)),                # whole file to EOF
        (16_000, 4_000),               # final partial chunk
    ],
)
async def test_prefetch_is_byte_exact_with_staggered_workers(
    start: int, length: int, prefetch_on, small_chunks
) -> None:
    client = FakeClient(DATA, slow_worker=1, delay=0.02)
    assert await _collect(client, start=start, length=length) == DATA[start : start + length]


async def test_prefetch_wire_params_are_strided_and_bounded(prefetch_on, small_chunks) -> None:
    client = FakeClient(DATA)
    length = 12_000
    assert await _collect(client, start=1000, length=length) == DATA[1000 : 1000 + length]
    assert len(client.calls) == 2  # two workers, no more
    assert [c["offset"] for c in client.calls] == [0, REQUEST]  # 4 KiB-aligned start
    assert all(c["stride"] == 2 * REQUEST for c in client.calls)
    assert all(c["chunk_size"] == REQUEST and c["request_size"] == REQUEST for c in client.calls)
    # No limit/file_size: they would flip Telethon's iterator to the generic
    # path, which re-fetches every chunk's head.
    assert all("limit" not in c and "file_size" not in c for c in client.calls)
    assert all(c["dc_id"] == 5 for c in client.calls)


async def test_prefetch_depth_three_uses_all_workers(monkeypatch, small_chunks) -> None:
    monkeypatch.setattr(settings, "prefetch_depth", 3)
    client = FakeClient(DATA)
    assert await _collect(client, start=0, length=len(DATA)) == DATA
    assert [c["offset"] for c in client.calls] == [0, REQUEST, 2 * REQUEST]


async def test_prefetch_reports_iterator_in_metrics(prefetch_on, small_chunks) -> None:
    client = FakeClient(DATA)
    metrics = _metrics()
    assert metrics.prefetch_depth == 0
    async for _ in iter_bytes(client, _location(len(DATA)), start=0, length=REQUEST, metrics=metrics):
        pass
    assert metrics.iterator == "prefetch(k=2)"
    assert metrics.prefetch_depth == 2


async def test_aclose_closes_every_worker(prefetch_on, small_chunks) -> None:
    client = FakeClient(DATA, slow_worker=1, delay=0.05)
    gen = iter_bytes(client, _location(len(DATA)), start=0, length=len(DATA), metrics=_metrics())
    first = await gen.__anext__()
    assert first == DATA[:REQUEST]
    await gen.aclose()
    assert client.streams  # workers were launched
    assert all(s.closed for s in client.streams)


async def test_task_cancellation_closes_every_worker(prefetch_on, small_chunks) -> None:
    """The real disconnect path: Starlette cancels the consuming task."""
    client = FakeClient(DATA, slow_worker=1, delay=0.05)
    seen: list[bytes] = []

    async def consume() -> None:
        async for chunk in iter_bytes(client, _location(len(DATA)), start=0, length=len(DATA), metrics=_metrics()):
            seen.append(chunk)

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.01)  # let the first chunks flow
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert seen
    assert client.streams
    assert all(s.closed for s in client.streams)


async def test_worker_error_propagates_and_invalidates_resolver(prefetch_on, small_chunks, monkeypatch) -> None:
    calls: list[tuple[str, str, int]] = []

    async def spy_invalidate(provider_id: str, channel_id: str, message_id: int) -> None:
        calls.append((provider_id, channel_id, message_id))

    monkeypatch.setattr(engine.resolver, "invalidate", spy_invalidate)
    obs.TOTAL_FILE_REFERENCE_REFRESHES = 0
    client = FakeClient(DATA, fail_worker=1)

    with pytest.raises(RuntimeError, match="simulated upstream failure"):
        await _collect(client, start=0, length=len(DATA))
    assert calls == [("p", "c", 1)]
    assert obs.TOTAL_FILE_REFERENCE_REFRESHES == 1


async def test_worker_cdn_redirect_is_counted(prefetch_on, small_chunks) -> None:
    obs.TOTAL_CDN_REDIRECTS = 0
    client = FakeClient(DATA, fail_worker=1, fail_after=0, fail_exc=_CdnRedirect("redirect"))
    with pytest.raises(_CdnRedirect):
        await _collect(client, start=0, length=len(DATA))
    assert obs.TOTAL_CDN_REDIRECTS == 1


async def test_short_file_raises_short_read(prefetch_on, small_chunks) -> None:
    """Workers ending at EOF before the requested length must never truncate silently."""
    client = FakeClient(DATA)
    with pytest.raises(AppError) as excinfo:
        await _collect(client, start=0, length=len(DATA) + 30_000)
    assert excinfo.value.code == "SHORT_READ"
    assert excinfo.value.status == 502


async def test_depth_one_uses_the_sequential_path(monkeypatch, small_chunks) -> None:
    """1 clamps to sequential: no stride/limit/file_size in the wire call."""
    monkeypatch.setattr(settings, "prefetch_depth", 1)
    client = FakeClient(DATA)
    metrics = _metrics()
    out = b""
    async for chunk in iter_bytes(client, _location(len(DATA)), start=0, length=REQUEST, metrics=metrics):
        out += chunk
    assert out == DATA[:REQUEST]
    assert metrics.prefetch_depth == 0
    assert "stride" not in client.calls[0]
    assert "limit" not in client.calls[0]
    assert "file_size" not in client.calls[0]
    assert client.calls[0]["offset"] == 0
