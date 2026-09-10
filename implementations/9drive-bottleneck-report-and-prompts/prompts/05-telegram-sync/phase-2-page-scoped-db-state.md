# Phase 2 — Replace Account-Wide Telegram File Preload with Page-Scoped Lookups

**Bottleneck:** B5 — Telegram sync serialization and account-wide memory loading  
**Phase:** 2 of 3

## Objective

Make Telegram sync memory usage scale with page size rather than total indexed files by querying only DB rows relevant to the current Telegram page, while preserving full-scan missing detection.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/telegram/telegram-sync.service.ts`
- `backend/src/modules/telegram/telegram-metadata.ts`
- `backend/src/modules/telegram/telegram-index.service.ts`
- `backend/src/modules/sync/missing-reconciler.ts`
- `backend/prisma/schema.prisma`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

The audited service loads existing Telegram-backed File rows for the whole connected account before scanning pages, then builds maps. This becomes expensive as indexed channel size grows.

The File model already has `lastSeenSyncRunId`, and Telegram has `telegramStableId`. These should allow page-local matching plus generation-based final missing reconciliation if implemented carefully.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Identify every purpose currently served by `existingRows` and account-wide maps: providerFileId matching, stable-id matching, size/name heuristics, missing detection, or issue reporting.
2. Replace account-wide preload with page-scoped queries using identifiers extracted from the current Telegram page.
3. Use composite query predicates scoped to user and connected account. Never query stable IDs globally.
4. Preserve logical identity priority rules: `telegramStableId` must remain authoritative where the current design specifies it.
5. Use the current sync run generation (`lastSeenSyncRunId`) to identify unseen active rows after a successful complete scan rather than retaining every row in RAM.
6. Do not mark unseen rows missing after an incomplete/failed scan.
7. Add/adjust safe indexes only if query plans require them; create Prisma migration when schema changes are needed.

## Tests and Verification

- Test a multi-page sync where rows from earlier pages are not retained in an account-wide map.
- Test stable-id match, provider-id match, ambiguous/orphan paths, and missing reconciliation.
- Test failed/incomplete scan does not falsely mark files missing.
- Run Telegram sync tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/domain/*telegram*`
- `docs/application/workflows/*telegram*`
- `docs/reference/*database*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Peak DB state retained by the service is bounded primarily by Telegram page size.
- [ ] Stable Telegram logical identity is preserved.
- [ ] Full successful scan can still detect missing remote objects.
- [ ] Partial/failed scans cannot create false missing state.

## Do Not

- Do not replace stable-id matching with filename-only matching.
- Do not run account-wide `findMany` merely to perform missing detection.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
