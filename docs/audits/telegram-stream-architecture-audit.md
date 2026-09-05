# Telegram Stream Architecture Audit

Branch: `feature/webdav-telegram`
Audit date: 2026-09-05
Status: implementation-ready (Phases 00–12)

## 1. Current read path (Jellyfin → WebDAV → bytes)

```
Jellyfin
  → 9Drive WebDAV  (HTTP Basic, backend/src/modules/webdav/webdav-auth.middleware.ts:9)
  → app.use('/webdav', webdavRouter)             (backend/src/app.ts:71)
  → webdavServer.method('get', getHandler())     (backend/src/modules/webdav/webdav.routes.ts:314)
  → streamFile(request)                          (webdav.routes.ts:34-80)
      parseRange(Range)                          (webdav.routes.ts:21-31)
      resolvePath(virtual path)                  (webdav-virtual-fs.ts:143-191)
      streamProviderFileToReadable(file, range)  (webdav-virtual-fs.ts:406-435)
  → provider stream
  → HTTP response (200 / 206 / 416)
```

WebDAV method registration is read-only: `put/mkcol/delete/move/copy/proppatch/lock/unlock` return 403
(`webdav.routes.ts:310-312`, `readOnlyHandler()` at `:286-301`). `propfind` and `head` are registered
separately (`:315-316`).

## 2. Provider routing at HEAD

`streamProviderFileToReadable()` (`webdav-virtual-fs.ts:406-435`):

- `provider === 's3'` → `GetObjectCommand` from AWS SDK with `Range` (`:407-414`).
- **else fallthrough to Google Drive** (`:416-434`): builds a Drive `files/.../...?alt=media` or
  `export?mimeType=...` URL, calls `fetch()` with the user's OAuth headers and the `Range` header if no
  export MIME is needed, returns `Readable.fromWeb(response.body)`.

There is **no `telegram` branch**. A Telegram-backed file served over WebDAV GET/Range GET therefore hits the
Google path and fails with a Google auth error (or worse — silently serves the wrong file if the
`providerFileId` happens to look like a Drive id). The current HEAD is broken for the Telegram case.

## 3. The non-WebDAV read path (REST API)

`backend/src/modules/files/stream-file.ts:10-14`:

```ts
if (file.provider === 's3') return streamS3File(file, range, res, options)
if (file.provider === 'telegram') return streamTelegramFile(file, range, res, options)
return streamGoogleFile(file, range, res, options)
```

The Telegram branch *exists* here, but it is incomplete: `streamTelegramFile`
(`telegram.service.ts:607-621`) takes a `range` parameter prefixed with `_` (deliberately unused) and always
streams a full `200` from `iterDownload`'s byte 0:

```ts
res.status(200)
res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
for await (const chunk of download.stream) {
  res.write(chunk)
}
```

`openTelegramDocument()` (`telegram.service.ts:584-604`) creates a **fresh client per call** (via
`withTelegramClient`, `:334-348`), fetches the message, returns
`client.iterDownload(message.media, { requestSize: 512 * 1024 })` and disconnects the client on `close()`.
There is no `offset`/`limit` support in this code path.

## 4. Why Telegram playback buffers (root cause)

1. WebDAV GET has no Telegram branch — Telegram-backed files do not play through WebDAV at all.
2. Even on the REST path that does dispatch, `Range` is ignored, so every Jellyfin seek triggers a full
   re-download of the file from byte 0.
3. The Telegram client is created fresh per call (`withTelegramClient` connects + `client.connect()` +
   `getMessages` + `disconnect` in `finally`). Every range request therefore pays the connect + auth-restore
   cost before any byte is streamed.
4. `iterDownload` with a fixed `requestSize: 512 KiB` issues 512 KiB `upload.GetFile` calls; at modest
   throughput this is slow but not broken, but combined with (2) and (3) the effective throughput collapses
   for any seek-heavy media.
5. There is no `FILE_REFERENCE` refresh path; the first hit of a stale file reference aborts the request
   without retry.
6. There is no client abort propagation between Express and the Telegram client — when Jellyfin gives up on
   a stalled range the backend keeps pulling from Telegram until completion.

## 5. Google Drive baseline (known working)

`streamGoogleFile` (`backend/src/modules/files/stream-google-file.ts:34-80`) handles full GET and Range GET
against `https://www.googleapis.com/drive/v3/files/{id}?alt=media`, forwarding the `Range` header (with
the export-MIME exception). It uses `Readable.fromWeb(response.body)` for backpressure and inherits the
provider's per-request OAuth auth. WebDAV's `streamFile` mirrors this with the same `Readable.fromWeb` flow
on the WebDAV route. Status codes, `Content-Range`, `Content-Length`, `Accept-Ranges` all derive from the
upstream response.

Verified response shape (Drive):

```
HEAD /webdav/<path>      → 200, Content-Type, Accept-Ranges: bytes, Content-Length, ETag, Last-Modified
GET  /webdav/<path>      → 200, Content-Length, Content-Type, no Content-Range
GET  Range: bytes=0-    → 200 OR 206 (server-side; reported as 200/206 with full Content-Length if open-ended)
                          Content-Range: bytes <s>-<e>/<t>
GET  Range: bytes=N-M    → 206, Content-Range: bytes N-M/total
GET  Range: invalid     → 416, Content-Range: bytes */total
```

## 6. Reference project findings (patterns, not code)

Read-only under `references/`. None of these libraries are imported; patterns only.

| Reference | Pattern used |
|---|---|
| `references/telegram-stremio` (`helper/custom_dl.py` `ByteStreamer`) | `asyncio.Queue` bounded prefetch, ordered output via a seq-keyed results buffer, `raw.functions.upload.GetFile(location, offset, limit)` on a media session, per-DC media session cache (`client.media_sessions[dc]` + `Session(... is_media=True)` + ExportAuthorization/ImportAuthorization), stale `FILE_REFERENCE` refresh by re-fetching the message, FloodWait via regex on the error string with bounded retries, `request.is_disconnected()` polling for cancellation, per-stream throughput telemetry. |
| `references/tgfs` (`core/repository/impl/file_content/__init__.py` `_get_file_part_to_download`) | For 9Drive this is unnecessary — each `File` row maps to **one** Telegram document (one message), so byte range maps to a single-document `upload.GetFile(offset, limit)` call. The `_get_file_part_to_download` multi-part walk is **not** needed for 9Drive; the assumption must be confirmed (the design stores one message per file; ingest is one document). |
| `references/telegram-drive-webdav` (Tauri/Rust desktop WebDAV) | Same Range/206/seek behavior expected by clients — useful for the contract test matrix. |
| `references/teledrive` | Telethon `StringSession`, per-user encrypted storage, FastAPI WebDAV router. Same session-strategy idea. |

The architecture re-implements the telegram-stremio patterns independently. **No source is copied**;
license review in Phase 12 will document that the implementation is from architectural patterns only.

## 7. Session compatibility — verified

9Drive stores a **GramJS/teleproto `StringSession`** (file `node_modules/teleproto/sessions/StringSession.js`):

```
"1" + base64( dcId[1] | addrLen[2 BE] | addr[N] | port[2 BE] | authKey[remaining] )
```

Verified by a roundtrip test (decoded `dcId=2, addr=149.154.167.51, port=443, authKey=256 bytes` produces
`session.length === 197`; `StringSession(s).save() === s`).

PyroFork/Pyrogram `StringSession` (verified from
`https://github.com/pyrogram/pyrogram/blob/master/pyrogram/storage/storage.py`):

```python
SESSION_STRING_FORMAT = ">BI?256sQ?"   # dc_id, api_id, test_mode, auth_key, user_id, is_bot
return base64.urlsafe_b64encode(packed).decode().rstrip("=")
```

**These formats are not inter-convertible.** PyroFork needs `api_id`, `user_id`, `is_bot` and a fixed
256-byte auth key. A GramJS session has none of those and cannot be fabricated into one; PyroFork's
`MemoryStorage` rejects an empty session and forces a re-login.

### Superseded during implementation: Telethon removes the whole problem

The conclusion above holds for PyroFork and only for PyroFork. **Telethon's `StringSession` carries exactly
the four fields the GramJS one carries**, so the credential 9Drive already stores converts losslessly and no
second session, no second login and no new column are needed:

```python
# telethon/sessions/string.py
CURRENT_VERSION = '1'
_STRUCT_PREFORMAT = '>B{}sH256s'      # dc_id | ip (4 or 16 bytes) | port | auth_key
ip_len = 4 if len(string) == 352 else 16
```

Verified end to end: the stored session decodes to `dcId=5, addr=91.108.56.161, port=443, authKey=256B`,
repacks (`backend/src/modules/telegram/telethon-session.ts`) to a 353-char string, and Telethon's own parser
reads back `dc_id=5 / server_address / port=443 / auth_key=256B` with `save() == input`.

**Implemented strategy: no provisioning at all.** The service asks the backend for
`{apiId, apiHash, session}` over the existing signed control plane
(`GET /telegram/stream/credentials/:connectedAccountId`), repacked at request time from
`sessionEncrypted`, held in memory for the lifetime of the Telegram connection, never persisted and never
logged. This deletes the Phase-02 provisioning subsystem (`telegram-stream-session.service.ts`, the
`PUT /stream/session` writer, the `finalizeTelegramAuth` hook) and leaves
`TelegramStorageConfig.streamSessionEncrypted` unused. Two PyroFork traps also disappear:
`stream_media`/`get_file` addressing by chunk *index* rather than byte offset, and
`MAX_CONCURRENT_TRANSMISSIONS = 1` serializing parallel fetches.

## 8. Security boundary

The internal API surface between 9Drive backend and `telegram-stream` is intentionally narrow:

- `telegram-stream` is internal-only (no public host port in Phase 09; `expose: 8081` only).
- Every request is HMAC-signed: `X-Stream-Timestamp` (unix seconds) + `X-Stream-Signature`
  (hex HMAC-SHA256 over canonical string `ts\nmethod\npath\nproviderId\nchannelId\nmessageId\nRange`).
- The shared secret is read from env, never put in a query string, never logged.
- The Range header is in the canonical string, so a MITM (or a buggy caller) cannot mutate the range
  post-signature.
- The session material is passed only over the signed API and held in process memory; it is never logged
  and never returned by `/health` or any other endpoint.
- The stream request carries only what is needed: `providerId`, `channelId`, `messageId`, `knownSize`, and
  `Range`. There is no general-purpose Telegram-proxy endpoint.
- Authorization in the gateway is bound to a known connected account — `telegram-stream` will reject any
  request whose `providerId` is not present in the cached, signed request from the backend, and the backend
  only signs for `File` rows it just resolved from the DB (i.e. files owned by the requesting user).

`webdav-no-decrypt.test.ts` (passing at HEAD) asserts that the WebDAV read path loads **no** crypto module
— this guarantee is preserved. Session decryption happens in the control-plane route
(`GET /telegram/stream/credentials/:id`), which is not on the read path.

## 9. Target architecture

```
Jellyfin / rclone
       ↓
9Drive WebDAV (/webdav)
       ↓
StorageReadRouter (existing files/stream-file.ts:10 dispatcher)
   ├── Google  → existing flow
   ├── S3      → existing flow
   └── Telegram → TelegramStreamGateway (NEW)
                      ↓
            signed internal HTTP (HMAC)
                      ↓
                telegram-stream (NEW, FastAPI/Telethon)
                      ↓
            ClientManager (per-providerId, reuse; no login/range)
                      ↓
            file/media session cache
                      ↓
            range byte streamer (Telethon iter_download, byte offsets, stops at the requested end)
                      ↓
                Telegram MTProto
```

Header ownership:

- `telegram-stream` owns byte-range mechanics: `status`, `Content-Range`, range `Content-Length`,
  `Accept-Ranges`.
- 9Drive owns logical metadata: `Content-Type`, `Content-Disposition`, `ETag`, `Last-Modified`.

This split keeps 9Drive's existing WebDAV semantics intact and pushes the byte-protocol concerns to the
service that understands them.

## 10. Implementation phases

See `implementations/9drive-telegram-stream-implementation-phases/PHASE-00…12.md` and the approved plan at
`C:\Users\Lenovo\.claude\plans\curried-sprouting-crown.md`.

Expected files (Phases 01–10):

New:

- `services/telegram-stream/app/main.py`
- `services/telegram-stream/app/api/{health.py,stream.py}`
- `services/telegram-stream/app/core/{config.py,errors.py}`
- `services/telegram-stream/app/security/internal_auth.py`
- `services/telegram-stream/app/telegram/{client_manager.py,file_resolver.py,engine.py,credentials.py}`
- `services/telegram-stream/tests/...`
- `services/telegram-stream/Dockerfile`, `pyproject.toml`, `requirements.txt`
- `docs/audits/telegram-stream-benchmark.md` (Phase 10)
- `backend/src/modules/telegram/telegram-stream-gateway.ts` (+ `.test.ts`)
- `backend/src/modules/telegram/telethon-session.ts` (+ `.test.ts`)

Modified:

- `backend/src/config/env.ts` (new env vars)
- `backend/src/modules/telegram/telegram.routes.ts` (credentials control plane)
- `backend/src/modules/telegram/telegram-stream-readable.ts` (WebDAV upstream + reauth mirroring)
- `backend/src/modules/files/stream-file.ts` (route Telegram through gateway)
- `backend/src/modules/webdav/webdav-virtual-fs.ts` (add Telegram branch to streamProviderFileToReadable)
- `docker-compose.yml` (new `telegram-stream` service, internal-only)
- `.env.docker.example` (new `# Telegram Stream` group)
- `docs/implementation/telegram-drive.md` (update with stream architecture)

Reuse, not reinvent:

- `parseTelegramRemoteId`/`buildTelegramRemoteId`/`classifyTelegramError`/`markTelegramReauthRequired`
  (`telegram.service.ts`).
- `encryptText`/`decryptText` (`utils/crypto.ts`) for the new encrypted session column.
- `parseRange` and existing 200/206/416 handling (`webdav.routes.ts`).
- zod env conventions (`config/env.ts`).
- vitest `vi.mock` prisma patterns from existing Telegram tests.

## 11. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| PyroFork session provisioning fails (network/OTP) | Superseded: there is no provisioning. The Telethon session is repacked from the credential the backend already holds, so a working 9Drive Telegram connection is a working stream. A *revoked* session surfaces as `503 TELEGRAM_REAUTH_REQUIRED` and flags the account `reauth_required`, so the UI asks for a reconnect instead of failing silently. | Existing REST full-GET (no range) still works for those files. |
| `FILE_REFERENCE` stale | Refresh-on-error in Phase 03; one extra `getMessages` per cold start. | Reverted by stopping gateway use; falls back to current broken-in-WebDAV behavior. |
| FloodWait from Telegram | Sequential reads (one 512 KiB request in flight per stream); a `FloodWaitError` is mapped to `429` with the wait time, never retried in a loop. | Lower `TELEGRAM_STREAM_CHUNK_SIZE_BYTES`; re-tune only from measured numbers. |
| WebDAV regression for Google | Routing is additive: only the new Telegram branch is added; S3 and Google paths untouched. Existing `webdav-no-decrypt.test.ts` and storage-routing tests must keep passing. | Revert the gateway wiring; Google/S3 stay live. |
| Large `Content-Range` overhead from chatty clients (Jellyfin) | Cancellation is structural: a client disconnect throws `CancelledError` into the streaming generator, whose `finally` closes the Telethon download iterator, so a superseded range stops consuming Telegram bandwidth immediately. | No flag to disable; reverting the gateway wiring is the rollback. |
| `telegram-stream` down in production | Internal-only service; healthcheck wired into compose; backend receives a fast 502 from the gateway, returns a clear 502/503 to WebDAV; Google WebDAV unaffected. | Compose-down. |

## 12. Final summary

```
Telegram Stream Audit Complete
Current WebDAV:           s3 + google; no telegram branch in streamProviderFileToReadable (webdav-virtual-fs.ts:406)
Current Telegram Stream:  REST path only, ignores Range, fresh client per call, iterDownload from byte 0
Primary Bottleneck:       (1) no Telegram branch in WebDAV, (2) Range ignored → re-download per seek,
                          (3) fresh Telegram client per request → connect+auth cost on every range
Google Baseline:          200/206/416 + headers via fetch+Readable.fromWeb, OAuth auth, Range forwarded
Session Compatibility:    teleproto StringSession (GramJS) ≠ PyroFork StringSession (Pyrogram family);
                          BUT == Telethon StringSession (same dc_id|ip|port|auth_key). Implemented with
                          Telethon: repacked on the fly from sessionEncrypted, in memory only, no
                          second login and no new column (see §7).
Recommended Architecture: NEW internal telegram-stream (FastAPI + Telethon) behind a thin
                          TelegramStreamGateway in the existing backend; WebDAV unchanged; no second
                          DB; provider detection from File.provider (never filename); session in
                          memory only; HMAC-signed internal API; header ownership split documented.
Implementation Ready:     YES
```
