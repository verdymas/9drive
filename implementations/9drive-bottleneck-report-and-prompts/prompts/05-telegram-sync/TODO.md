# Telegram Sync B5 Progress

## Phase 1 — Account-level concurrency and durable single flight

- [x] Use `TELEGRAM_SYNC_CONCURRENCY` for BullMQ worker slots.
- [x] Preserve DB-backed same-account single-flight safety.
- [x] Add worker and lock lifecycle regression tests.
- [x] Update Phase 1 documentation.
- [x] Verify Phase 1 targeted tests and backend build.

## Phase 2 — Page-scoped reconciliation state

- [x] Replace account-wide Telegram file preload with page-scoped lookups.
- [x] Stamp observed rows with the current sync run generation.
- [x] Detect missing rows after successful full scans only.
- [x] Add page/missing reconciliation regression tests.
- [x] Update Phase 2 documentation.
- [x] Verify Phase 2 targeted tests and backend build.

## Phase 3 — Bounded caption work and persistence

- [x] Add bounded caption lookup concurrency.
- [x] Skip caption calls for unambiguous page matches.
- [x] Batch equivalent run-stamp persistence and add diagnostics.
- [x] Keep reconciliation issue creation idempotent.
- [x] Add caption/FloodWait/issue regression tests.
- [x] Update Phase 3 documentation.
- [x] Verify full Telegram tests and backend build.

## Completion Evidence

- [x] All three phases are implemented in order.
- [x] `cd backend && npm test` passes.
- [x] `cd backend && npm run build` passes.

## Implementation Notes

- `backend/src/config/env.ts`: added `TELEGRAM_SYNC_CAPTION_CONCURRENCY` (int, min 1, max 16, default 4).
- `backend/src/modules/telegram/telegram-sync.worker.ts`: wired `env.TELEGRAM_SYNC_CONCURRENCY` into BullMQ worker concurrency.
- `backend/src/modules/telegram/telegram-sync.service.ts`:
  - Page-scoped DB lookups via `providerFileId IN (...)`.
  - Generation stamping (`lastSeenSyncRunId`) batched per page via `prisma.file.updateMany`.
  - Generation-based missing detection after successful full scans only.
  - Bounded caption fetching (`TELEGRAM_SYNC_CAPTION_CONCURRENCY`) for orphan docs.
  - Caption fast path: page-payload captions are used directly (no `getMessages` round-trip).
  - Idempotent issue creation via `createIssueIfOpenNotExists`.
- Tests: `telegram-sync.service.test.ts`, `telegram-sync.trash-missing.test.ts`, `telegram-sync.worker.test.ts` updated/added. Full Telegram suite: 202 tests passing.
