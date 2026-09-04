# Telegram WebDAV Range Streaming — Audit

**Date:** 2026-09-04
**Scope:** Read-only WebDAV playback of Telegram-backed files (Jellyfin browse works, play/seek fails)
**References (read-only):** `references/tgfs`, `references/Telegram-Drive`, `references/teledrive`

---

## A. Executive Summary

Jellyfin can browse Telegram-backed files over the existing 9Drive WebDAV endpoint but cannot play or seek them. **Proven root cause:** the WebDAV streaming dispatch `streamProviderFileToReadable()` (`backend/src/modules/webdav/webdav-virtual-fs.ts:406`) has branches for S3 and Google Drive only — **no Telegram branch**. A Telegram file falls through to the Google API `fetch()` path, calls `getAuthedGoogleClient()` on a Telegram `connectedAccount` (which holds no Google tokens), and throws — every GET/Range-GET on a Telegram file returns a 500. PROPFIND and HEAD work because they read only database metadata. The underlying `teleproto` library supports exact offset reads (`iterDownload({ offset, limit })` with `precise: true`), so the fix adds a Telegram branch that downloads directly at the requested offset and serves exact bytes as 206 Partial Content.

## B. Existing 9Drive WebDAV Architecture

| File | Role |
|---|---|
| `backend/src/app.ts:69` | Mounts the WebDAV router at `/webdav` |
| `backend/src/modules/webdav/webdav.routes.ts` | Express router + `webdav-server` v2 handlers: `streamFile()` (GET, line 34), `headHandler()` (line 109), `propfindHandler()` (line 158), local `parseRange()` (line 21), write-method 403 `readOnlyHandler()` |
| `backend/src/modules/webdav/webdav-virtual-fs.ts` | `VirtualFileSystem` (line 121) — virtual path → DB node resolution with per-request cache; `streamProviderFileToReadable()` (line 406) — provider streaming dispatch |
| `backend/src/modules/telegram/telegram.service.ts` | Telegram provider: `openTelegramDocument()` (line 567), `streamTelegramFile()` (line 590) |
| `backend/src/modules/files/stream-file.ts` | REST provider dispatch (`streamProviderFile`) — has a Telegram branch, used by file preview/download routes |

Request flow:

```
HTTP/WebDAV request
  → requireWebDavAuth (Basic auth middleware)
  → webdavServer.executeRequest → custom method handlers
  → VirtualFileSystem.resolvePath() (path segments → Folder/File rows, per-request cache)
  → getFileForStreaming() (File + connectedAccount from Prisma)
  → parseRange() (bytes=start-end / start-; null → full 200)
  → streamProviderFileToReadable(file, { start, end } | undefined)
  → stream.pipe(ctx.response); 206 + Content-Range for ranges; destroy on error/close
```

## C. Google Drive Known-Good Flow

1. **HEAD** — `headHandler()` resolves the DB row only (no provider call): 200, `Content-Type` from `file.mimeType`, `Accept-Ranges: bytes`, `Content-Length` from `file.sizeBytes`, `ETag`, `Last-Modified`.
2. **GET / Range GET** — `streamFile()` parses the range, `streamProviderFileToReadable()` forwards `Range: bytes=start-end` as an HTTP header on `https://www.googleapis.com/drive/v3/files/{id}?alt=media` (`webdav-virtual-fs.ts` Google branch). Google natively supports byte ranges → 206 + correct bytes. Workspace export types (Docs/Sheets/Slides) deliberately do not forward ranges (full download).
3. **Stream** — `Readable.fromWeb(response.body)` piped to the response; backpressure via `stream.pipe()`.

## D. Telegram Current Flow (before fix)

1. **HEAD** — same DB-only path as Google → works.
2. **GET / Range GET** — `streamProviderFileToReadable()` had **no `telegram` branch**: the file fell through to the Google `fetch()` path, `getAuthedGoogleClient()` threw (no Google credentials on the Telegram account) → catch in `getHandler()` → 500.
3. **REST preview path** (`streamTelegramFile`, `telegram.service.ts:590`) accepted a `_range` param but ignored it — always 200, full file from byte 0, no 206.

## E. HTTP Comparison (before fix)

| Behavior | Google Drive | Telegram Before | Telegram Expected |
|---|---|---|---|
| PROPFIND | PASS | PASS (DB metadata) | PASS |
| HEAD status | 200 | 200 | 200 |
| GET status | 200 | **500** | 200 |
| Range status | 206 | **500** | 206 |
| Content-Length | correct | n/a (500) | correct (range size) |
| Accept-Ranges | bytes | bytes (HEAD) | bytes |
| Content-Range | correct | n/a | correct |
| MIME | from `file.mimeType` | n/a | from `file.mimeType` |
| Requested offset | forwarded to Google | — | forwarded to `iterDownload(offset)` |
| Returned bytes | exact | — | exact (trimmed) |
| Client abort | HTTP layer | — | stream destroyed → client disconnect |

## F. `tgfs` Reference Findings

- HTTP layer parses `Range: bytes=X-Y` into `begin`/`end`, then calls `get_content(begin, end)` on the resource; range requests get 206 + `Content-Range`.
- Telegram transport uses the library's native offset download: Telethon `iter_download(file, offset=begin, chunk_size=...)` / Pyrogram `get_file(offset=begin)`, then truncates the final chunk to `end - begin + 1` bytes.
- Files larger than one message are split across multiple messages; a logical range is mapped across the part list (`part_sizes`, `message_ids`) before download.
- **Pattern extracted (no code copied):** HTTP range → `begin`/`end` → native `offset` download → trim last chunk → 206. This is exactly the pattern applied to 9Drive via `teleproto`'s `iterDownload({ offset, limit })`.

## G. `Telegram-Drive` Reference Findings

- Rust `dav-server` WebDAV with a `position`-tracking `DavFile::Read`; `read_bytes()` calls `read_media_range()`.
- **CDN alignment:** `CDN_ALIGNMENT = 512 KiB`. The start is aligned down to a 512 KiB boundary, whole chunks are skipped, leading/trailing bytes trimmed. This is a workaround for grammers without exact-offset downloads — the result bytes are still exactly the requested HTTP range.
- Streaming server: parses Range, returns 206 + `Content-Range`, always `Accept-Ranges: bytes`; encrypted variant aligns to CDN boundaries, fetches ciphertext, then decrypts.
- **Pattern extracted:** when the MTProto library cannot start at an arbitrary offset, align + skip + trim. **Not needed for 9Drive:** `teleproto`'s `iterDownload` sends `upload.getFile({ offset, precise: true })` — offsets are exact, so no alignment math is required.

## H. `teledrive` Findings

- Telethon with `iter_download(request_size=512 KiB)`, but **always from offset 0** — no byte-range support anywhere.
- WebDAV GET downloads the whole file to a local mount cache, then serves from disk (`FileResponse` handles ranges locally). Every first seek on an uncached file re-downloads the entire file.
- Session handling: new `TelegramClient` per operation (matches 9Drive's current per-request client lifecycle).
- **Relevant takeaway:** the download-to-cache pattern is the anti-pattern this fix avoids — 9Drive streams directly at the requested offset.

## I. Root Cause (exact)

The existing WebDAV handler parses `Range` correctly and sets 206/`Content-Range` correctly, but `streamProviderFileToReadable()` (`webdav-virtual-fs.ts:406`) has no Telegram branch: Telegram-backed files fall through to the Google Drive code path and throw during `getAuthedGoogleClient()`, so Jellyfin's GET and Range-GET receive a 500 instead of a byte stream. Separately, the Telegram download API (`openTelegramDocument`, `telegram.service.ts:567`) never exposed `offset`/`limit` to `teleproto`'s `iterDownload`, which natively supports exact offset reads.

## J. Recommended Architecture

```
WebDAV routes (parseRange → {start, end})
  → streamProviderFileToReadable(file, { start, end } | undefined)   [provider-agnostic]
    ├─ s3:       GetObjectCommand Range header
    ├─ telegram: iterDownload({ offset: start, limit: end - start + 1 }) + trim + Readable wrapper
    └─ google:   Drive API Range header
  → stream.pipe(ctx.response)   (206 + Content-Range when ranged)
  → ctx.response 'close' → stream.destroy() → Telegram client disconnect
```

WebDAV stays provider-agnostic: provider-specific transport logic (including Telegram offset reads) lives inside the provider layer. No `if (provider === 'telegram')` branches in generic handlers beyond the dispatch function.

## K. Implementation Plan (executed)

1. **`backend/src/modules/telegram/telegram.service.ts`**
   - `openTelegramDocument(config, remoteId, range?: { offset; limit })` — passes `offset`/`limit` into `iterDownload` (backward compatible; existing zip/batch callers pass nothing).
   - `trimToLimit(stream, limit)` async generator — trims the final chunk to an exact byte count (`iterDownload`'s `limit` overshoots by up to one 512 KiB chunk; overshoot would trip `ERR_HTTP_CONTENT_LENGTH_MISMATCH` on a piped response).
   - `telegramDownloadToReadable(download, limit?)` — wraps the async iterable in a `Readable`; disconnects the short-lived client exactly once on `end`/`error`/`close` (destroy propagates `return()` into the generator, stopping the Telegram download on client abort).
2. **`backend/src/modules/webdav/webdav-virtual-fs.ts`**
   - `streamProviderFileToReadable(file, range?: { start; end })` — signature changed from `range?: string` (S3/Google reconstruct `bytes=start-end`, byte-identical to the previous input); new `telegram` branch downloads at the exact offset.
3. **`backend/src/modules/webdav/webdav.routes.ts`**
   - Passes parsed `{ start, end }` bounds directly (no string reconstruction).
   - `ctx.response.on('close', () => stream.destroy())` — client abort stops the upstream Telegram download.
4. **`backend/src/modules/telegram/telegram-download.test.ts`** (new) — 5 tests: mid-chunk trim, boundary trim, no-limit passthrough, abort propagation, mid-stream error.

## L. Risks / Regression

- **Google Drive:** untouched branch (header string byte-identical to before); full WebDAV suite + manual regression required.
- **rclone:** PROPFIND/HEAD/GET flow unchanged for all providers.
- **Jellyfin:** seeks now issue ranged GETs; each seek opens a new short-lived Telegram client (existing 9Drive pattern — no pooling in this task; matches teledrive).
- **Memory:** no whole-file buffering — streaming only; `Readable.from` + `pipe()` honor backpressure.
- **Rate limits:** no new retry logic; existing `classifyTelegramError` (FloodWait → 429) is preserved. Jellyfin can issue many range requests; each is a fresh client connect — known cost, unchanged from the REST path.
- **Metadata drift** (DB size ≠ actual Telegram file size): stream ends at EOF, body shorter than declared Content-Length — pre-existing semantics shared by all providers.
- **Unsatisfiable/malformed/multi-range headers:** unchanged behavior — full 200 fallback (existing WebDAV semantics; no 416 introduced).
- **REST `streamTelegramFile` range support:** deliberately out of scope (in-app preview works on full 200s; seeking-beyond-buffer is a known degradation). `ponytail:` — extract `parseRange` into a shared module and reuse `telegramDownloadToReadable` when the in-app player reports broken Telegram seeking.

## Verification Results

- `npx tsc --noEmit` — PASS
- `npx vitest run` — 70 files / 931 tests PASS (incl. new `telegram-download.test.ts`, 5 tests)
- Manual verification (curl/rclone/Jellyfin) — pending per implementation plan §45 Phase 5
