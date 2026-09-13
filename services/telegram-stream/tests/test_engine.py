"""The byte math in `iter_bytes` — the part that silently corrupts playback if
it's wrong — against a fake `iter_download`. No network, no telethon needed
(the engine imports telethon lazily and this path never touches it).
"""
from __future__ import annotations

import pytest

from app.core.config import settings
from app.core.errors import AppError
from app.observability import StreamMetrics
from app.telegram.engine import _classify, _peer, iter_bytes
from app.telegram.file_resolver import ResolvedLocation


class FakeDownload:
    """Mimics Telethon's download iterator: yields fixed-size chunks."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.closed = False

    def __aiter__(self) -> "FakeDownload":
        self._it = iter(self._chunks)
        return self

    async def __anext__(self) -> bytes:
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration from None

    async def close(self) -> None:
        self.closed = True


class FakeClient:
    def __init__(self, chunks: list[bytes]) -> None:
        self.download = FakeDownload(chunks)
        self.kwargs: dict = {}
        self.raw = self

    def iter_download(self, location, **kwargs):  # noqa: ANN001, ANN201
        self.kwargs = kwargs
        return self.download


class AlignedDownload:
    """A Telegram-like iterator that rejects invalid upload.getFile offsets."""

    def __init__(self, *, offset: int, request_size: int, file_size: int) -> None:
        self._offset = offset
        self._request_size = request_size
        self._file_size = file_size
        self._cursor = offset
        self.closed = False
        self.max_chunk_size = 0

    def __aiter__(self) -> "AlignedDownload":
        return self

    async def __anext__(self) -> bytes:
        if self._offset % self._request_size:
            raise RuntimeError("LimitInvalidError")
        if self._cursor >= self._file_size:
            raise StopAsyncIteration
        size = min(self._request_size, self._file_size - self._cursor)
        self.max_chunk_size = max(self.max_chunk_size, size)
        chunk = bytes((self._cursor + i) & 0xFF for i in range(size))
        self._cursor += size
        return chunk

    async def close(self) -> None:
        self.closed = True


class AlignedClient:
    """Records the upstream request and emits data from its requested offset."""

    def __init__(self) -> None:
        self.kwargs: dict = {}
        self.download: AlignedDownload | None = None
        self.raw = self

    def iter_download(self, location, **kwargs):  # noqa: ANN001, ANN201
        self.kwargs = kwargs
        self.download = AlignedDownload(
            offset=kwargs["offset"],
            request_size=kwargs["request_size"],
            file_size=kwargs["file_size"],
        )
        return self.download


def _metrics() -> StreamMetrics:
    return StreamMetrics(
        request_id="r", provider_id="p", channel_id="c", message_id="1",
        file_size=100, range_start=0, range_end=99,
    )


async def _collect(client, *, start: int, length: int) -> bytes:
    location = ResolvedLocation(raw_location=object(), file_size=100, mime_type=None, dc_id=5)
    out = b""
    async for chunk in iter_bytes(client, location, start=start, length=length, metrics=_metrics()):
        out += chunk
    return out


async def test_trims_to_exact_length_and_stops_early() -> None:
    client = FakeClient([b"AAAA", b"BBBB", b"CCCC"])
    assert await _collect(client, start=0, length=6) == b"AAAABB"
    assert client.download.closed  # the sender is released, not leaked


async def test_short_read_is_an_error_not_a_truncated_body() -> None:
    client = FakeClient([b"AAAA"])
    with pytest.raises(AppError) as excinfo:
        await _collect(client, start=0, length=10)
    assert excinfo.value.code == "SHORT_READ"
    assert excinfo.value.status == 502


async def test_request_size_is_clamped_to_telethon_max_and_offset_is_aligned(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "chunk_size_bytes", 4 * 1024 * 1024)
    client = FakeClient([b"A" * 21])
    await _collect(client, start=17, length=4)
    assert client.kwargs["request_size"] == 512 * 1024
    assert client.kwargs["offset"] == 0


async def test_jellyfin_arbitrary_range_aligns_upstream_and_yields_exact_bytes() -> None:
    """Passing the raw HTTP start to Telegram would raise LimitInvalidError."""
    start = 41_639_936
    end = 75_194_367
    request_size = 512 * 1024
    client = AlignedClient()
    location = ResolvedLocation(raw_location=object(), file_size=end + 1, mime_type=None, dc_id=5)
    metrics = StreamMetrics(
        request_id="jellyfin", provider_id="p", channel_id="c", message_id="1",
        file_size=location.file_size, range_start=start, range_end=end,
    )

    first_byte: int | None = None
    emitted = 0
    async for chunk in iter_bytes(client, location, start=start, length=end - start + 1, metrics=metrics):
        if first_byte is None:
            first_byte = chunk[0]
        emitted += len(chunk)
        assert len(chunk) <= request_size

    assert client.kwargs["offset"] == 41_418_752
    assert client.kwargs["offset"] % request_size == 0
    assert client.kwargs["request_size"] == request_size
    assert client.kwargs["chunk_size"] == request_size
    assert first_byte == start & 0xFF
    assert emitted == 33_554_432
    assert metrics.bytes_emitted == emitted
    assert client.download is not None and client.download.closed
    assert client.download.max_chunk_size == request_size


@pytest.mark.parametrize("start", [0, 1, 4_095, 4_096, 512 * 1024 - 1, 512 * 1024, 1024 * 1024 - 1, 1024 * 1024])
async def test_arbitrary_starts_keep_client_bytes_exact_while_aligning_upstream(start: int) -> None:
    request_size = 512 * 1024
    client = AlignedClient()
    location = ResolvedLocation(raw_location=object(), file_size=start + 4, mime_type=None, dc_id=5)

    output = b""
    async for chunk in iter_bytes(client, location, start=start, length=4, metrics=_metrics()):
        output += chunk

    assert client.kwargs["offset"] == start - (start % request_size)
    assert output == bytes((start + i) & 0xFF for i in range(4))


async def test_open_ended_range_can_start_at_an_arbitrary_offset() -> None:
    start = 41_639_936
    request_size = 512 * 1024
    client = AlignedClient()
    location = ResolvedLocation(raw_location=object(), file_size=start + 1_048_576, mime_type=None, dc_id=5)

    emitted = 0
    first_byte: int | None = None
    async for chunk in iter_bytes(client, location, start=start, length=location.file_size - start, metrics=_metrics()):
        if first_byte is None:
            first_byte = chunk[0]
        emitted += len(chunk)

    assert client.kwargs["offset"] == start - (start % request_size)
    assert first_byte == start & 0xFF
    assert emitted == 1_048_576


def test_peer_gets_the_100_marker_exactly_once() -> None:
    assert _peer("4458806678") == -1004458806678
    assert _peer("-1004458806678") == -1004458806678


# Telethon raised TypeNotFoundError when Telegram served a `message` constructor
# the installed release didn't know — the failure mode of a layer drift on a
# shared auth key. The mapping MUST produce a 502 with the right code, not a
# bare 500; otherwise every library scan crashes the request with no log line.
def test_type_not_found_maps_to_layer_mismatch_502() -> None:
    from telethon.errors import TypeNotFoundError

    mapped = _classify(TypeNotFoundError(0x7600B9D3, b""))
    assert mapped is not None
    assert mapped.status == 502
    assert mapped.code == "TELEGRAM_LAYER_MISMATCH"


def test_unclassified_exception_returns_none() -> None:
    assert _classify(RuntimeError("not a Telethon error")) is None
