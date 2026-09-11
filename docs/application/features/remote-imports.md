# Feature: Remote Imports

## Frontend

- `frontend/src/pages/RemoteImportsPage.tsx`
- `frontend/src/components/drive/RemoteImportModal.tsx`
- `frontend/src/lib/remoteImports.ts`

## Backend

- routes/service: `backend/src/modules/remote-imports/remote-import.routes.ts`, `remote-import.service.ts`
- worker: `worker-entry.ts`, `worker.ts`, `processor.ts`
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
operator contains only free, reserved, and required byte counts plus stage and
import ID. Reservations are released when work completes, fails, cancels, or
is deferred.

## Existing Deep Reference
The repository also contains the older `docs/REMOTE_IMPORTS.md`. Use it for additional historical detail, but treat current source code as authoritative.
