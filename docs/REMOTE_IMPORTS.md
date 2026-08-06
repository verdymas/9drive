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

1. `POST /remote-imports` with `{ url, folderId?, connectedAccountId?, fileName? }`.
   The URL is validated immediately (scheme, credentials, DNS) and the source
   URL is stored **encrypted** (`sourceUrlEncrypted`).
2. A BullMQ job is enqueued with `jobId = importId` (idempotent — retrying the
   request never double-enqueues).
3. The dedicated **remote-import-worker** process (separate container/service)
   picks the job up:
   - **Probe** — a `Range: bytes=0-0` GET (redirects followed with per-hop SSRF
     validation) to learn `Content-Length` and whether the server supports
     range requests. If a server ignores the range and streams the whole body,
     the probe aborts after the first chunk.
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
4. Status (`queued | processing | completed | failed | cancelled`) and stage
   (`probing | downloading | ... | finished`) plus byte progress are written to
   the `remote_imports` row so the frontend can poll cheaply.

Cancellation removes the queued job immediately and is checked between phases
while processing. Failed/cancelled imports can be retried (`attempt` is
incremented). Both cancel and retry require the job to belong to the caller.

## API

All endpoints require `Authorization: Bearer <token>` and are user-scoped —
you can never read or mutate another user's import.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/remote-imports` | `{ url, folderId?, connectedAccountId?, fileName?, mimeType? }` | The created import |
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
  across hops.
- **Connect timeout** (`REMOTE_IMPORT_CONNECT_TIMEOUT_SECONDS`) and **idle
  timeout** (`REMOTE_IMPORT_IDLE_TIMEOUT_SECONDS`) bound each connection.
- **Max size enforced while streaming**: even without `Content-Length`, the
  stream is counted and aborted at `REMOTE_IMPORT_MAX_BYTES`.

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
