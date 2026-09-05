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


async def test_request_size_is_clamped_to_telethon_max(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "chunk_size_bytes", 4 * 1024 * 1024)
    client = FakeClient([b"A" * 4])
    await _collect(client, start=17, length=4)
    assert client.kwargs["request_size"] == 512 * 1024
    assert client.kwargs["offset"] == 17  # bytes, not a chunk index


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
