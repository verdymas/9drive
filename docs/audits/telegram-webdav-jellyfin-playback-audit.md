# Telegram WebDAV Jellyfin Playback — Audit

## Why Jellyfin can SEE Telegram-backed files

The WebDAV endpoint at `http://<host>:4000/webdav` exposes 9Drive's
database-backed virtual filesystem via the `webdav-server` v2 protocol library.

Listing is **provider-agnostic**. When Jellyfin issues `PROPFIND Depth:1` or
`Depth:infinity`:

1. `backend/src/modules/webdav/webdav.routes.ts` (the `propfindHandler`
   override) walks the requested path.
2. It uses `VirtualFileSystem` (`backend/src/modules/webdav/webdav-virtual-fs.ts`)
   which reads `Folder` and `File` rows from MySQL/Prisma — it never opens a
   provider connection.
3. Each `File` row carries `name`, `sizeBytes`, `mimeType`, `updatedAt` and
   `createdAt` — the library's `addXMLInfo` populates PROPFIND response XML
   from those columns directly.

Because the virtual FS is purely DB-backed, Telegram-backed files appear in
browsers and the Jellyfin library view **identically** to Google Drive-backed
files.

## Why Jellyfin cannot currently PLAY Telegram-backed files

Jellyfin needs `GET` with `Range: bytes=…` to probe MP4/MKV `moov` atoms and to
seek. The WebDAV controller funnels all byte requests through a single seam
function:

```
backend/src/modules/webdav/webdav.routes.ts (streamFile)
  → streamProviderFileToReadable(file, range)
  → backend/src/modules/webdav/webdav-virtual-fs.ts:407
```

`streamProviderFileToReadable` had only two branches:

- `provider === 's3'` → S3 `GetObjectCommand` with `Range`.
- default (Google Drive) → `fetch` to `drive/v3/files/<id>?alt=media` with
  optional `Range`.

**There was no `telegram` branch.** A `File` row with `provider === 'telegram'`
fell through to the Google Drive fetch, which built a URL of the form:

```
https://www.googleapis.com/drive/v3/files/telegram://-100…/42?alt=media
```

Google Drive returns `404 Not Found` for that id. The fetch threw, the route's
`stream.on('error', …)` handler returned `500 Internal Server Error`, and Jellyfin
gave up on playback. PROPFIND still worked (DB-only) — that is the visible
asymmetry.

## Why the FIRST fix attempt (temp file) still failed

The initial implementation added a `telegram` branch that downloaded the
**entire file** to a temp file under `os.tmpdir()` with
`await pipeline(iterable, createWriteStream(tmpPath))` and only *then* returned
`fs.createReadStream(tmpPath, { start, end })`.

Two fatal problems:

1. **Response headers were delayed until the full file downloaded.** Jellyfin
   sends a Range request and expects response headers (200/206 + Content-Length)
   within a few seconds. For a 2 GB movie the backend spent minutes pulling the
   whole Telegram file to disk before the first byte of the HTTP response was
   written, so Jellyfin aborted the request → playback failed.
2. **Every seek re-downloaded the entire file.** Each new Range request created
   a new temp file from scratch.

## What the Telegram SDK actually supports (verified against teleproto source)

Reading `backend/node_modules/teleproto/client/downloads.js:589-640` shows
`iterDownload` **does** support exact byte offsets:

```js
function iterDownload(client, file, params = {}) {
  ...
  let offset = typeof params.offset === "number" ? bigInt(params.offset) : params.offset ?? bigInt.zero;
  ...
  result = yield client.invoke(new Api.upload.GetFile({
    location: info.location,
    offset: offset,
    limit: requestSize,
    precise: true,   // ← exact byte offset
  }), dcId);
  ...
  if (params.limit != undefined && downloaded >= params.limit) {
    return;          // ← stop after N bytes
  }
}
```

Its public TS signature (`downloads.d.ts:48-58` `IterDownloadParams`) exposes:
- `offset?: bigInt.BigInteger | number` — byte offset to start downloading from
- `limit?: number` — stop after this many bytes (approximate, rounded up to
  whole 512 KB request chunks)

So Telegram **does** support server-side random access via `Api.upload.getFile`
with `precise: true`. The earlier audit claim ("forward-only, no offset") was
wrong — it looked only at the call site, not the library implementation.

## The fix (offset streaming, no temp file)

1. `openTelegramDocument(config, remoteId, { offset, limit })` now passes
   `offset`/`limit` through to `iterDownload`. Existing callers (REST
   `streamTelegramFile`, batch ZIP download) omit the opts and still stream the
   whole document.
2. The WebDAV Telegram branch in `streamProviderFileToReadable` parses the HTTP
   Range into `{ start, end }`, computes `byteCount = end - start + 1`, opens
   the document at `offset: start, limit: byteCount`, and wraps the stream in a
   trimming generator that cuts the library's final chunk overshoot (its
   `limit` is rounded up to whole 512 KB request chunks).
3. The controller already sets 206 + `Content-Range` + `Content-Length` for
   ranged GETs and 200 for full GETs, so no controller change is needed beyond
   mapping provider errors to their proper status codes:
   - `AppError('TELEGRAM_FILE_NOT_FOUND', …, 404)` → 404
   - `TELEGRAM_SESSION_INVALID` → 401
   - `TELEGRAM_FLOOD_WAIT` → 429
   - other raw RPC errors → classified via `classifyTelegramError`.
4. The trimming generator's `finally` block and a `close` listener on the
   returned Readable guarantee `download.close()` (MTProto client disconnect)
   runs on end, error, or early consumer destroy.

## Comparison matrix (working reference: Google Drive / S3)

| Header | Google Drive | Telegram (before fix) | Telegram (after fix) |
|---|---|---|---|
| `HEAD` status | 200 | 200 | 200 |
| `HEAD` Content-Length | ✅ (DB) | ✅ (DB) | ✅ (DB) |
| `GET` full status | 200 | 500 (wrong URL) | 200 |
| `GET` Range status | 206 | 500 | 206 |
| `GET` Content-Range | ✅ | ❌ | ✅ |
| `GET` Accept-Ranges | ✅ | ❌ | ✅ |
| Streaming shape | `Readable.fromWeb` → piped | n/a | `Readable.from(generator)` → piped |
| Memory bound | per chunk | n/a | 512 KB chunks |
| Headers before body | ✅ | n/a | ✅ (no full-file pre-download) |

## Error mapping

| Provider error | HTTP status |
|---|---|
| `TELEGRAM_FILE_NOT_FOUND` | 404 |
| `TELEGRAM_SESSION_INVALID` | 401 |
| `TELEGRAM_FLOOD_WAIT` | 429 |
| other classified RPC errors | per `classifyTelegramError` |
| unknown | 502 |

## Files changed

- `backend/src/modules/telegram/telegram.service.ts` — `openTelegramDocument`
  accepts `{ offset, limit }` and forwards them to `iterDownload`.
- `backend/src/modules/webdav/webdav-virtual-fs.ts` — `streamProviderFileToReadable`
  Telegram branch: parse Range → `openTelegramDocument({ offset, limit })` →
  trimming generator → `Readable`; classifies errors via
  `classifyTelegramError`; guarantees `download.close()` on teardown.
- `backend/src/modules/webdav/webdav.routes.ts` — maps `AppError.status` instead
  of always 500 for provider failures (both sync and stream-error paths).
- `backend/src/modules/webdav/webdav-telegram-stream.test.ts` — rewritten for
  offset streaming (11 tests).
- `backend/src/modules/telegram/telegram-open-document.test.ts` — offset/limit
  passthrough tests (4 tests).

## Verification

See `implementations/telegram-drive-webdav-jellyfin-playback-fix.md` for the
manual Jellyfin / rclone verification steps.
