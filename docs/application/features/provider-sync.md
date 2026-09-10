# Feature: Provider → Virtual Sync

## Goal
Reconcile physical provider state into the logical database tree without creating a separate tree for each connected account.

## Backend

- `backend/src/modules/sync/sync.routes.ts`
- `backend/src/modules/sync/sync.service.ts`
- `backend/src/modules/sync/sync-drive.ts`
- `backend/src/modules/sync/sync-s3.ts`
- reconcilers under `backend/src/modules/sync/`

## API

- `POST /sync/all`
- `POST /sync/account/:id`
- `POST /sync/account/:id/cancel`
- `GET /sync/runs`

## Execution Model
Synchronization is currently synchronous from the HTTP request perspective: the request waits for per-account reconciliation, and the UI refreshes after the response. Account/folder concurrency is bounded by environment configuration.

## Safety
Provider interactions during synchronization are designed as read-only discovery/reconciliation. Missing-object reconciliation is account-scoped and runs only after a successful scan, preventing a partial or failed scan from incorrectly marking large numbers of objects as missing.

## Model
`SyncRun` stores status, errors, and reconciliation counters.
