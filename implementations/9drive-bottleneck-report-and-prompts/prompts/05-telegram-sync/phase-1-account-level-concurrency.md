# Phase 1 — Telegram Account-Level Concurrency with Single-Flight Safety

**Bottleneck:** B5 — Telegram sync serialization and account-wide memory loading  
**Phase:** 1 of 3

## Objective

Allow independent Telegram accounts to sync concurrently while guaranteeing that the same connected account cannot run conflicting full syncs at the same time.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/telegram/telegram-sync.worker.ts`
- `backend/src/modules/telegram/telegram-sync.queue.ts`
- `backend/src/modules/telegram/telegram-sync.scheduler.ts`
- `backend/src/modules/telegram/telegram-sync.service.ts`
- `backend/src/config/env.ts`
- `backend/prisma/schema.prisma`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

The worker currently uses BullMQ `concurrency: 1`, which serializes every Telegram sync globally. The configuration already contains Telegram sync settings, and the service has FloodWait handling.

The correct parallelism boundary is primarily account/job level, not unbounded document-level concurrency.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Wire an explicit Telegram worker concurrency setting through validated environment configuration, reusing an existing intended variable if present rather than creating duplicate configuration.
2. Implement or verify a robust single-flight guard per `connectedAccountId`. It must survive multiple worker processes if multi-process deployment is supported; an in-memory Set alone is insufficient.
3. Ensure scheduled/manual retries for the same account cannot perform overlapping destructive/full missing reconciliation.
4. Independent accounts should be able to occupy separate worker slots.
5. Keep FloodWait behavior account-local where possible so one account's wait does not unnecessarily block all other accounts.
6. Preserve queue retry, scheduler, sync-run history, and issue tracking.

## Tests and Verification

- Test two different accounts can execute concurrently using controlled promises.
- Test the same account cannot enter the critical sync section twice.
- Test lock/single-flight release on success, failure, cancellation, and worker exception.
- Run Telegram queue/scheduler/service tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*telegram*`
- `docs/application/workflows/*telegram*`
- `docs/reference/*environment*`
- `docs/runbooks/*telegram*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Independent Telegram accounts can progress concurrently.
- [ ] One account remains single-flight.
- [ ] Worker concurrency is configuration-driven.
- [ ] FloodWait and retry semantics remain correct.
- [ ] No user-facing route/status behavior changes.

## Do Not

- Do not parallelize dozens of Telegram API calls in this phase.
- Do not use only process-local locking if multiple workers may exist.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
