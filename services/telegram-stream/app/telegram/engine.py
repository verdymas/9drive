"""Production byte engine: Telethon-backed range reads.

Why Telethon and not PyroFork (a change from the original phase plan):
its `StringSession` carries exactly the four fields 9Drive's stored
GramJS/teleproto session carries — `dc_id | ip | port | auth_key` — so the
credential the backend already holds can be repacked losslessly
(`backend/src/modules/telegram/telethon-session.ts`). PyroFork's format
additionally needs `api_id`, `user_id` and `is_bot`, which is what forced
the original plan's separate provisioning + second login. Nothing here
logs in; nothing here stores a session.

`iter_download` is used rather than a hand-rolled `upload.GetFile` loop
because it owns DC export/import and sender reuse. HTTP range starts are
aligned to Telegram's 4 KiB offset granularity before going upstream (the
short prefix is discarded so the client still gets the exact requested
bytes), and the iterator receives an `InputDocumentFileLocation` with no
`file_size`: Telethon then keeps `_DirectDownloadIter` for every seek, while
`_GenericDownloadIter` would re-fetch the unaligned head on each chunk.

Read-ahead: `iter_bytes` keeps one in-flight Telegram request per stream by
default. `TELEGRAM_STREAM_PREFETCH_DEPTH` (P2) enables a bounded read-ahead:
`depth` workers stride through the range concurrently and are merged back in
byte order through one bounded queue each (see `_iter_bytes_prefetch`). 0/1
keep the strictly sequential behavior — enable only on a measured A/B win.
"""
from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any, AsyncGenerator

from app.core.config import settings
from app.core.errors import AppError
from app.observability import (
    StreamMetrics,
    emit,
    inc_cdn_redirect,
    inc_file_reference_refresh,
    inc_flood_wait,
)
from app.telegram.client_manager import ClientManager
from app.telegram.credentials import fetch_credentials
from app.telegram.file_resolver import FileResolver, ResolvedLocation

# telethon.tl.custom.messagebutton / download semantics: request_size is floored
# to MIN_CHUNK_SIZE (4 KiB) and capped at MAX_CHUNK_SIZE (512 KiB).
_TELETHON_MIN_CHUNK = 4 * 1024
_TELETHON_MAX_CHUNK = 512 * 1024

# Telegram rejects `upload.getFile` requests in two ways (both verified live
# 2026-10-18 with a direct RPC probe):
#   - the limit must be a power-of-two multiple of 4 KiB (12 KiB, 36 KiB,
#     40 KiB, 96 KiB, 260 KiB, 296 KiB all got LimitInvalidError at phase 0);
#   - a request must not cross a 1 MiB window, i.e.
#     (offset % 1 MiB) + limit <= 1 MiB (512 KiB from offset 41,639,936 or
#     999,424 failed; requests ending exactly at the window edge succeeded).
_FILE_WINDOW = 1024 * 1024


def _ceil_min_chunk(n: int) -> int:
    return max(_TELETHON_MIN_CHUNK, -(-n // _TELETHON_MIN_CHUNK) * _TELETHON_MIN_CHUNK)

# Prefetch sentinel: a worker pushes this when it will produce no more chunks
# (normal exhaustion or a recorded error). The consumer treats it as
# end-of-worker; for a range that still needs bytes that is a short read.
_END = object()

# Telethon is imported lazily so the unit tests (and any environment that
# only exercises the HTTP contract) run without the dependency installed.
_telethon: Any = None


def _load_telethon() -> Any:
    global _telethon
    if _telethon is None:
        import telethon  # noqa: PLC0415 — deliberate lazy import
        from telethon.sessions import StringSession  # noqa: PLC0415

        _telethon = (telethon, StringSession)
    return _telethon


def _peer(channel_id: str | int) -> int:
    """9Drive stores bare channel ids; Telethon wants the -100-marked form."""
    text = str(channel_id).strip()
    return int(text) if text.startswith("-") else int(f"-100{text}")


def effective_request_size() -> int:
    """The Telethon request size actually sent upstream.

    Floored to MIN_CHUNK_SIZE (4 KiB), capped at MAX_CHUNK_SIZE (512 KiB), and
    rounded down to a power-of-two multiple of 4 KiB. Only power-of-two
    multiples divide the 1 MiB request window, so a request grid can never
    produce a window-crossing request (see `_FILE_WINDOW`); e.g. a configured
    100_000 rounds to 65_536 rather than 98_304.
    """
    size = min(settings.chunk_size_bytes, _TELETHON_MAX_CHUNK)
    size -= size % _TELETHON_MIN_CHUNK
    if size < _TELETHON_MIN_CHUNK:
        return _TELETHON_MIN_CHUNK
    return 1 << (size.bit_length() - 1)


def _iter_location(location: ResolvedLocation) -> tuple[Any, int]:
    """`iter_download` input that keeps the direct iterator selection.

    Telethon computes a chunk `limit` from the file size whenever it can see
    one (a raw `Document` carries its size), and with a non-`None` limit it
    only picks `_DirectDownloadIter` when the byte offset happens to divide
    it — otherwise `_GenericDownloadIter` re-fetches the unaligned head of
    every chunk. Handing it the `InputDocumentFileLocation` instead (same
    fields Telethon would build) and never passing `file_size` keeps
    `limit=None`, so the engine can drive direct iterators from any
    4 KiB-aligned offset with its own per-phase request sizes: no head
    re-fetch, ≤4 KiB discarded prefix per seek.
    """
    raw = location.raw_location
    try:
        telethon, _ = _load_telethon()
        if isinstance(raw, telethon.tl.types.Document):
            return (
                telethon.tl.types.InputDocumentFileLocation(
                    id=raw.id,
                    access_hash=raw.access_hash,
                    file_reference=raw.file_reference,
                    thumb_size="",
                ),
                location.dc_id,
            )
    except ImportError:  # unit tests run without telethon installed
        pass
    return raw, location.dc_id


_REAUTH = AppError(
    "TELEGRAM_REAUTH_REQUIRED",
    "The Telegram session is no longer valid; reconnect the account in 9Drive.",
    503,
)


def _classify(exc: BaseException) -> AppError | None:
    """Map a Telethon RPC error to a status. Returns None if it isn't one."""
    telethon, _ = _load_telethon()
    errors = telethon.errors
    if isinstance(exc, errors.UnauthorizedError) or isinstance(exc, errors.AuthKeyDuplicatedError):
        return _REAUTH
    if isinstance(exc, errors.FloodWaitError):
        # Retry-After is the operator's signal; looping here would only deepen
        # the limit. Let the player back off.
        inc_flood_wait()
        return AppError("TELEGRAM_FLOOD_WAIT", f"Telegram rate limit; retry in {exc.seconds}s.", 429)
    if isinstance(exc, (errors.ChannelPrivateError, errors.ChannelInvalidError)):
        return AppError("CHANNEL_UNAVAILABLE", "The storage channel is not reachable by this account.", 403)
    # Telegram negotiated a higher API layer than this Telethon release knows
    # (e.g. the backend's teleproto just moved up). The server sends a
    # constructor the parser doesn't recognise, mid-deserialization. The
    # request is unservable until the library catches up.
    if isinstance(exc, errors.TypeNotFoundError):
        return AppError("TELEGRAM_LAYER_MISMATCH", "Telegram sent an object this client cannot parse.", 502)
    return None


def _is_cdn_redirect(exc: BaseException) -> bool:
    """Telegram can answer a download with a CDN redirect, which Telethon
    raises as its private `_CdnRedirect`. A type-name check is the only
    upgrade-safe probe; it feeds a counter only (no behavior change until P4
    decides whether to engage Telethon's CDN support)."""
    return type(exc).__name__ == "_CdnRedirect"


class TelethonAdapter:
    """Satisfies `client_manager.TelegramClient` over a Telethon client."""

    def __init__(self, client: Any) -> None:
        self._client = client

    async def start(self) -> None:
        await self._client.connect()
        # Never `client.start()`: that tries to *log in* (OTP callback) when the
        # session is dead. A revoked key must surface as a clear error instead,
        # so the operator knows to reconnect the account.
        if not await self._client.is_user_authorized():
            raise _REAUTH

    async def stop(self) -> None:
        await self._client.disconnect()

    @property
    def is_connected(self) -> bool:
        return bool(self._client.is_connected())

    @property
    def raw(self) -> Any:
        return self._client

    async def get_input_entity(self, peer: Any) -> Any:
        return await self._client.get_input_entity(_peer(peer) if isinstance(peer, (str, int)) else peer)

    async def get_messages(self, peer: Any, *, ids: list[int]) -> list[Any]:
        result = await self._client.get_messages(peer, ids=ids)
        return [m for m in (result if isinstance(result, list) else [result]) if m is not None]


async def _build_client(provider_id: str) -> TelethonAdapter:
    telethon, string_session = _load_telethon()
    credentials = await fetch_credentials(provider_id)
    client = telethon.TelegramClient(
        string_session(credentials.session),
        credentials.api_id,
        credentials.api_hash,
    )
    return TelethonAdapter(client)


clients = ClientManager(_build_client)
resolver = FileResolver(ttl_seconds=settings.effective_resolver_ttl_seconds)


async def resolve_document(
    *, provider_id: str, channel_id: str, message_id: int
) -> tuple[TelethonAdapter, ResolvedLocation]:
    """Connect (or reuse a connection) and resolve the document.

    Called *before* the response is committed so a dead session or a missing
    message becomes a real status code rather than an empty 206.
    """
    try:
        client = await clients.get_client(provider_id)
        return client, await resolver.resolve(client, provider_id, channel_id, message_id)
    except FileNotFoundError as exc:
        raise AppError("FILE_NOT_FOUND", "Telegram message or document is gone.", 404) from exc
    except AppError:
        raise
    except Exception as exc:
        mapped = _classify(exc)
        if mapped is None:
            raise
        if mapped is _REAUTH:
            # The cached client holds a key Telegram has rejected; drop it so
            # the next request rebuilds from whatever the backend now stores.
            await clients.invalidate(provider_id)
        raise mapped from exc


async def _iter_bytes_prefetch(
    client: TelethonAdapter,
    location: ResolvedLocation,
    *,
    start: int,
    length: int,
    metrics: StreamMetrics,
    depth: int,
) -> AsyncGenerator[bytes, None]:
    """Read-ahead with `depth` concurrent `iter_download` workers, merged in byte order.

    Worker `i` fetches every `depth`-th 512 KiB chunk from
    `aligned_start + i * request_size` (stride = `depth * request_size`), so
    the union of all workers covers the requested range with the sequential
    path's wire sizes, but `depth` RPCs in flight instead of one. Each worker
    feeds a bounded queue (`maxsize=2`), so memory stays at ~2 chunks per
    worker plus the in-flight request, and every worker stays at most ~3
    chunks ahead of the merge point.

    The byte math (prefix discard, tail trim, exact `length` accounting) is
    identical to the sequential path, so a run where every worker succeeds
    emits the same bytes; failures surface exactly like the sequential path's
    (resolver invalidation + classified error, or `SHORT_READ`).
    """
    request_size = effective_request_size()
    # Workers start on the request-size grid: every request here spans exactly
    # one grid step and `request_size` divides the 1 MiB window, so worker
    # requests can never cross one (the sequential path's window plan exists
    # because explicit non-grid sizes there may straddle a boundary). The
    # trade-off is a larger discarded prefix (≤ one request size).
    aligned_start = start - (start % request_size)
    prefix_skip = start - aligned_start
    total_needed = prefix_skip + length
    total_chunks = (total_needed + request_size - 1) // request_size
    stride = depth * request_size
    file, dc_id = _iter_location(location)
    metrics.prefix_bytes = prefix_skip

    queues: list[asyncio.Queue] = [asyncio.Queue(maxsize=2) for _ in range(depth)]
    errors: list[BaseException] = []

    async def produce(i: int) -> None:
        try:
            # No `limit`/`file_size`: explicit limits on 4 KiB-aligned offsets
            # would flip Telethon back to the generic iterator and re-fetch a
            # head per chunk. The bounded queues + the consumer's stop keep
            # every worker at most ~3 chunks ahead of the merge point.
            stream = client.raw.iter_download(
                file,
                offset=aligned_start + i * request_size,
                stride=stride,
                chunk_size=request_size,
                request_size=request_size,
                dc_id=dc_id,
            )
            try:
                async for chunk in stream:
                    if not chunk:
                        break
                    await queues[i].put(chunk)
            finally:
                await stream.close()
            await queues[i].put(_END)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001 — surfaced to the consumer
            errors.append(exc)
            # Unblock the consumer if it is waiting on this worker's queue.
            with suppress(asyncio.CancelledError):
                await queues[i].put(_END)

    tasks = [asyncio.create_task(produce(i)) for i in range(min(depth, total_chunks))]
    metrics.iterator = f"prefetch(k={depth})"
    slot = 0
    remaining = length
    try:
        while remaining > 0:
            item = await queues[slot % depth].get()
            slot += 1
            if errors:
                raise errors[0]
            if item is _END:
                break
            data = bytes(item)
            if prefix_skip:
                if len(data) <= prefix_skip:
                    prefix_skip -= len(data)
                    continue
                data = data[prefix_skip:]
                prefix_skip = 0
            if len(data) > remaining:
                data = data[:remaining]
            metrics.mark_first_byte()
            metrics.add_chunk(len(data))
            yield data
            remaining -= len(data)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if _is_cdn_redirect(exc):
            inc_cdn_redirect()
        await resolver.invalidate(metrics.provider_id, metrics.channel_id, int(metrics.message_id or 0))
        inc_file_reference_refresh()
        raise
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    if remaining > 0:
        emit("stream_truncated", request_id=metrics.request_id, missing_bytes=remaining)
        raise AppError("SHORT_READ", "Telegram returned fewer bytes than the recorded file size.", 502)


async def iter_bytes(
    client: TelethonAdapter,
    location: ResolvedLocation,
    *,
    start: int,
    length: int,
    metrics: StreamMetrics,
) -> AsyncGenerator[bytes, None]:
    """Yield exactly `length` bytes of the document starting at `start`.

    Reads sequentially by default; `TELEGRAM_STREAM_PREFETCH_DEPTH >= 2`
    switches to the bounded read-ahead in `_iter_bytes_prefetch`.

    Cancellation needs no stop flag: when the client disconnects, Starlette
    throws CancelledError into this generator, `finally` closes the download
    iterator, and the Telegram sender is released.
    """
    depth = settings.effective_prefetch_depth
    metrics.prefetch_depth = depth if depth >= 2 else 0
    if depth >= 2:
        inner = _iter_bytes_prefetch(
            client, location, start=start, length=length, metrics=metrics, depth=depth
        )
        try:
            async for chunk in inner:
                yield chunk
        finally:
            # `async for` does not close its iterator on early exit: without
            # this, an aclose() of *this* generator would leave the inner one
            # (and its workers) suspended until GC. Cancellation and normal
            # completion make this a no-op.
            await inner.aclose()
        return

    # The HTTP start is aligned to 4 KiB and the discarded prefix is kept
    # ≤ 4 KiB, but stream-wide safety needs more than alignment: Telegram
    # accepts only power-of-two limits and rejects any request that crosses a
    # 1 MiB window (both verified live; see `_FILE_WINDOW`). `request_size` is
    # already rounded to a power of two that divides the window, so the engine
    # drives a power-of-two plan:
    #   - request-grid starts: one plain direct iterator (its phases and
    #     limits are always safe);
    #   - anything else: the head up to the window edge is split into
    #     power-of-two pieces (binary decomposition — e.g. 296 KiB becomes
    #     256 + 32 + 8 KiB), then the main iterator resumes at the window
    #     edge, which is back on the request grid. Telethon's generic iterator
    #     would handle arbitrary offsets but re-fetches every chunk's head;
    #     the direct iterator does not, so the engine sizes the requests.
    request_size = effective_request_size()
    aligned_start = start - (start % _TELETHON_MIN_CHUNK)
    prefix_skip = start - aligned_start
    file, dc_id = _iter_location(location)
    metrics.prefix_bytes = prefix_skip
    needed = prefix_skip + length

    # Each plan entry is (offset, request_size, span): a head piece stops
    # after `span` wire bytes (so it can never run into the next window),
    # while a `None` span is an open iterator that keeps fetching — only used
    # from the window edge, where every request stays on the safe grid.
    if aligned_start % request_size == 0:
        plan = [(aligned_start, request_size, None)]
    else:
        window_left = _FILE_WINDOW - (aligned_start % _FILE_WINDOW)
        piece_units = _ceil_min_chunk(min(needed, window_left)) // _TELETHON_MIN_CHUNK
        max_units = request_size // _TELETHON_MIN_CHUNK
        pos = aligned_start
        plan = []
        while piece_units > 0:
            take = min(1 << (piece_units.bit_length() - 1), max_units)
            step = take * _TELETHON_MIN_CHUNK
            plan.append((pos, step, step))
            pos += step
            piece_units -= take
        if needed > window_left:
            plan.append((aligned_start + window_left, request_size, None))

    remaining = length
    try:
        for offset, size, span in plan:
            stream = client.raw.iter_download(
                file,
                offset=offset,
                request_size=size,
                chunk_size=size,
                dc_id=dc_id,
            )
            metrics.iterator = type(stream).__name__
            # The span is checked *before* pulling the next chunk: fetching
            # first would issue the fitted head's continuation request, which
            # is exactly the window-crossing request this plan exists to
            # avoid. Open-ended spans (`None`) run until EOF or the range is
            # covered.
            phase_left = span
            try:
                iterator = stream.__aiter__()
                while phase_left is None or phase_left > 0:
                    try:
                        chunk = await iterator.__anext__()
                    except StopAsyncIteration:
                        break
                    if not chunk:
                        break
                    if phase_left is not None:
                        phase_left -= len(chunk)
                    if prefix_skip:
                        if len(chunk) <= prefix_skip:
                            prefix_skip -= len(chunk)
                            continue
                        chunk = chunk[prefix_skip:]
                        prefix_skip = 0
                    data = bytes(chunk[:remaining]) if len(chunk) > remaining else bytes(chunk)
                    metrics.mark_first_byte()
                    metrics.add_chunk(len(data))
                    yield data
                    remaining -= len(data)
                    if remaining <= 0:
                        return
            finally:
                await stream.close()
    except Exception as exc:
        if _is_cdn_redirect(exc):
            inc_cdn_redirect()
        # A mid-stream failure is usually an expired file_reference. The status
        # is already sent, so recovery belongs to the player's retry — but drop
        # the cached location so that retry re-resolves the reference instead of
        # reusing the stale one for the rest of the cache TTL.
        await resolver.invalidate(metrics.provider_id, metrics.channel_id, int(metrics.message_id or 0))
        inc_file_reference_refresh()
        raise
    if remaining > 0:
        # A truncated body under 200/206 is forbidden. Headers are already sent
        # at this point, so raising tears the connection down — the client sees
        # a failed transfer rather than silently losing bytes.
        emit("stream_truncated", request_id=metrics.request_id, missing_bytes=remaining)
        raise AppError("SHORT_READ", "Telegram returned fewer bytes than the recorded file size.", 502)


__all__ = ["TelethonAdapter", "clients", "resolver", "resolve_document", "iter_bytes", "effective_request_size"]
