"""File resolver: channelId + messageId -> InputDocumentFileLocation.

Caches the resolved location keyed by (providerId, channelId, messageId)
and refreshes on stale `FILE_REFERENCE_*` errors (the byte streamer
catches those and asks for a refresh).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)


class TelegramClientLike(Protocol):
    async def get_input_entity(self, peer: Any) -> Any: ...
    async def get_messages(self, peer: Any, *, ids: list[int]) -> list[Any]: ...


@dataclass
class ResolvedLocation:
    """Anything the byte streamer needs to call upload.GetFile."""
    raw_location: Any
    file_size: int
    mime_type: str | None
    dc_id: int


@dataclass
class _CacheEntry:
    location: ResolvedLocation
    cached_at: float


class FileResolver:
    def __init__(self, *, ttl_seconds: float = 60.0) -> None:
        self._cache: dict[tuple[str, str, int], _CacheEntry] = {}
        self._ttl = ttl_seconds

    async def resolve(
        self,
        client: TelegramClientLike,
        provider_id: str,
        channel_id: str,
        message_id: int,
    ) -> ResolvedLocation:
        key = (provider_id, channel_id, message_id)
        cached = self._cache.get(key)
        if cached is not None and (time.time() - cached.cached_at) < self._ttl:
            return cached.location
        location = await self._resolve_fresh(client, channel_id, message_id)
        self._cache[key] = _CacheEntry(location=location, cached_at=time.time())
        return location

    async def invalidate(self, provider_id: str, channel_id: str, message_id: int) -> None:
        self._cache.pop((provider_id, channel_id, message_id), None)

    async def _resolve_fresh(self, client: TelegramClientLike, channel_id: str, message_id: int) -> ResolvedLocation:
        peer = await client.get_input_entity(channel_id)
        messages = await client.get_messages(peer, ids=[message_id])
        if not messages:
            raise FileNotFoundError(f"message {message_id} not found in channel {channel_id}")
        message = messages[0]
        document = getattr(message, "document", None)
        if document is None:
            raise FileNotFoundError(f"message {message_id} has no document")
        # The real `InputDocumentFileLocation` is built by the byte streamer
        # from a `FileId` decode; this module just hands back the document
        # payload and the file metadata.
        return ResolvedLocation(
            raw_location=document,
            file_size=int(getattr(document, "size", 0)),
            mime_type=getattr(document, "mime_type", None),
            dc_id=int(getattr(document, "dc_id", 0)),
        )


__all__ = ["FileResolver", "ResolvedLocation", "FileNotFoundError"]


# The stdlib already has a FileNotFoundError; we re-export it under the
# module so callers don't need a second import.
FileNotFoundError = FileNotFoundError
