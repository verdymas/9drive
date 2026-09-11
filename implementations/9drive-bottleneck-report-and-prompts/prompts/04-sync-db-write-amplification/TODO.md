# B4 — Sync DB Write Amplification Checklist

Status key: check an item only after its implementation, focused tests,
relevant suite, and documentation update have passed. Complete phases in the
listed order.

## Phase 1 — Instrument and classify

- [x] Reconciliation classifies new / changed / unchanged-needs-stamp / already-stamped / restored explicitly.
- [x] Current rename/move/status/size/mime/checksum behavior is unchanged.
- [x] Per-page and per-run diagnostic counts exist for scanned, new, changed, unchanged, restored, stamped, failed.
- [x] Unit tests cover each classification and `lastSeenSyncRunId` behavior.
- [x] Documentation states which categories are batch-safe vs per-row.
- [x] Focused + full sync suites pass.

## Phase 2 — Batch safe writes

- [x] Unchanged generation stamping uses `updateMany` over the exact classified IDs.
- [x] Batch is scoped by user/account and expected conditions.
- [x] Changed/move/rename/restore/missing behavior is unchanged.
- [x] Batch size keeps SQL `IN` lists bounded.
- [x] A batch DB failure stays visible and never marks the SyncRun successful.
- [x] Diagnostics report DB write operations / batch counts.
- [x] Mixed and failure-path tests pass; full sync suite passes.

## Phase 3 — Physical identity constraint

- [x] Every File creation/upsert path audited (Google, S3, Telegram, sync, upload, Remote Import).
- [x] Duplicate-detection preflight query is documented.
- [x] Decision recorded from evidence (constraint valid or not).
- [x] If not valid, the counterexample is documented and the strongest safe non-unique composite index is added.
- [x] Tests cover duplicate race behavior, provider ingest idempotency, and Telegram stable identity.
- [x] Migration/schema valid; backend build passes; relevant suites pass.
- [x] Documentation updated.

## Acceptance audit

- [x] Verify every phase's acceptance criteria against current code and tests.
- [x] Record commands, results, migrations, and remaining risks.

## Verification record

### Phase 1 — Instrument and classify (done)

Changed files:
- `backend/src/modules/sync/file-reconciler.ts` — pure `classifyFilePage`,
  5 explicit categories, page/run diagnostics, `sync.file.page` +
  `sync.file.page_failed` logs.
- `backend/src/modules/sync/sync.service.ts` — run-scoped diagnostics threaded
  through Drive/S3 scans, `sync.run.file_diagnostics` logged before completion.
- `backend/src/modules/sync/file-reconciler.test.ts` — 24 tests (was 14):
  added classification + diagnostics suites.
- `docs/application/workflows/provider-sync.md` — classification table,
  batch-safety rules, diagnostics events.

No migrations, no new environment variables.

Commands:
- `npx tsc --noEmit -p tsconfig.json` → clean (no output).
- `npx vitest run src/modules/sync/file-reconciler.test.ts` → 24/24 passed.
- `npx vitest run src/modules/sync` → 11 files, 97/97 passed.

Notes: behavior is unchanged this phase — `unchanged` rows are still stamped
per-row. The `rowWrites` counter is the pre-batching baseline; `unchanged` is
the count Phase 2 can collapse into `updateMany`. No benchmark was run, so no
performance claim is made.

### Phase 2 — Batch safe writes (done)

Changed files:
- `backend/src/modules/sync/file-reconciler.ts` — `unchanged` ids collected and
  stamped via bounded `updateMany` (`STAMP_BATCH_SIZE = 500`), guarded by
  `userId` + `connectedAccountId` + `status: 'active'` +
  `lastSeenSyncRunId: { not: runId }`; added `batchWrites`, `batchStamped`,
  `dbWriteOps` counters; failure path rethrows after logging.
- `backend/src/modules/sync/sync.service.ts` — run log now reports
  `batchWrites`, `batchStamped`, `dbWriteOps`, `writesSavedByBatching`.
- `backend/src/modules/sync/file-reconciler.test.ts` — +9 tests: single
  `updateMany` for 50 unchanged rows, 1200 rows → 3 bounded chunks, scoped
  where-clause, cross-account/cross-user isolation, mixed page, batch failure,
  short-count, post-classification soft-delete and rename races.
- `backend/src/modules/sync/sync-e2e.test.ts`, `sync-boundary.test.ts` — prisma
  doubles now honour `where.id: { in: [...] }` (previously scalar-only, which
  would have silently no-opped the batch); e2e idempotency test asserts the
  second run leaves every row active, `filesMissing === 0`, and stamped with
  the new run id.
- `docs/application/workflows/provider-sync.md` — batched stamping section:
  batch size rationale, where-clause, race analysis, transaction stance,
  diagnostics fields.

No migrations, no new environment variables. `STAMP_BATCH_SIZE` is a module
constant (500), not configurable.

Commands:
- `npx vitest run src/modules/sync` → 11 files, 107/107 passed.
- `npx vitest run` (full backend) → 96 files, 1128/1128 passed.
- `npm run build` → succeeded (tsc + relay asset + extension zip).

Mutation check: temporarily replacing `connectedAccountId: ctx.accountId` with
a wrong value in the batch `where` failed 7 tests across 2 files (including the
e2e idempotency test), confirming the new tests actually detect a broken batch.
Reverted, suite green again.

Guarantee vs. measurement: the write-count reduction is a code-level guarantee
(a page of N unchanged files issues `ceil(N/500)` statements instead of N, as
asserted by tests). No benchmark against a real MySQL instance was run, so no
latency or throughput improvement is claimed.

### Phase 3 — Physical identity constraint (done)

**Decision: DO NOT add a unique constraint.** `(connectedAccountId,
providerFileId)` is the sync *classification* identity but is NOT a uniqueness
invariant. Evidence (from a full audit of all 12 File creation sites):

- 5 sites create provisional rows with the literal placeholder
  `providerFileId = 'pending'` before the provider id is known
  (`uploads/upload.routes.ts:97,116`; `remote-imports/processor.ts:299,465,505`).
- Uploads run concurrently (25 files/request via `Promise.all`,
  `upload.routes.ts:179,399`), so several `('account','pending')` rows coexist.
- Failure paths (`upload.routes.ts:108,147`; `processor.ts:331,483,550`) only
  soft-delete and leave `'pending'` permanently. A unique index would break
  these with `P2002`.

No legitimate product behavior creates two rows with the same *real*
`(connectedAccountId, providerFileId)`: Telegram maps one message to one row
via `telegramStableId` (re-uploads/channel moves reconcile in place), and HLS
imports persist exactly one `File` row for the single remuxed container.

**Migration added (non-unique index)** — the strongest safe index for the hot
`{ userId, connectedAccountId, providerFileId: { in: [...] } }` lookup:
- `backend/prisma/migrations/20260911020000_files_user_account_provider_file_id_index/migration.sql`
  (`files_user_id_connected_account_id_provider_file_id_idx`, 55 chars, within
  MySQL's 64-char limit).

Changed files:
- `backend/prisma/schema.prisma` — added `@@index([userId,
  connectedAccountId, providerFileId])` with rationale comment.
- `backend/prisma/migrations/20260911020000_.../migration.sql` — new migration.
- `docs/application/workflows/provider-sync.md` — "Physical identity and the
  duplicate preflight" section: counterexample, preflight SQL (GROUP BY …
  HAVING COUNT(*) > 1), expected handling (no cleanup migration shipped), what
  IS unique by code, and the new index.

Verified:
- `npx prisma validate` — schema valid; the only error is missing
  `DATABASE_URL` env (a process env issue, not a schema error).
- `npx prisma generate` — regenerated client cleanly.
- `npx prisma migrate diff --from-empty --to-schema-datamodel` — Prisma
  generates the exact index name used in the hand-written migration, so no
  drift (vs. the repo's pre-existing `files_user_telegram_stable_id_idx` drift
  precedent).
- `npm run build` — passed.
- `npx vitest run` (full backend) — 96 files, 1128/1128 passed. Duplicate-race,
  cross-account isolation, and sync idempotency are covered by
  `file-reconciler.test.ts` (§67 cases 7–13 + Phase 2 boundary tests); ingest
  idempotency and Telegram stable identity by
  `telegram-ingest.service.test.ts` / `telegram-sync-caption-routing.test.ts`.
- Migration NOT applied to a live DB (no MySQL instance available here); the
  SQL was verified by hand and against Prisma's generated DDL. Applying via
  `prisma migrate deploy` remains for a real environment.

Remaining risk / follow-up: if a future change eliminates the `'pending'`
placeholder (e.g. pre-generating the row UUID and minting a unique placeholder
like `pending:<uuid>`), the non-unique composite could be revisited as a
candidate unique constraint after a cleanup of historical `'pending'` rows.

