# Phase 3 — Bound Telegram Caption Resolution and Batch Safe Persistence

**Bottleneck:** B5 — Telegram sync serialization and account-wide memory loading  
**Phase:** 3 of 3

## Objective

Reduce Telegram API latency and DB round trips by avoiding unnecessary caption work, using low bounded concurrency for ambiguous items, and batching semantically identical persistence operations without violating FloodWait or issue reporting.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/telegram/telegram-sync.service.ts`
- `backend/src/modules/telegram/telegram-caption.service.ts`
- `backend/src/modules/telegram/telegram-caption-refresh.ts`
- `backend/src/modules/sync/map-with-concurrency.ts`
- `backend/prisma/schema.prisma`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

After Phase 2, matching should be page-local. Many items can be identified from provider ID/stable metadata without expensive extra Telegram calls. Only ambiguous/orphan cases should require deeper caption resolution.

The repository already has a generic `map-with-concurrency` utility under sync that may be reusable if its semantics fit.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Classify items into unambiguous and caption-required categories before making extra Telegram calls.
2. Skip caption/network enrichment when the existing metadata is sufficient to produce exactly the same reconciliation result.
3. Process caption-required items with a small configurable bounded concurrency and existing FloodWait-aware retry behavior.
4. If many rows only need the same run stamp/status update, batch those DB writes safely.
5. Keep issue creation/resolution deterministic and idempotent.
6. Do not let one item's FloodWait retry explode total page concurrency.
7. Add diagnostics for pages scanned, caption lookups attempted/skipped, FloodWait events, matched/new/ambiguous counts.

## Tests and Verification

- Test that unambiguous matches perform no caption lookup.
- Test bounded maximum in-flight caption operations.
- Test FloodWait behavior.
- Test issue persistence and duplicate prevention.
- Run all Telegram sync tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*telegram*`
- `docs/application/workflows/*telegram*`
- `docs/reference/*environment*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Caption calls are limited to cases that require them.
- [ ] In-flight Telegram calls are bounded.
- [ ] FloodWait handling remains correct.
- [ ] DB persistence is batched only where semantics are identical.
- [ ] Sync results remain equivalent to pre-optimization fixtures.

## Do Not

- Do not raise concurrency aggressively to hide inefficient matching.
- Do not suppress Telegram issues/errors to improve apparent speed.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
