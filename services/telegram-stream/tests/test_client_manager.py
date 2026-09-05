from __future__ import annotations

import asyncio

import pytest

from app.telegram.client_manager import ClientManager, TelegramClient


class StubClient:
    def __init__(self) -> None:
        self.is_connected = True
        self.start_count = 0
        self.stop_count = 0

    async def start(self) -> None:
        self.start_count += 1

    async def stop(self) -> None:
        self.stop_count += 1


async def test_get_client_creates_once_and_reuses() -> None:
    factory_calls: list[str] = []

    async def factory(provider_id: str) -> TelegramClient:
        factory_calls.append(provider_id)
        return StubClient()

    manager = ClientManager(factory)
    a = await manager.get_client("acct-1")
    b = await manager.get_client("acct-1")
    assert a is b
    assert factory_calls == ["acct-1"]
    health = await manager.health("acct-1")
    assert health is not None
    assert health.connected is True
    assert health.login_count == 1
    assert health.reconnect_count == 0
    assert health.invalidation_count == 0
    await manager.shutdown()


async def test_get_client_for_different_providers() -> None:
    factory_calls: list[str] = []

    async def factory(provider_id: str) -> TelegramClient:
        factory_calls.append(provider_id)
        return StubClient()

    manager = ClientManager(factory)
    a = await manager.get_client("acct-1")
    b = await manager.get_client("acct-2")
    assert a is not b
    assert sorted(factory_calls) == ["acct-1", "acct-2"]
    await manager.shutdown()


async def test_get_client_reconnects_after_stop() -> None:
    started: list[StubClient] = []

    async def factory(provider_id: str) -> TelegramClient:
        c = StubClient()
        started.append(c)
        return c

    manager = ClientManager(factory)
    a = await manager.get_client("acct-1")
    # Simulate the underlying client disconnecting.
    a.is_connected = False
    b = await manager.get_client("acct-1")
    assert b is not a
    assert len(started) == 2
    health = await manager.health("acct-1")
    assert health is not None
    assert health.reconnect_count == 1
    await manager.shutdown()


async def test_invalidate_drops_and_stops() -> None:
    stopped: list[StubClient] = []

    async def factory(provider_id: str) -> TelegramClient:
        c = StubClient()
        original_stop = c.stop

        async def wrapped_stop() -> None:
            stopped.append(c)
            await original_stop()

        c.stop = wrapped_stop  # type: ignore[method-assign]
        return c

    manager = ClientManager(factory)
    await manager.get_client("acct-1")
    await manager.invalidate("acct-1")
    assert len(stopped) == 1
    assert (await manager.health("acct-1")) is None


async def test_shutdown_stops_all() -> None:
    stopped = 0

    async def factory(provider_id: str) -> TelegramClient:
        c = StubClient()
        original_stop = c.stop

        async def wrapped_stop() -> None:
            nonlocal stopped
            stopped += 1
            await original_stop()

        c.stop = wrapped_stop  # type: ignore[method-assign]
        return c

    manager = ClientManager(factory)
    await manager.get_client("acct-1")
    await manager.get_client("acct-2")
    await manager.shutdown()
    assert stopped == 2
    assert (await manager.health("acct-1")) is None
    assert (await manager.health("acct-2")) is None


async def test_shutdown_is_idempotent() -> None:
    async def factory(provider_id: str) -> TelegramClient:
        return StubClient()

    manager = ClientManager(factory)
    await manager.get_client("acct-1")
    await manager.shutdown()
    await manager.shutdown()
