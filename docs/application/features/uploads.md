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

## Data
`UploadSession` stores the target account, folder, file metadata, status, and Google session URI when applicable.

## Agent Checklist
When adding a provider upload path, verify all of these together: routing eligibility, folder materialization, quota update, file DB registration, audit logging, frontend progress, and synchronization semantics.
