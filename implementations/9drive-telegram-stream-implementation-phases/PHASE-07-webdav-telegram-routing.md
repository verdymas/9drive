# Phase 07 — Route Telegram WebDAV Reads Through `telegram-stream`

## Goal

Use the existing `/webdav` endpoint and route Telegram-backed file bytes through the new gateway while preserving current listing and Google behavior.

## Desired Behavior

```text
PROPFIND → existing DB virtual filesystem
HEAD → DB metadata when sufficient
GET Google → existing Google flow
Range GET Google → existing Google flow
GET Telegram → TelegramStreamGateway → telegram-stream
Range GET Telegram → TelegramStreamGateway → telegram-stream
```

## Provider Detection

Use the existing file/provider mapping, never filename/path heuristics.

## Logical Filename

WebDAV/Jellyfin must see the 9Drive logical filename even if Telegram physical filenames become opaque.

## Range

Forward Range exactly and return correct 206/416/Content-Range semantics.

## HEAD

Prefer DB size/MIME/mtime/etag where reliable. Avoid Telegram calls for HEAD unless actually needed.

## Error Mapping

Map missing remote file, unavailable session, rate limit, and stream failure to safe HTTP/WebDAV errors.

Never return 200 with an empty/truncated body on failure.

## Tests

Add integration tests for Telegram full GET, Range GET, exact bytes, 206 headers, invalid range, logical filename, PROPFIND unchanged, and Google regression.

## Manual curl

Document safe curl examples for HEAD and Range tests without committing secrets.
