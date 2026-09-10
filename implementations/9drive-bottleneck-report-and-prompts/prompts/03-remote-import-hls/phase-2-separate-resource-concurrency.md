# Phase 2 — Separate Direct-Import and HLS Concurrency Budgets

**Bottleneck:** B3 — Remote Import/HLS temp-disk and FFmpeg pressure  
**Phase:** 2 of 4

## Objective

Prevent network-oriented direct imports and CPU/disk-heavy HLS jobs from sharing one undifferentiated concurrency budget. Preserve one user-facing Remote Import feature and status model.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/remote-imports/worker.ts`
- `backend/src/modules/remote-imports/worker-entry.ts`
- `backend/src/modules/remote-imports/queue.ts`
- `backend/src/modules/remote-imports/processor.ts`
- `backend/src/modules/remote-imports/probe.ts`
- `backend/src/config/env.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

`REMOTE_IMPORT_GLOBAL_CONCURRENCY` controls worker activity broadly, while HLS has additional per-job segment concurrency. Direct downloads and FFmpeg/HLS workloads have different resource profiles.

The implementation may use separate BullMQ queues or a dispatcher/semaphore design. Choose the smallest architecture that clearly enforces separate budgets without duplicating the processing state machine.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Classify jobs as direct versus HLS as early as safely possible using existing probe/job metadata.
2. Introduce separate configurable concurrency limits for direct transfer work and HLS/FFmpeg work while preserving backward-compatible defaults.
3. Keep one canonical RemoteImport DB state machine. Do not duplicate status semantics across two processors.
4. If separate queues are used, ensure retry/cancel/job lookup/reconciliation can locate the correct queue transparently.
5. Keep per-user concurrency enforcement across both workload classes so splitting queues cannot bypass user limits.
6. Keep heartbeats and stale-worker detection accurate.
7. Document process topology and environment variables.

## Tests and Verification

- Test that direct jobs can progress while the HLS budget is saturated.
- Test that HLS cannot exceed its configured active-job budget.
- Test per-user concurrency across workload types.
- Test retry/cancel/reconciliation for each workload class.
- Run Remote Import tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/REMOTE_IMPORTS.md`
- `docs/WORKERS.md`
- `docs/reference/*environment*`
- `docs/runbooks/*worker*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Direct and HLS workloads have independent concurrency controls.
- [ ] The external Remote Import API/status model remains unchanged.
- [ ] Per-user limits cannot be bypassed by workload class.
- [ ] Existing retries and stale-job recovery remain correct.

## Do Not

- Do not copy `processor.ts` into separate direct/HLS implementations.
- Do not change user-facing job IDs/status semantics merely to support multiple queues.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
