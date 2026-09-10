# Phase 3 — Decompose Telegram Sync Service by Responsibility

**Bottleneck:** B7 — oversized modules / engineering throughput  
**Phase:** 3 of 4

## Objective

Split Telegram sync orchestration, matching/classification, caption resolution, persistence, and missing reconciliation into focused modules without changing sync results or FloodWait behavior.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/telegram/telegram-sync.service.ts`
- `backend/src/modules/telegram/telegram-sync.worker.ts`
- `backend/src/modules/telegram/telegram-caption.service.ts`
- `backend/src/modules/telegram/telegram-index.service.ts`
- `backend/src/modules/telegram/telegram-metadata.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

After B5, Telegram sync should be account-concurrent, page-scoped, and bounded. This phase is only to reduce coupling and context cost.

Telegram logical identity is sensitive: `telegramStableId`, provider IDs, captions, issue records, and missing reconciliation must keep their current precedence and semantics.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Document the current matching precedence and state transitions before moving code.
2. Extract pure classification/matching logic from Telegram network calls.
3. Extract page persistence/reconciliation operations from scan orchestration.
4. Keep FloodWait-aware Telegram API access in a focused boundary.
5. Keep one top-level service responsible for run lifecycle, page loop, heartbeat/cancel, and finalization.
6. Use explicit typed results rather than shared mutable maps where possible.
7. Keep existing public service methods and route/worker contracts stable.

## Tests and Verification

- Run all Telegram sync tests.
- Add direct unit tests for extracted pure classification logic.
- Compare fixture outcomes before/after extraction.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*telegram*`
- `docs/application/workflows/*telegram*`
- `docs/application/domain/*telegram*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Matching precedence is explicit and testable.
- [ ] Network concerns are separated from DB classification/persistence.
- [ ] Account concurrency and FloodWait semantics from B5 remain intact.
- [ ] No public sync API behavior changes.

## Do Not

- Do not change logical identity precedence while moving code.
- Do not reintroduce account-wide preload or unbounded concurrency.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
