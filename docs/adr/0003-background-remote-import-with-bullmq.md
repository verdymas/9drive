# ADR 0003: Background Remote Import with BullMQ

## Status
Accepted

## Context
Remote URL imports can be long-running operations, including multi-GB downloads, HLS segment collection, FFmpeg remuxing, and uploads to a destination provider.

## Decision
The HTTP API only creates a `RemoteImport` row and enqueues a BullMQ job. A separate worker processes the job and updates progress and heartbeat state in the database.

The queue uses Redis. The worker process/container runs `worker-entry.ts`; the API process acts as the producer and exposes status, cancel, and retry APIs.

## Important Invariants

- A row must not remain `queued` if enqueueing fails.
- `queuedAt`/`jobId` are written only after the queue add succeeds.
- The worker marks the import `processing` and starts heartbeat updates only when execution actually begins.
- A reconciliation sweep detects missing queue jobs and stalled workers.
- Retry uses compare-and-set semantics so concurrent retries cannot create multiple active executions.

## Related Files

- `backend/src/modules/remote-imports/queue.ts`
- `backend/src/modules/remote-imports/worker.ts`
- `backend/src/modules/remote-imports/queue-reconcile.ts`
- `backend/src/modules/remote-imports/remote-import.service.ts`
- `docker-compose.yml`
