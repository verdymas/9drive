# B3 — Remote Import / HLS Resources Checklist

Status key: check an item only after its implementation, focused tests,
relevant suite, and documentation update have passed. Complete phases in the
listed order.

## Phase 1 — Resource observability and admission control

- [x] Inspect temp-storage capacity before disk-heavy work.
- [x] Add documented free-space reserve and unknown-size reservation policy.
- [x] Defer resource-starved work recoverably without losing import intent.
- [x] Release every reservation on success, failure, cancellation, and requeue.
- [x] Expose structured resource diagnostics.
- [x] Preserve sweep, retry, heartbeat, cancellation, and SSRF behavior.
- [x] Add focused tests and run the relevant Remote Import suite.
- [x] Update Remote Import, worker, environment, and runbook documentation.

## Phase 2 — Separate direct and HLS concurrency budgets

- [x] Classify work early and enforce independent direct/HLS limits.
- [x] Preserve one state machine, IDs, status API, and cross-class per-user limit.
- [x] Keep retry, cancellation, heartbeat, and reconciliation correct.
- [x] Add focused tests and run the relevant Remote Import suite.
- [x] Update topology, environment, and worker documentation.

## Phase 3 — Resumable stream-through direct imports

- [x] Add explicit eligibility and retain temp-spool fallback for every ineligible path.
- [x] Implement safe Google resumable stream-through and S3 multipart recovery.
- [x] Keep HLS and Telegram on existing behavior.
- [x] Preserve progress, cancellation, retry, placement, and final registration.
- [x] Add focused tests and run the relevant Remote Import/provider suites.
- [x] Update Remote Import workflow, provider integration, and runbook documentation.

## Phase 4 — Global HLS segment and FFmpeg control

- [x] Bound aggregate HLS segment downloads independently of HLS job count.
- [x] Bound concurrent FFmpeg processes with configurable slots.
- [x] Prevent permit leaks, including cancellation while queued.
- [x] Preserve HLS validation, retries, fallback, and quality selection.
- [x] Add focused tests and run HLS/FFmpeg verification.
- [x] Update HLS, environment, and runbook documentation.

## Acceptance audit

- [x] Verify every phase's acceptance criteria against current code and tests.
- [x] Record commands, results, migrations, new environment variables, and remaining deployment risks.

## Verification record

- Phase 1 — `cd backend && npm test -- src/modules/remote-imports` → 29 files / 377 tests passed; focused admission/HLS/queue/service verification → 5 files / 69 tests passed; `cd backend && npm run build` → passed (2026-09-11).
- Phase 2 — `cd backend && npm test -- src/modules/remote-imports/queue.test.ts src/modules/remote-imports/remote-import.service.test.ts src/modules/remote-imports/queue-reconcile.test.ts` → 3 files / 60 tests passed; `cd backend && npm test -- src/modules/remote-imports` → 29 files / 384 tests passed; `cd backend && npm run build` → passed (2026-09-11).
- Phase 3 — `cd backend && npm test -- src/modules/remote-imports src/modules/s3/s3.service.test.ts` → 31 files / 396 tests passed (eligibility/fallback, exact source range checks, Google session-offset resume, S3 multipart state + cancellation, HLS/Telegram regression); `cd backend && npm run build` and `npm run prisma:generate` → passed (2026-09-11). Apply migration `20260911010000_add_remote_import_stream_upload_state` through the normal deployment flow before enabling stream-through imports.
- Phase 4 — `cd backend && npm test -- src/modules/remote-imports/resource-control.test.ts src/modules/remote-imports/hls/segments.test.ts src/modules/remote-imports/hls/ffmpeg.test.ts` → 3 files / 34 tests passed (global aggregate permit cap, queued cancellation, HLS behavior); `cd backend && npm test -- src/modules/remote-imports src/modules/s3/s3.service.test.ts` → 32 files / 399 tests passed; `cd backend && npm test` → 96 files / 1,107 tests passed; `cd backend && npm run build` → passed (2026-09-11).

## Completion audit

- Phase 1: `statfs` admission leaves `REMOTE_IMPORT_TEMP_FREE_SPACE_RESERVE_BYTES` unused, records safe diagnostics, and releases reservations on every exit path.
- Phase 2: direct/HLS queues use independent worker concurrency while sharing the per-user gate and the existing persisted import state machine.
- Phase 3: only exact range-resumable Google/S3 direct imports bypass a full temp file; state is encrypted and persisted, while all ineligible paths retain spool behavior.
- Phase 4: FIFO global segment and FFmpeg permits cap aggregate activity; cancellation removes queued waiters and all acquire paths release permits in `finally`.
- Deployment requirement: apply `20260911010000_add_remote_import_stream_upload_state` before a release that uses persisted stream-through recovery. No performance claim is made; these are code-level resource bounds.
