# Phase 1 — Instrument and Classify Sync Reconciliation

**Bottleneck:** B4 — sync database write amplification  
**Phase:** 1 of 3

## Objective

Make file reconciliation explicitly classify new, changed, unchanged, and restored rows before writes, while preserving current behavior. Add diagnostics/tests that provide a baseline for Phase 2 batching.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/sync/file-reconciler.ts`
- `backend/src/modules/sync/file-reconciler.test.ts`
- `backend/src/modules/sync/missing-reconciler.ts`
- `backend/src/modules/sync/sync-drive.ts`
- `backend/src/modules/sync/sync-s3.ts`
- `backend/prisma/schema.prisma`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

The current reconciler already performs page-scoped `findMany` using provider IDs, which is good. The remaining issue is write amplification: unchanged rows can still be individually updated to stamp `lastSeenSyncRunId`.

This phase should make the semantic categories explicit without prematurely replacing safe per-row behavior.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Refactor reconciliation into an explicit page classification result: new, changed, unchanged-needs-stamp, already-stamped, restored, and any provider-specific exceptional category currently required.
2. Keep all current rename/move/status/size/mime/checksum behavior unchanged.
3. Add per-page/run diagnostic counts for scanned, new, changed, unchanged, restored, stamped, and failed items using existing logging/SyncRun fields where appropriate.
4. Strengthen unit tests around each classification and `lastSeenSyncRunId` behavior.
5. Document which categories are safe to batch and which require per-row logic/returned IDs.

## Tests and Verification

- Run `file-reconciler` tests.
- Run sync Drive/S3/missing/e2e tests.
- Compare returned reconciliation counts with pre-refactor behavior on fixtures.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/SYNC.md`
- `docs/application/workflows/*sync*`
- `docs/reference/*database*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Classification is explicit and covered by tests.
- [ ] No batching-induced semantic change is introduced yet.
- [ ] Measurements exist to show how many writes Phase 2 can eliminate.
- [ ] Missing reconciliation generation semantics remain unchanged.

## Do Not

- Do not add a uniqueness migration in this phase.
- Do not use `createMany` merely for speed if callers require created rows.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
