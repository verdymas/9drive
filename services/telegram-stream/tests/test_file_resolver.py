from __future__ import annotations

import pytest

from app.telegram.file_resolver import FileResolver, ResolvedLocation


class _Document:
    def __init__(self, *, size: int, mime_type: str | None, dc_id: int) -> None:
        self.size = size
        self.mime_type = mime_type
        self.dc_id = dc_id


class _Message:
    def __init__(self, doc: _Document | None) -> None:
        self.document = doc


class StubClient:
    def __init__(self, messages: dict[int, _Message]) -> None:
        self._messages = messages
        self.input_entity_calls = 0

    async def get_input_entity(self, _peer: object) -> object:
        self.input_entity_calls += 1
        return object()

    async def get_messages(self, _peer: object, *, ids: list[int]) -> list[_Message]:
        return [self._messages[i] for i in ids if i in self._messages]


async def test_resolve_returns_metadata_and_caches() -> None:
    client = StubClient({42: _Message(_Document(size=1024, mime_type="video/mp4", dc_id=2))})
    resolver = FileResolver(ttl_seconds=60.0)
    a = await resolver.resolve(client, "acct-1", "-1001", 42)
    b = await resolver.resolve(client, "acct-1", "-1001", 42)
    assert a is b
    assert isinstance(a, ResolvedLocation)
    assert a.file_size == 1024
    assert a.mime_type == "video/mp4"
    assert a.dc_id == 2
    # The stub is consulted only once; the second call is served from cache.
    assert client.input_entity_calls == 1


async def test_resolve_raises_when_message_missing() -> None:
    client = StubClient({})
    resolver = FileResolver(ttl_seconds=60.0)
    with pytest.raises(FileNotFoundError):
        await resolver.resolve(client, "acct-1", "-1001", 999)


async def test_resolve_raises_when_message_has_no_document() -> None:
    client = StubClient({42: _Message(None)})
    resolver = FileResolver(ttl_seconds=60.0)
    with pytest.raises(FileNotFoundError):
        await resolver.resolve(client, "acct-1", "-1001", 42)


async def test_invalidate_forces_re_resolve() -> None:
    client = StubClient({42: _Message(_Document(size=100, mime_type=None, dc_id=2))})
    resolver = FileResolver(ttl_seconds=60.0)
    await resolver.resolve(client, "acct-1", "-1001", 42)
    await resolver.invalidate("acct-1", "-1001", 42)
    await resolver.resolve(client, "acct-1", "-1001", 42)
    assert client.input_entity_calls == 2
