"""The byte math in `iter_bytes` — the part that silently corrupts playback if
it's wrong — against a fake `iter_download`. No network, no telethon needed
(the engine imports telethon lazily and this path never touches it).
"""
from __future__ import annotations

import pytest

from app.core.config import settings
from app.core.errors import AppError
from app.observability import StreamMetrics
from app.telegram.engine import _classify, _peer, effective_request_size, iter_bytes
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
    """A Telegram-like iterator that rejects invalid upload.getFile requests.

    Mirrors the live wire constraints (verified against Telegram with a
    direct RPC probe): the offset must be 4 KiB-aligned, the limit must be a
    power-of-two multiple of 4 KiB, and the request must not cross a 1 MiB
    window — `(offset % 1 MiB) + request_size <= 1 MiB`; violations raise
    `LimitInvalidError`, exactly like the server.
    """

    def __init__(self, *, offset: int, request_size: int, file_size: int | None) -> None:
        if (
            offset % 4096
            or (request_size & (request_size - 1)) != 0
            or (offset % (1024 * 1024)) + request_size > 1024 * 1024
        ):
            raise RuntimeError("LimitInvalidError")
        self._offset = offset
        self._request_size = request_size
        self._file_size = file_size
        self._cursor = offset
        self.closed = False
        self.max_chunk_size = 0

    def __aiter__(self) -> "AlignedDownload":
        return self

    async def __anext__(self) -> bytes:
        if self._file_size is not None and self._cursor >= self._file_size:
            raise StopAsyncIteration
        size = self._request_size
        if self._file_size is not None:
            size = min(size, self._file_size - self._cursor)
        self.max_chunk_size = max(self.max_chunk_size, size)
        chunk = bytes((self._cursor + i) & 0xFF for i in range(size))
        self._cursor += size
        return chunk

    async def close(self) -> None:
        self.closed = True


class AlignedClient:
    """Records upstream requests; every `iter_download` call gets its own stream."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.downloads: list[AlignedDownload] = []
        self.raw = self

    def iter_download(self, location, **kwargs):  # noqa: ANN001, ANN201
        self.requests.append(kwargs)
        download = AlignedDownload(
            offset=kwargs["offset"],
            request_size=kwargs["request_size"],
            file_size=kwargs.get("file_size"),
        )
        self.downloads.append(download)
        return download

    @property
    def kwargs(self) -> dict:
        return self.requests[-1]

    @property
    def download(self) -> AlignedDownload:
        return self.downloads[-1]


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


def test_effective_request_size_clamps_and_aligns(monkeypatch: pytest.MonkeyPatch) -> None:
    """The startup log and the byte engine must agree about the wire size."""
    monkeypatch.setattr(settings, "chunk_size_bytes", 4 * 1024 * 1024)
    assert effective_request_size() == 512 * 1024
    monkeypatch.setattr(settings, "chunk_size_bytes", 100_000)
    assert effective_request_size() == 65_536  # rounded to divide the 1 MiB window
    monkeypatch.setattr(settings, "chunk_size_bytes", 1000)
    assert effective_request_size() == 4096


async def test_jellyfin_arbitrary_range_aligns_upstream_and_yields_exact_bytes() -> None:
    """Passing the raw HTTP start to Telegram would raise LimitInvalidError."""
    start = 41_639_936  # a 4 KiB multiple: no discarded prefix
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

    assert first_byte == start & 0xFF
    assert emitted == 33_554_432
    assert metrics.bytes_emitted == emitted
    assert metrics.prefix_bytes == 0
    assert all(d.closed for d in client.downloads)
    assert max(d.max_chunk_size for d in client.downloads) == request_size
    # The start sits mid-window: a 512 KiB request from it would cross the
    # 1 MiB boundary, so the head up to the window edge (303_104 =
    # 1 MiB - 745_472) is split into power-of-two pieces and the main
    # iterator resumes on the grid at 41,943,040.
    assert [r["offset"] for r in client.requests] == [
        start,
        start + 262_144,
        start + 262_144 + 32_768,
        start + 303_104,
    ]
    assert [r["request_size"] for r in client.requests] == [262_144, 32_768, 8_192, request_size]
    for r in client.requests:
        assert r["offset"] % 4096 == 0
        assert r["request_size"] & (r["request_size"] - 1) == 0  # power of two
        assert (r["offset"] % (1024 * 1024)) + r["request_size"] <= 1024 * 1024
        assert r["chunk_size"] == r["request_size"]
        assert "file_size" not in r and r.get("limit") is None


@pytest.mark.parametrize("start", [0, 1, 4_095, 4_096, 512 * 1024 - 1, 512 * 1024, 1024 * 1024 - 1, 1024 * 1024])
async def test_arbitrary_starts_keep_client_bytes_exact_while_aligning_upstream(start: int) -> None:
    client = AlignedClient()
    location = ResolvedLocation(raw_location=object(), file_size=start + 4, mime_type=None, dc_id=5)
    metrics = _metrics()

    output = b""
    async for chunk in iter_bytes(client, location, start=start, length=4, metrics=metrics):
        output += chunk

    assert client.requests[0]["offset"] == start - (start % 4096)
    assert metrics.prefix_bytes == start % 4096
    assert output == bytes((start + i) & 0xFF for i in range(4))


async def test_open_ended_range_can_start_at_an_arbitrary_offset() -> None:
    start = 41_639_936
    client = AlignedClient()
    location = ResolvedLocation(raw_location=object(), file_size=start + 1_048_576, mime_type=None, dc_id=5)

    emitted = 0
    first_byte: int | None = None
    async for chunk in iter_bytes(client, location, start=start, length=location.file_size - start, metrics=_metrics()):
        if first_byte is None:
            first_byte = chunk[0]
        emitted += len(chunk)

    assert client.requests[0]["offset"] == start - (start % 4096)
    assert first_byte == start & 0xFF
    assert emitted == 1_048_576


async def test_unaligned_seek_aligns_to_4k_and_never_forces_the_generic_iterator() -> None:
    """The wire call must keep `limit=None`/no `file_size` on a 4 KiB-aligned
    offset: that triple is what keeps Telethon on `_DirectDownloadIter`
    instead of re-fetching each chunk's unaligned head."""
    start = 475_712 - 12_287  # arbitrary unaligned offset
    client = AlignedClient()
    location = ResolvedLocation(raw_location=object(), file_size=start + 1000, mime_type=None, dc_id=5)

    output = b""
    async for chunk in iter_bytes(client, location, start=start, length=4, metrics=_metrics()):
        output += chunk

    assert client.requests[0]["offset"] == start - (start % 4096)
    assert client.requests[0]["offset"] % 4096 == 0
    assert "file_size" not in client.requests[0]
    assert client.requests[0].get("limit") is None
    assert client.requests[0]["chunk_size"] == client.requests[0]["request_size"]
    assert output == bytes((start + i) & 0xFF for i in range(4))


async def test_mid_window_start_fits_head_then_returns_to_the_grid() -> None:
    """A start inside a 1 MiB window splits the head up to the window edge
    into power-of-two pieces, then the main iterator resumes on the grid;
    every request stays window-safe and the emitted bytes stay exact."""
    start = 1_052_672 + 1_234  # 4 KiB-aligned target with a 1,234-byte prefix
    length = 2_000_000
    client = AlignedClient()
    location = ResolvedLocation(raw_location=object(), file_size=start + length + 10, mime_type=None, dc_id=5)
    metrics = _metrics()

    output = b""
    async for chunk in iter_bytes(client, location, start=start, length=length, metrics=metrics):
        output += chunk

    assert output == bytes((start + i) & 0xFF for i in range(length))
    assert metrics.prefix_bytes == 1_234
    assert [r["offset"] for r in client.requests] == [
        1_052_672,  # head pieces from the 4 KiB boundary up to the window edge
        1_576_960,
        1_839_104,
        1_970_176,
        2_035_712,
        2_068_480,
        2_084_864,
        2_093_056,
        2_097_152,  # next window, back on the request grid
    ]
    assert [r["request_size"] for r in client.requests] == [
        524_288, 262_144, 131_072, 65_536, 32_768, 16_384, 8_192, 4_096, 524_288,
    ]
    assert all(d.closed for d in client.downloads)


async def test_start_near_window_end_stays_in_one_window() -> None:
    """Even 100 bytes before a window edge, no request crosses it: a 4 KiB
    fitted head covers the remainder, then the main iterator starts at the
    next window boundary."""
    start = (1024 * 1024) - 100
    length = 4_000
    client = AlignedClient()
    location = ResolvedLocation(raw_location=object(), file_size=start + length + 10, mime_type=None, dc_id=5)

    output = b""
    async for chunk in iter_bytes(client, location, start=start, length=length, metrics=_metrics()):
        output += chunk

    assert output == bytes((start + i) & 0xFF for i in range(length))
    assert [r["offset"] for r in client.requests] == [1_044_480, 1_048_576]
    assert [r["request_size"] for r in client.requests] == [4_096, 524_288]


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
