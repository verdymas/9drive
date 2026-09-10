# Phase 3 — Validate and Enforce Provider Physical Identity

**Bottleneck:** B4 — sync database write amplification  
**Phase:** 3 of 3

## Objective

Evaluate whether `(connectedAccountId, providerFileId)` is a true uniqueness invariant across all current providers. If and only if the invariant is valid, clean historical duplicates and enforce it with a safe Prisma/MySQL migration.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/prisma/schema.prisma`
- `backend/src/modules/sync/file-reconciler.ts`
- `backend/src/modules/sync/sync-drive.ts`
- `backend/src/modules/sync/sync-s3.ts`
- `backend/src/modules/telegram/telegram-ingest.service.ts`
- `backend/src/modules/telegram/telegram-sync.service.ts`
- `backend/src/modules/uploads/upload.routes.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

The schema has separate indexes for `connectedAccountId` and `providerFileId`, but no composite unique constraint. A physical provider object is generally identified by its connected account plus provider-side ID. However Telegram stable identity and any legacy behavior must be inspected before enforcing this assumption.

This prompt explicitly allows the correct result to be: 'do not add the constraint' if the invariant is not actually true.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Audit every File creation/upsert path for Google Drive, S3, Telegram, sync, upload, Remote Import, and legacy ingestion.
2. Write a duplicate-detection SQL/Prisma preflight grouped by `(connectedAccountId, providerFileId)` and document expected handling.
3. Determine whether any valid product behavior intentionally creates multiple logical File rows for one physical object.
4. If uniqueness is valid, implement deterministic duplicate cleanup/merge rules that preserve shares, logical folder placement, RemoteImport linkage, Telegram stable IDs, and user-visible state.
5. Add a composite unique constraint and adapt race-prone create paths to handle uniqueness conflicts idempotently.
6. If uniqueness is not valid, do not add the constraint; instead document the reason and add the strongest safe non-unique composite index needed by reconciliation.

## Tests and Verification

- Test duplicate race behavior.
- Test provider ingest idempotency.
- Test Telegram stable identity semantics.
- Test migration/preflight on a fixture containing historical duplicates.
- Run sync/upload/Telegram tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/SYNC.md`
- `docs/application/domain/*`
- `docs/reference/*database*`
- `docs/runbooks/*migration*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] The decision is evidence-based, not assumed.
- [ ] No legitimate logical file is silently deleted by cleanup.
- [ ] If added, the unique constraint is migration-safe and callers handle conflicts.
- [ ] If not added, the report/docs explain the counterexample and safe alternative index.

## Do Not

- Do not blindly add the unique index before duplicate analysis.
- Do not resolve duplicates by arbitrary `deleteMany`.
- Do not break Telegram logical identity.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
