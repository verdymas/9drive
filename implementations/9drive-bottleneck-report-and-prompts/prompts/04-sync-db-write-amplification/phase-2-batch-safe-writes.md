# Phase 2 — Batch Safe Sync Writes

**Bottleneck:** B4 — sync database write amplification  
**Phase:** 2 of 3

## Objective

Reduce MySQL write amplification by batching reconciliation writes that are semantically identical, especially unchanged-row generation stamping, while keeping changed/restored logic correct.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/sync/file-reconciler.ts`
- `backend/src/modules/sync/file-reconciler.test.ts`
- `backend/src/modules/sync/missing-reconciler.ts`
- `backend/prisma/schema.prisma`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

Phase 1 should identify categories that can safely share one write. The highest-value case is unchanged rows that only need `lastSeenSyncRunId = currentRunId`.

Use Prisma operations that preserve user/account boundaries and avoid accidentally updating rows that changed between classification and write.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Replace one-per-row generation stamping with `updateMany` over the exact classified IDs, scoped by the expected account/user/status conditions.
2. Consider `createMany` for new rows only if downstream code does not require the returned created record IDs and there are no per-row side effects. Otherwise keep new rows as bounded writes or use a safe transaction.
3. Keep changed/restored rows per-row if they require unique data or conflict checks.
4. Use transactions only where they improve correctness; do not create giant transactions spanning entire provider accounts.
5. Keep pages bounded so SQL `IN` lists remain reasonable.
6. Preserve failure accounting: one batch failure must be visible and must not silently mark the SyncRun successful.
7. Update diagnostics to report DB write operations or batch counts where feasible.

## Tests and Verification

- Test a page of many unchanged rows and assert semantically one batched stamp operation is used.
- Test mixed new/changed/unchanged/restored pages.
- Test a batch DB failure.
- Run all sync tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/SYNC.md`
- `docs/application/workflows/*sync*`
- `docs/reference/*database*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Unchanged generation stamping is page-batched.
- [ ] Write count no longer scales one-to-one with unchanged file count.
- [ ] Changed/move/rename/restore/missing behavior is unchanged.
- [ ] No cross-account or cross-user update is possible.
- [ ] SyncRun error state remains trustworthy.

## Do Not

- Do not build one account-wide transaction.
- Do not sacrifice per-row correctness for `createMany`.
- Do not remove `lastSeenSyncRunId` generation-based missing detection.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
