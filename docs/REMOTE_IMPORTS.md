# Remote Import from URL

Remote Import lets an authenticated user paste an HTTP(S) URL and have the
server download the file into their 9Drive storage (Google Drive or an
S3-compatible bucket) **without the file ever being fully held in memory or
re-uploaded from the browser**. The download runs as a background job, so the
user can close the tab and come back to check progress.

```
User pastes URL ──► API validates (SSRF gate) ──► BullMQ queue (Redis)
                                                      │
                                                      ▼
                              remote-import-worker process
                probe → download to shared temp volume → select storage
                → upload (resumable/multipart) → register file → cleanup
                                                      │
                                                      ▼
                        Frontend polls GET /remote-imports for progress
```

## How it works

1. While the user types a URL in the modal, the frontend calls
   `POST /remote-imports/probe` (debounced ~500 ms) so the **backend** detects
   the remote file's name — the browser never contacts the remote host. See
   [Filename detection](#filename-detection) below. The detected name is
   pre-filled into the File Name field, but a name the user types always wins
   and is never overwritten by a later probe.
2. `POST /remote-imports` with `{ url, folderId?, connectedAccountId?, fileName?, detectedFileName? }`.
   The URL is validated immediately (scheme, credentials, DNS) and the source
   URL is stored **encrypted** (`sourceUrlEncrypted`). The effective filename
   is: `fileName` (user) → `detectedFileName` (server probe) → derived from the
   URL — and is always run through the shared filename sanitizer.
3. A BullMQ job is enqueued with `jobId = importId` (idempotent — retrying the
   request never double-enqueues).
4. The dedicated **remote-import-worker** process (separate container/service)
   picks the job up:
   - **Download** — streams the body to a temp file on a **shared volume**,
     enforcing the max-size cap while streaming and an idle timeout.
   - **Select storage** — automatic routing (most-available / round-robin /
     priority) or the pinned account / folder binding; quota is re-synced when
     stale.
   - **Upload** — S3: multipart via `@aws-sdk/lib-storage`; Google Drive:
     resumable upload with the session URI stored encrypted (crash-resume).
   - **Register** — creates the `File` row in the virtual filesystem
     (idempotent by `providerFileId`) and links it to the import.
   - **Cleanup** — the temp file is always removed, even on failure. Stale
     temp files are swept by the worker's periodic sweeper
     (`REMOTE_IMPORT_TEMP_RETENTION_HOURS`).
5. Status (`queued | processing | completed | failed | cancelled`) and stage
   (`probing | downloading | ... | finished`) plus byte progress are written to
   the `remote_imports` row so the frontend can poll cheaply.

Cancellation removes the queued job immediately and is checked between phases
while processing. Failed/cancelled imports can be retried (`attempt` is
incremented). Both cancel and retry require the job to belong to the caller.

## API

All endpoints require `Authorization: Bearer <token>` and are user-scoped —
you can never read or mutate another user's import. See the comment in
`remote-import.routes.ts` — the `/probe` route is registered before the
`/:id` routes so the literal segment `probe` never matches a record id.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/remote-imports/probe` | `{ url }` | `{ data: { originalUrl, finalUrl, fileName, fileNameSource, mimeType, contentLength, supportsRange } }` |
| `POST` | `/remote-imports` | `{ url, folderId?, connectedAccountId?, fileName?, detectedFileName?, mimeType? }` | The created import |
| `GET` | `/remote-imports?limit=&cursor=` | — | `{ items, cursor }` (cursor pagination, newest first) |
| `GET` | `/remote-imports/:id` | — | The import |
| `POST` | `/remote-imports/:id/cancel` | — | The import, now `cancelled` |
| `POST` | `/remote-imports/:id/retry` | — | The import, back to `queued` |
| `DELETE` | `/remote-imports/:id` | — | `204` |

A `RemoteImport` looks like:

```json
{
  "id": "cm0000000000000000000000",
  "fileName": "ubuntu-24.04.iso",
  "displayUrl": "https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso",
  "status": "processing",
  "stage": "downloading",
  "totalBytes": "5985851392",
  "downloadedBytes": "1234567",
  "uploadedBytes": "0",
  "mimeType": "application/x-iso9660-image",
  "errorCode": null,
  "errorMessage": null,
  "createdAt": "2026-08-06T12:00:00.000Z",
  "startedAt": "2026-08-06T12:00:01.000Z",
  "completedAt": null,
  "failedAt": null,
  "cancelledAt": null,
  "attempt": 1,
  "fileId": null,
  "folderId": null,
  "connectedAccountId": null,
  "file": null
}
```

Byte fields are serialized as strings (BigInt-safe). `displayUrl` has the query
string and fragment stripped so signed query secrets never reach the browser.

Error responses are stable JSON: `{ "code": "...", "message": "..." }`.

| Code | Meaning |
| --- | --- |
| `INVALID_URL` | Not a parseable URL or missing host |
| `UNSUPPORTED_URL_SCHEME` | Only `http:`/`https:` are allowed |
| `URL_CREDENTIALS_NOT_ALLOWED` | `user:pass@` embedded credentials |
| `SSRF_BLOCKED_ADDRESS` | Host resolves to private/loopback/link-local/metadata space |
| `SSRF_DNS_FAILED` | Hostname could not be resolved |
| `REMOTE_IMPORT_DISABLED` | Feature disabled via `REMOTE_IMPORT_ENABLED=false` |
| `REMOTE_IMPORT_NOT_FOUND` | Import id not found (or not yours) |
| `REMOTE_IMPORT_NOT_CANCELLABLE` / `REMOTE_IMPORT_NOT_RETRYABLE` | Wrong status for the action |
| `FOLDER_NOT_FOUND` / `ACCOUNT_NOT_FOUND` | Bad `folderId`/`connectedAccountId` |
| `DOWNLOAD_TOO_LARGE` | Exceeded `REMOTE_IMPORT_MAX_BYTES` |
| `DOWNLOAD_HTTP_ERROR` | Remote server answered ≥ 400 |
| `TOO_MANY_REDIRECTS` | Redirect chain exceeded the limit |
| `NO_ACCOUNT_WITH_ENOUGH_SPACE` | No storage account with enough free quota |
| `IMPORT_TIMEOUT` | Import exceeded `REMOTE_IMPORT_JOB_TIMEOUT_HOURS` (enforced between phases) |
| `IMPORT_FAILED` | Generic worker failure |

## Filename detection

`POST /remote-imports/probe` runs entirely server-side (the browser never
contacts the remote host — a HEAD from the browser would lose the
`Content-Disposition` header to CORS anyway). The probe:

1. validates the URL through the same SSRF gate as the downloader,
2. sends a **HEAD**; if that is rejected (405/network) or its headers carry no
   `Content-Disposition` filename, sends **one** `GET` with `Range: bytes=0-0`.
   A server that ignores the range and streams the whole body is aborted after
   the first chunk — the full file is never downloaded,
3. reads the **final** response's headers (an intermediate redirect's
   `Content-Disposition` never wins),
4. returns `{ originalUrl, finalUrl, fileName, fileNameSource, mimeType,
   contentLength, supportsRange }`; sensitive query parameters are redacted
   from the returned URLs.

Filename resolution order (exact):

1. `Content-Disposition: filename*` (RFC 5987/8187, UTF-8 only)
2. `Content-Disposition: filename` (quoted or unquoted token)
3. last usable pathname segment of the **final** redirected URL
4. last usable pathname segment of the **original** URL
5. generated `remote-file-<shortId>` (an extension is only appended when it
   cannot duplicate one already present)

`fileNameSource` is one of `content-disposition-filename-star` /
`content-disposition-filename` / `final-url-path` / `original-url-path` /
`generated-fallback`. Every detected name is passed through the shared
`sanitizeFileName` (NFC normalization, null bytes / control characters /
path separators / traversal components / Windows-illegal characters and
device names removed, trailing dots/spaces trimmed, length capped, never
empty). The filename never influences the temp-file path — staging is keyed
by import id only. At import creation the same sanitizer runs again on the
effective name (user `fileName` wins over the probe's `detectedFileName`).

## SSRF protection (mandatory)

Every single HTTP request the worker makes — including **every redirect hop** —
goes through the same gate:

- **Scheme whitelist**: only `http:`/`https:`; other schemes rejected at
  creation time.
- **No credentials**: URLs containing `user:pass@` are rejected.
- **IP blocklist** (via `ipaddr.js`): private (`10/8`, `172.16/12`,
  `192.168/16`), loopback (`127/8`, `::1`), link-local (`169.254/16`,
  `fe80::/10`), CGNAT (`100.64/10`), documentation/reserved
  (`192.0.2/24`, `198.51.100/24`, `203.0.113/24`, `192.0.0/24`, `198.18/15`,
  `224/4`, `240/4`, `0/8`), and IPv6 equivalents — IPv4-mapped IPv6
  (`::ffff:a.b.c.d`) is parsed back to IPv4 and checked.
- **DNS resolution + validation**: the hostname is resolved to *all* A/AAAA
  records and rejected if **any** is blocked. Hostnames that are already IP
  literals are checked directly.
- **DNS-rebinding fence**: the downloader connects to the validated address via
  a custom undici `lookup` that always returns the address we already checked —
  a second resolution can never re-point the socket at a private address.
  The `Host` header and TLS server name remain the URL's hostname (the server
  keeps working as intended).
- **Re-validation after redirects**: `Location` targets are re-validated
  (scheme, credentials, DNS) before their socket opens; the redirect chain is
  capped by `REMOTE_IMPORT_MAX_REDIRECTS`.
- **No credential forwarding**: `Authorization`/`Cookie` are never forwarded
  across hops. The only exception is the user-supplied request context
  (Referer/Origin/User-Agent/Cookie — see below): those allowlisted headers are
  recomputed per hop, and the Cookie is dropped the moment the target host
  changes.
- **Connect timeout** (`REMOTE_IMPORT_CONNECT_TIMEOUT_SECONDS`) and **idle
  timeout** (`REMOTE_IMPORT_IDLE_TIMEOUT_SECONDS`) bound each connection.
- **Max size enforced while streaming**: even without `Content-Length`, the
  stream is counted and aborted at `REMOTE_IMPORT_MAX_BYTES`.

## Request context (Referer / Origin / User-Agent / Cookie)

Some protected sources (HLS streams, signed downloads) reject 9Drive's plain
fetcher with `HLS_MANIFEST_FORBIDDEN` / 401 / 403 even though a browser can open
them, because 9Drive deliberately sends no Referer/Origin/User-Agent/Cookie.
The **Advanced Request Options** panel (Remote Import modal) lets the user
supply those four values for a source; the same values can be pasted as a
**cURL command** instead of a bare URL.

### What is forwarded, and where

- The context is applied through the **entire fetch graph**: master manifest,
  child playlists, segments, `EXT-X-MAP`, AES-128 `EXT-X-KEY`, live-playlist
  refresh, and direct files — everything funnels through the one shared secure
  fetcher, which recomputes the headers for **every redirect hop**.
- `User-Agent`, `Referer` and `Origin` are forwarded to every host.
- `Cookie` is forwarded **only to the exact source origin** (scheme + host +
  effective port). The moment a redirect or an HLS child points at any other
  host, the cookie is dropped. A cross-origin HLS child with a source cookie set
  is refused up front with `HLS_CHILD_AUTHENTICATION_REQUIRED` — 9Drive never
  leaks the source cookie to another host to make a request work.
- The cookie scope is anchored to the **original import URL**, never
  re-anchored to a child or redirect URL.

### Paste as cURL

The backend parses the pasted command with a **pure tokenizer — nothing is ever
executed** (no shell, no curl, no eval). It extracts exactly the URL and the
four supported headers (`-H/--header`, `-A/--user-agent`, `-b/--cookie`), and
rejects transport/tunnel options (`--proxy`, `--resolve`, `--connect-to`,
`--interface`, `--unix-socket`, …), upload/data/form options (`--upload-file`,
`--form`, `--data`, …), auth options (`-u`, `--oauth2-bearer`, `--basic`, `-k`,
…), non-GET methods, multiple URLs, non-http(s) schemes, shell composition in
unquoted tokens, and `Authorization:` headers (with a clear "not supported"
message). The frontend only previews parse results; the server re-parses on
create, so the server's parse is always authoritative.

### Storage and secrecy

- Values are validated (CR/LF injection rejected, per-field caps: Referer
  ≤ 4096, Origin ≤ 2048, User-Agent ≤ 2048, Cookie ≤ 16384 bytes) and stored
  **encrypted at rest** on the import row (`AES-256-GCM`,
  `TOKEN_ENCRYPTION_KEY`).
- Values are **never returned by any API** — responses carry only the boolean
  summary `{ attached, referer, origin, userAgent, cookie }`, and the list UI
  shows only a "Request context attached" badge.
- Logs never include cookies, Authorization, signed query values, session ids
  or tokens.
- Retries keep the context automatically: the worker loads + decrypts it from
  the DB row, never from the job payload — no repaste.
- A context-bearing 401/403 maps to `REMOTE_SOURCE_ACCESS_EXPIRED` ("The source
  URL or request context may have expired…") in both the probe and the worker,
  so the user sees one consistent answer.
- Non-goals (by design): no DRM bypass, no CAPTCHA/anti-bot bypass, no browser
  automation, no automatic cookie extraction, no paywall bypass, no arbitrary
  header injection, no shell execution.

## Secrets handling

- The full source URL is stored encrypted (`AES-256-GCM`, `TOKEN_ENCRYPTION_KEY`).
- Logs never include the source URL, query strings, credentials, provider
  tokens, or resumable-upload session secrets.
- The frontend only ever receives the query-stripped `displayUrl`.
- Signed-URL query secrets are never written to ordinary application logs.

## Environment variables

All optional — defaults are shown. `REMOTE_IMPORT_ENABLED` defaults to `true`.

| Variable | Default | Description |
| --- | --- | --- |
| `REMOTE_IMPORT_ENABLED` | `true` | Master switch (API returns `403` when off) |
| `REMOTE_IMPORT_MAX_BYTES` | `5368709120` (5 GB) | Max downloaded file size, enforced during streaming |
| `REMOTE_IMPORT_GLOBAL_CONCURRENCY` | `4` | Concurrent jobs across all users |
| `REMOTE_IMPORT_PER_USER_CONCURRENCY` | `2` | Concurrent jobs per user (excess jobs are re-delayed) |
| `REMOTE_IMPORT_MAX_REDIRECTS` | `5` | Redirect chain cap |
| `REMOTE_IMPORT_CONNECT_TIMEOUT_SECONDS` | `15` | TCP/TLS connect timeout |
| `REMOTE_IMPORT_IDLE_TIMEOUT_SECONDS` | `60` | Idle body-stream timeout (refreshes per chunk) |
| `REMOTE_IMPORT_JOB_TIMEOUT_HOURS` | `12` | BullMQ job timeout (fails the job if exceeded) |
| `REMOTE_IMPORT_DOWNLOAD_ATTEMPTS` | `3` | Download retries with exponential backoff |
| `REMOTE_IMPORT_UPLOAD_ATTEMPTS` | `2` | Upload retries with exponential backoff |
| `REMOTE_IMPORT_TEMP_RETENTION_HOURS` | `24` | Stale temp-file sweep cutoff |
| `REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS` | `1000` | Progress write throttle |
| `REMOTE_IMPORT_TEMP_DIR` | `./data/remote-import-tmp` | Temp staging directory |
| `REMOTE_IMPORT_REQUEST_CONTEXT_ENABLED` | `true` | Request-context feature; context-bearing probe/create requests are rejected with `403` when off (never silently dropped) |
| `REMOTE_IMPORT_CURL_INPUT_ENABLED` | `true` | Paste-as-cURL mode; cURL-mode requests are rejected with `403` when off |
| `REMOTE_IMPORT_REQUEST_CONTEXT_MAX_CURL_BYTES` | `65536` | Byte cap for a pasted cURL command |
| `REMOTE_IMPORT_REQUEST_CONTEXT_MAX_COOKIE_BYTES` | `16384` | Byte cap for a Cookie value |
| `REMOTE_IMPORT_REQUEST_CONTEXT_COOKIE_SCOPE` | `source-host` | Cookie scope — only `source-host` (exact scheme+host+port) is supported |

## Docker

`docker-compose.yml` now starts two extra services:

- **redis** — `redis:7-alpine`, internal only (healthchecked), used by BullMQ.
- **remote-import-worker** — builds the same backend image but runs
  `node dist/modules/remote-imports/worker-entry.js` (migrations are applied
  first via `db:migrate:deploy`).

Both `backend` (producer) and `remote-import-worker` (consumer) share the
`remote_import_tmp` volume and the same `REDIS_URL=redis://redis:6379`.

All `REMOTE_IMPORT_*` variables are forwarded from `.env`; see
`.env.docker.example`.

## Local development (without Docker)

You need a Redis server (e.g. `redis-server` locally, or `docker run -d -p
6379:6379 redis:7-alpine`). Set `REDIS_URL=redis://localhost:6379` in
`backend/.env`, then run the worker in a second terminal:

```bash
cd backend
npm run worker:remote-import   # or worker:remote-import:prod after `npm run build`
```

The API itself always runs inside the main backend process.

## Frontend

- **All Files** → header/mobile **Import from URL** button opens a modal:
  URL (required), file name (optional, auto-detected), destination virtual
  folder (defaults to the folder you are in), storage account (default
  **Automatic** routing).
- The modal calls `POST /remote-imports/probe` (debounced ~500 ms) while a
  valid URL is present. While the probe runs it shows a **Detecting file
  name...** spinner; when it succeeds it pre-fills the File Name field and
  shows the source (**Detected from server header** / **Detected from URL**).
  A name the user types is never overwritten by a later probe response (the
  modal tracks a manual-edit flag and drops stale responses via an
  AbortController + probe token). Probe failure shows **File name could not
  be detected. Enter it manually.** — it never blocks starting an import, and
  raw internal errors, signed URLs, IPs and stack traces are never displayed.
- **Storage → Remote Imports** page lists your imports with live progress
  bars (polled every 3 s while anything is active), stage labels
  (`Checking URL`, `Downloading`, …), and per-item actions:
  **Cancel** (queued/processing), **Retry** (failed/cancelled), **Delete**.
  Completed imports link to the registered file.

## Operations

- **Restarts**: the worker re-connects to Redis and resumes; BullMQ redelivers
  in-flight jobs. In-progress Google Drive resumable sessions can be resumed
  from the encrypted session URI.
- **Temp disk**: downloads land on the shared volume only; bytes are streamed,
  never buffered in memory. The sweeper deletes files older than
  `REMOTE_IMPORT_TEMP_RETENTION_HOURS`.
- **Quota**: after a successful upload the account quota is re-synced
  asynchronously (best-effort).
