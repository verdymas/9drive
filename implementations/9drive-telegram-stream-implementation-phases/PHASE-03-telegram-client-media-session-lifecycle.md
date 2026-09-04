# Phase 03 — Telegram Client Manager and Media/DC Session Lifecycle

## Goal

Implement reusable Telegram connectivity inside `telegram-stream` so Jellyfin seeks do not reconnect/login each time.

## Reference

Study `references/telegram-stremio` client/media-session patterns, but do not copy source.

## Client Manager

Implement a manager keyed by the correct provider/account identity.

Responsibilities:

```text
connect
reuse
reconnect
invalidate
health
shutdown
```

Never create a fresh authenticated Telegram client for every range request.

## File/Media Resolution

Resolve the physical file using the existing 9Drive Telegram remote identity, typically channel/message mapping.

Cache refreshable file properties only where safe.

Handle stale FILE_REFERENCE cleanly.

## Media/DC Sessions

If PyroFork/raw MTProto benefits from reusable media sessions per DC, implement bounded session caching.

Do not create a media session per chunk.

## Errors

Handle missing message/file, session expiry, auth requirement, DC migration, FloodWait, timeout, stale file reference.

Avoid aggressive retries.

## Tests

Cover client reuse, cache hit/miss, stale reference refresh, reconnect, shutdown, and “no login per request”.

Add observability hooks for cache hits/reconnects/reference refreshes.
