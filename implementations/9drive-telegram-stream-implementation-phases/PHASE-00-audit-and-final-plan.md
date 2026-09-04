# Phase 00 — Audit Existing Streaming Path and Produce Final Integration Plan

## Goal

Audit current 9Drive WebDAV + Telegram streaming and the reference projects, then produce the final implementation plan for the internal service named `telegram-stream`.

This phase is AUDIT + PLAN only. Do not implement the main feature yet.

## Global Rules

- Existing 9Drive backend remains source of truth for files, folders, provider mappings, auth, and WebDAV paths.
- `telegram-stream` must not own a second file index/database.
- Do not create a second WebDAV endpoint.
- Do not break Google Drive WebDAV.
- Do not use Playwright.
- References are read-only.

## References

Use in this priority:

```text
1. references/telegram-stremio
2. references/tgfs
3. references/telegram-drive-webdav
4. existing working Google Drive WebDAV in 9Drive
5. references/teledrive
```

If missing, clone them under `references/`, but never modify or add as dependencies.

## Audit Existing 9Drive

Trace exact source files/functions for:

```text
Jellyfin
→ WebDAV
→ virtual path resolver
→ File record
→ provider routing
→ GET / Range GET
→ provider stream
→ HTTP response
```

Audit:

- PROPFIND
- HEAD
- GET
- Range parsing
- 206/416 behavior
- Content-Range / Content-Length / Accept-Ranges
- provider read abstraction
- Telegram download method
- Telegram client/session lifecycle
- reconnect behavior
- client abort propagation
- backpressure
- buffering
- retries/FloodWait
- caches

## Google Drive Baseline

Use a known-working Google Drive file and record:

```text
HEAD
GET
Range GET
status
headers
TTFB
bytes returned
provider method
```

## Telegram Current Failure

Record the same for a Telegram-backed file.

Prove why playback buffers. Do not assume it is only HTTP Range.

Measure/inspect where possible:

```text
TTFB
first Telegram chunk latency
average throughput
reconnect/session setup per seek
requested offset
actual Telegram offset
actual returned bytes
```

## Telegram-Stremio Reference

Study only the high-performance streaming patterns:

- FastAPI streaming data plane
- PyroFork
- raw MTProto `upload.GetFile`
- offset + limit reads
- file property cache
- DC/media session reuse
- bounded prefetch
- parallel chunk fetch
- ordered output
- stale FILE_REFERENCE refresh
- retry/FloodWait
- client disconnect cancellation
- throughput telemetry

Do NOT port Stremio catalog/TMDB/indexing/subscription features.

## tgfs Reference

Study WebDAV Range → begin/end → Telegram offset streaming → 206 behavior.

## Telegram-Drive Reference

Study WebDAV compatibility, byte ranges, media seek, large-file behavior.

## teledrive Reference

Use only for relevant Telegram storage/session concepts.

## Validate Final Architecture

Target:

```text
Jellyfin
   ↓
9Drive WebDAV
   ↓
StorageReadRouter / existing equivalent
   ├── Google → existing flow
   └── Telegram
          ↓
      TelegramStreamGateway
          ↓
     signed internal HTTP
          ↓
      telegram-stream
          ↓
   Telegram Client Manager
          ↓
   file/media session cache
          ↓
   range byte streamer
          ↓
      Telegram MTProto
```

## Session Compatibility Audit

Determine whether the existing Telegram session used by 9Drive can be consumed by PyroFork.

Do not assume compatibility.

If incompatible, design the smallest safe streaming-session control plane for the same Telegram provider/account.

## Security Boundary

Prefer the stream request to contain only what is needed:

```text
provider/account identity
channelId
messageId
known size
HTTP Range
```

Do not give `telegram-stream` Prisma/MySQL access unless proven necessary.

## Deliverable

Create:

```text
docs/audits/telegram-stream-architecture-audit.md
```

Include root cause, baseline comparison, reference findings, session strategy, security model, exact implementation phases, expected files to change, risks, rollback.

## Final Summary

```text
Telegram Stream Audit Complete
Current WebDAV: ...
Current Telegram Streaming: ...
Primary Bottleneck: ...
Google Baseline: ...
Session Compatibility: ...
Recommended Architecture: ...
Implementation Ready: YES / NO
```
