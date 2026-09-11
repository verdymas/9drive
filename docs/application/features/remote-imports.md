# Feature: Remote Imports

## Frontend

- `frontend/src/pages/RemoteImportsPage.tsx`
- `frontend/src/components/drive/RemoteImportModal.tsx`
- `frontend/src/lib/remoteImports.ts`

## Backend

- routes/service: `backend/src/modules/remote-imports/remote-import.routes.ts`, `remote-import.service.ts`
- worker orchestration: `worker-entry.ts`, `worker.ts`, `processor.ts`
- worker phases: `processor-context.ts`, `processor-progress.ts`, `processor-probe.ts`, `processor-direct.ts`, `processor-download.ts`, `processor-hls.ts`, `processor-upload.ts`
- queue/recovery: `queue.ts`, `queue-reconcile.ts`
- secure networking: `ssrf.ts`, `secure-fetcher.ts`, `url-downloader.ts`, `request-context.ts`
- HLS: `backend/src/modules/remote-imports/hls/*`
- storage upload: Google resumable uploader plus provider routing.

## API

- `POST /remote-imports/probe`
- `POST /remote-imports/parse-curl`
- `POST /remote-imports`
- `GET /remote-imports`
- `GET /remote-imports/:id`
- `POST /remote-imports/:id/cancel`
- `POST /remote-imports/:id/retry`
- `POST /remote-imports/:id/retry-convert`
- `DELETE /remote-imports/:id`

## Input Types

1. direct HTTP(S) file;
2. HLS master/media playlist;
3. optional pasted cURL/request context for protected resources;
4. optional Remote Fetch Worker for network routing.

## Failure/Retry
Retry behavior is stage-aware. HLS conversion-specific retry can reuse downloaded/materialized output when safe. Queue/processing reconciliation prevents stuck UI states after a crash or lost queue job.

## Temporary storage admission

Before a direct download or HLS materialization starts, the worker inspects the
filesystem holding `REMOTE_IMPORT_TEMP_DIR` and reserves an estimate for that
worker process. It never starts work that would consume the configured free
space reserve. A capacity shortage remains a recoverable `queued` import at
the `waiting` stage with `RESOURCE_WAITING`; it is re-delayed rather than
reported as a provider or download failure. The safe diagnostic stored for the
operator contains only free, reserved, and required byte counts, stage, import
ID, and a snapshot of the process-wide HLS segment/FFmpeg permit counters.
Reservations are released when work completes, fails, cancels, or is deferred.

## Worker processor boundaries

`processor.ts` remains the stable BullMQ entry point and owns persisted-row
lookup, phase ordering, worker validation, terminal error mapping, and final
temporary-file cleanup. Phase modules own their local mechanics:

- `processor-context.ts` binds a persisted import to timeout, stage, heartbeat,
  cancellation, failure, admission, and progress helpers.
- `processor-probe.ts` performs the bounded range probe and size-cap check.
- `processor-direct.ts` owns Google/S3 stream-through state and transfers.
- `processor-download.ts` materializes non-stream-through sources into the
  import-scoped temporary part.
- `processor-hls.ts` owns segment/remux lifecycle, resource reservations,
  resume markers, and HLS completion.
- `processor-upload.ts` owns provider upload, virtual-file registration, and
  the shared placement-to-completion tail.

These boundaries preserve the existing stage names, encrypted provider state,
retry semantics, quota refreshes, and `processRemoteImportJob(job)` export.

## Frontend boundaries

`frontend/src/components/drive/RemoteImportModal.tsx` remains the modal and
field composition layer. `frontend/src/hooks/useRemoteImportForm.ts` owns URL
and cURL parsing, probe debounce, HLS option state, and submit lifecycle;
`frontend/src/components/drive/RemoteImportHlsSection.tsx` owns the typed HLS
controls. Existing labels, callbacks, routes, and request payloads are
unchanged.

## Worker budgets

Remote Import remains one feature and one status model, but the worker process
consumes `remote-imports-direct` and `remote-imports-hls` separately. This
lets ordinary network transfers continue when CPU/disk-heavy HLS work fills its
own budget. The per-user processing limit is shared by both consumers, so a
user cannot bypass it by submitting both source types.

## Direct stream-through imports

An ordinary direct HTTP source can bypass a full temporary file only when it
has an exact known size, proves a requested byte range with a matching `206`
`Content-Range`, and routes to Google Drive or S3. Google stores its encrypted
resumable session and acknowledged offset; S3 stores encrypted multipart
metadata and reconciles provider-held parts on retry. Each bounded range is
validated again before upload. Any HLS, Telegram, unknown-size, or range-unsafe
source retains the existing temporary-spool flow. A cancellation aborts S3's
multipart upload and prevents final file registration.

## Existing Deep Reference
The repository also contains the older `docs/REMOTE_IMPORTS.md`. Use it for additional historical detail, but treat current source code as authoritative.
