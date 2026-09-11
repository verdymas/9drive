# Feature: Direct Upload

## Backend

- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/modules/uploads/storage-routing.service.ts`
- `backend/src/modules/storage/folder-materialization.service.ts`

## Frontend

- `frontend/src/context/UploadContext.tsx`
- upload UI is consumed by drive pages/components.

## HTTP Modes

- `POST /uploads` — generic direct/multipart handling.
- Google resumable:
  - `POST /uploads/resumable/init`
  - `POST /uploads/resumable/preflight`
  - `GET /uploads/resumable/status/:id`
  - `PUT /uploads/resumable/chunk/:id`
- Optional direct S3 multipart (off by default):
  - `POST /uploads/direct-s3/init`
  - `POST /uploads/direct-s3/:sessionId/parts/:partNumber`
  - `POST /uploads/direct-s3/:sessionId/complete`
  - `POST /uploads/direct-s3/:sessionId/abort`

### Multipart Compatibility Contract

`POST /uploads` (and the API-key alias `POST /api/v1/uploads`) requires
`multipart/form-data` and accepts at most 25 file parts. It has two metadata
forms; metadata must precede its associated file part because Busboy processes
the request in wire order:

- Single file: `sizeBytes` (required, positive), optional `fileName`,
  `mimeType`, and `folderId`, followed by a file part.
- Batch: a `filesMeta` JSON array followed by file parts named by each
  `filesMeta[*].fieldName`. Every item includes `fieldName`, `fileName`,
  `mimeType`, and `sizeBytes`; it can also include `folderId`.

Each declared size is checked against `MAX_UPLOAD_BYTES`, each file is routed
independently through automatic placement using its declared size, and the
streamed byte count is checked before registering the final file row. A folder
ID remains a virtual-folder placement request; the selected provider location
is materialized by the placement service.

- A successful non-batch upload returns `201 { file }`.
- A batch, or a request with both successes and failures, returns
  `201 { files, failed }`.
- If no file succeeds, the route returns `400 { code, message, failed }` using
  the first failure. Stable compatibility codes include
  `UPLOAD_SIZE_REQUIRED`, `UPLOAD_TOO_LARGE`, `UPLOAD_SIZE_MISMATCH`,
  `NO_ACCOUNT_WITH_ENOUGH_SPACE`, and `UPLOAD_FAILED`.

Multipart file parts are copied through a counted, bounded stream pipeline to
`UPLOAD_TEMP_DIR/<upload-session>.multi`; complete file contents are not held
in application memory. The exact byte count and Busboy limit are validated
before provider transfer. Google Drive and S3 consume a read stream from that
spool; Telegram retains its established file-path upload path. The spool is
removed on success, validation errors, provider errors, parser failures, and
client cancellation.

When the client disconnects, the multipart route aborts its stream pipeline;
S3's managed upload and Google request receive the same abort signal. Telegram
does not expose a proven streaming cancellation API and remains a safe staged
file-path fallback. Failed non-Google provider attempts soft-delete their
provisional File rows; quota refresh is still best-effort after completion.

## Routing
Direct Upload and Remote Import use the same storage-routing logic. A destination folder can impose an account preference or constraint through physical folder mappings.

## Optional Direct S3 Multipart Fast Path

`S3_DIRECT_UPLOAD_ENABLED=false` is the default and keeps every provider on the
server-relayed resumable path. When enabled, the dashboard asks
`POST /uploads/direct-s3/init` before each file. The backend routes the upload
through the same authoritative placement service and answers either
`{ mode: 'server' }` — Google, Telegram, an S3 account that cannot sign, or a
disabled feature — or `{ mode: 'direct-s3', sessionId, partSizeBytes,
expiresAt, targetAccountId, targetAccountEmail }`. Only the second form lets
the browser use the fast path.

The browser then requests one short-lived presigned URL per part
(`.../parts/:partNumber`, valid for `S3_DIRECT_UPLOAD_PART_URL_TTL_SECONDS`) and
PUTs that slice directly to S3, reporting `(partNumber, etag, sizeBytes)` on
`.../complete`. The server validates ownership, liveness, and part bounds on
every sign, cross-checks each reported size against the exact layout it
advertised (`S3_DIRECT_UPLOAD_PART_SIZE_BYTES`, minimum 5 MiB), completes the
multipart upload itself, `HEAD`s the object, and only then registers the active
`File` row. Mismatched sizes delete the object and mark the session failed, so a
direct upload can never produce an active file whose bytes are wrong or missing.
The bucket, key, metadata, folder, target account, and final DB registration
stay entirely server-side, and no storage credential is ever returned — only a
single-part, expiring presigned URL.

Failure and recovery semantics:

- A browser-side part failure triggers `.../abort`, which aborts the provider
  multipart upload; the row falls back to Retry through the normal resumable
  path.
- An abandoned session (closed tab, lost network) is aborted and marked
  `failed` by `startDirectS3UploadSweeper`, an unref'd timer that runs only
  while the feature is enabled, and never creates a `File` row.
- `GET /uploads/resumable/status/:id` reports an in-flight direct session as
  `uploading` with the provider's own summed part bytes, and a swept/aborted
  session as terminal — never as a staged local file, since the backend held no
  bytes.
- Existing `POST /uploads` multipart and resumable endpoints are unchanged, so
  API-key and integration clients keep working with the feature off or on.

Configure the bucket's client CORS policy to allow `PUT` with the `ETag`
exposed header on the object prefix before enabling this path.

## Data
`UploadSession` stores the target account, folder, file metadata, status, and Google session URI when applicable; direct S3 sessions additionally store the server-controlled multipart upload ID, object key, session expiry, and reported part list.

## Agent Checklist
When adding a provider upload path, verify all of these together: routing eligibility, folder materialization, quota update, file DB registration, audit logging, frontend progress, and synchronization semantics.
