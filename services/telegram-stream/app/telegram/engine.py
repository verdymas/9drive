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
because it already does the three things that are easy to get wrong:
byte-offset (not chunk-index) addressing, misaligned start offsets
(`_GenericDownloadIter`), and DC export/import with sender reuse. We stop
it at the requested end.

ponytail: sequential — one in-flight Telegram request per stream, no
prefetch. Upgrade path if a measured run shows throughput below the
playback bitrate: wrap `iter_bytes` in a bounded `asyncio.Queue` producer
that launches N `iter_download` ranges concurrently and emits them in
byte order. Add when avg_mbps in `stream_end` is short, not before.
"""
from __future__ import annotations

from typing import Any, AsyncGenerator

from app.core.config import settings
from app.core.errors import AppError
from app.observability import (
    StreamMetrics,
    emit,
    inc_file_reference_refresh,
    inc_flood_wait,
)
from app.telegram.client_manager import ClientManager
from app.telegram.credentials import fetch_credentials
from app.telegram.file_resolver import FileResolver, ResolvedLocation

# telethon.tl.custom.messagebutton / download semantics: request_size is floored
# to MIN_CHUNK_SIZE (4 KiB) and capped at MAX_CHUNK_SIZE (512 KiB).
_TELETHON_MAX_CHUNK = 512 * 1024

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
resolver = FileResolver()


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


async def iter_bytes(
    client: TelethonAdapter,
    location: ResolvedLocation,
    *,
    start: int,
    length: int,
    metrics: StreamMetrics,
) -> AsyncGenerator[bytes, None]:
    """Yield exactly `length` bytes of the document starting at `start`.

    Cancellation needs no stop flag: when the client disconnects, Starlette
    throws CancelledError into this generator, `finally` closes the download
    iterator, and the Telegram sender is released.
    """
    stream = client.raw.iter_download(
        location.raw_location,
        offset=start,
        # Telethon rounds request_size down to a multiple of 4 KiB and clamps
        # it to 512 KiB; clamp here so the configured value isn't silently
        # different from the one we log and tune against.
        request_size=min(settings.chunk_size_bytes, _TELETHON_MAX_CHUNK),
        file_size=location.file_size,
    )
    remaining = length
    try:
        async for chunk in stream:
            if not chunk:
                break
            data = bytes(chunk[:remaining]) if len(chunk) > remaining else bytes(chunk)
            metrics.mark_first_byte()
            metrics.add_chunk(len(data))
            yield data
            remaining -= len(data)
            if remaining <= 0:
                return
    except Exception:
        # A mid-stream failure is usually an expired file_reference. The status
        # is already sent, so recovery belongs to the player's retry — but drop
        # the cached location so that retry re-resolves the reference instead of
        # reusing the stale one for the rest of the cache TTL.
        await resolver.invalidate(metrics.provider_id, metrics.channel_id, int(metrics.message_id or 0))
        inc_file_reference_refresh()
        raise
    finally:
        await stream.close()
    if remaining > 0:
        # A truncated body under 200/206 is forbidden. Headers are already sent
        # at this point, so raising tears the connection down — the client sees
        # a failed transfer rather than silently losing bytes.
        emit("stream_truncated", request_id=metrics.request_id, missing_bytes=remaining)
        raise AppError("SHORT_READ", "Telegram returned fewer bytes than the recorded file size.", 502)


__all__ = ["TelethonAdapter", "clients", "resolver", "resolve_document", "iter_bytes"]
