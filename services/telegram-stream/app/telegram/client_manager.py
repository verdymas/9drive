"""Telegram client manager (Phase 03).

The streaming service must NOT log in once per range request. The
ClientManager holds a connected PyroFork `Client` per `providerId` (one
account == one client in normal use), reuses it across requests, and
recreates it on reconnect or invalidation. Media sessions per DC are
reused via `client.media_sessions[dc]` (PyroFork does this for us; we
just keep the reference).

We keep this module small and free of HTTP concerns — it is owned by the
streaming service. It is **not** used directly from the FastAPI handler;
the handler will:
  1) call `manager.get_client(provider_id, ...)` to obtain a connected
     client,
  2) call `file_resolver.resolve(client, channel_id, message_id)` to
     get an `InputDocumentFileLocation`,
  3) feed those to the byte streamer (Phase 04).

Design choices (per the audit doc, §6/§7):
  - A `TelegramClient` is a thin Protocol so the engine can be tested
    without PyroFork. The production implementation wraps a PyroFork
    `Client`. There is exactly one production implementation, no abstract
    base class needed.
  - Invalidation is an explicit method. We do not silently re-create.
  - Bounded per-DC media session cache: PyroFork's own cache is bounded
    by `MAX_CONCURRENT_TRANSMISSIONS`; we do not add a second cache.
  - PyroFork import is lazy (`_load_pyrofork`) so unit tests run without
    the dependency installed.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Thin protocol that abstracts PyroFork's Client. The production factory
# returns a wrapper that satisfies this; tests pass a deterministic stub.
# ─────────────────────────────────────────────────────────────────────────
class TelegramClient(Protocol):
    async def get_input_entity(self, peer: Any) -> Any: ...
    async def get_messages(self, peer: Any, *, ids: list[int]) -> list[Any]: ...
    async def invoke(self, request: Any) -> Any: ...
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    @property
    def media_sessions(self) -> dict[int, Any]: ...
    @property
    def is_connected(self) -> bool: ...


@dataclass
class ClientHealth:
    provider_id: str
    connected: bool
    last_used_at: float
    login_count: int
    reconnect_count: int
    invalidation_count: int


@dataclass
class _ClientEntry:
    provider_id: str
    client: TelegramClient
    connected_at: float
    last_used_at: float
    login_count: int = 1
    reconnect_count: int = 0
    invalidation_count: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


# Type alias for the factory that builds a connected client. The factory
# MUST return an already-started client (so the manager never sees a
# half-initialized client).
ClientFactory = Callable[[str], Awaitable[TelegramClient]]


class ClientManager:
    """Per-providerId connected client cache. No login per range."""

    def __init__(self, factory: ClientFactory, *, idle_ttl_seconds: float = 600.0) -> None:
        self._factory = factory
        self._entries: dict[str, _ClientEntry] = {}
        self._lock = asyncio.Lock()
        self._idle_ttl = idle_ttl_seconds

    async def get_client(self, provider_id: str) -> TelegramClient:
        """Return the connected client for the provider, creating it on first use."""
        async with self._lock:
            entry = self._entries.get(provider_id)
            if entry is not None and entry.client.is_connected:
                entry.last_used_at = time.time()
                return entry.client
            if entry is not None and not entry.client.is_connected:
                # The previous client was stopped (e.g. by shutdown). Build a
                # fresh one and count it as a reconnect.
                client = await self._factory(provider_id)
                await client.start()
                entry.client = client
                entry.connected_at = time.time()
                entry.reconnect_count += 1
                entry.last_used_at = time.time()
                return client
            # Cold path: build + start, register.
            client = await self._factory(provider_id)
            await client.start()
            entry = _ClientEntry(
                provider_id=provider_id,
                client=client,
                connected_at=time.time(),
                last_used_at=time.time(),
            )
            self._entries[provider_id] = entry
            return client

    async def invalidate(self, provider_id: str) -> None:
        """Drop the cached client for one provider (e.g. on session revoke)."""
        async with self._lock:
            entry = self._entries.pop(provider_id, None)
        if entry is None:
            return
        entry.invalidation_count += 1
        try:
            await entry.client.stop()
        except Exception:  # noqa: BLE001 — invalidation is best-effort
            logger.warning("telegram-stream: client stop failed during invalidate provider=%s", provider_id)

    async def health(self, provider_id: str) -> ClientHealth | None:
        async with self._lock:
            entry = self._entries.get(provider_id)
        if entry is None:
            return None
        return ClientHealth(
            provider_id=entry.provider_id,
            connected=entry.client.is_connected,
            last_used_at=entry.last_used_at,
            login_count=entry.login_count,
            reconnect_count=entry.reconnect_count,
            invalidation_count=entry.invalidation_count,
        )

    async def shutdown(self) -> None:
        async with self._lock:
            entries = list(self._entries.values())
            self._entries.clear()
        for entry in entries:
            try:
                await entry.client.stop()
            except Exception:  # noqa: BLE001 — shutdown is best-effort
                logger.warning("telegram-stream: client stop failed during shutdown provider=%s", entry.provider_id)

    async def reclaim_idle(self) -> int:
        """Stop clients that have not been used for `idle_ttl` seconds. Returns the count."""
        now = time.time()
        to_stop: list[_ClientEntry] = []
        async with self._lock:
            for provider_id, entry in list(self._entries.items()):
                if now - entry.last_used_at > self._idle_ttl:
                    del self._entries[provider_id]
                    to_stop.append(entry)
        for entry in to_stop:
            try:
                await entry.client.stop()
            except Exception:  # noqa: BLE001
                logger.warning("telegram-stream: idle reclaim stop failed provider=%s", entry.provider_id)
        return len(to_stop)
