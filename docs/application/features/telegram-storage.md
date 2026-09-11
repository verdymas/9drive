# Feature: Telegram Storage Provider

## Architecture
A Telegram account uses an MTProto client (`teleproto`) and a private channel as blob storage. The 9Drive database remains the logical filesystem source of truth.

## Auth/Setup API

Base `/telegram`:

- `POST /auth/start`
- `POST /auth/verify`
- `GET /accounts/:accountId/channels`
- `POST /accounts/:accountId/channel`
- `POST /accounts/:accountId/test`
- `POST /accounts/:accountId/index`
- `POST /accounts/:accountId/import`
- `POST /files/:fileId/sync-caption`

## Sync API

- `POST /telegram/sync`
- `GET /telegram/sync/runs`
- `GET /telegram/accounts/:accountId/status`
- `GET /telegram/accounts/:accountId/sync-issues`
- `POST /telegram/sync-issues/:id/resolve`
- `POST /telegram/sync-issues/bulk-resolve`

## Runtime
The Telegram Sync BullMQ worker and periodic scheduler run inside the API process (`server.ts`). Worker concurrency is config-driven via `TELEGRAM_SYNC_CONCURRENCY` (default `2`, allowed range `1`–`8`), enabling multiple accounts to sync concurrently. Same-account serialization is guaranteed by the atomic database state transition. This differs from the Remote Import worker, which has its own process/container.

The sync lifecycle remains in `telegram-sync.service.ts` (account validation,
single-flight lock, run/state rows, page loop, final status, audit, and usage
refresh). Its phase boundaries are split into:

- `telegram-sync-types.ts` — explicit document, row, outcome, stats, and run types;
- `telegram-sync-classification.ts` — provider-id matching, caption strategy,
  conflict handling, ingest callback, and pure stats updates;
- `telegram-sync-telegram.ts` — paged document access, bounded caption fetches,
  document coercion, and FloodWait retries;
- `telegram-sync-persistence.ts` — safe per-document logs and deduplicated
  reconciliation issues;
- `telegram-sync-reconciliation.ts` — full-scan generation-based missing
  detection and opt-in recoverable trashing.

These modules preserve the existing `runTelegramSync` export, cursor semantics,
caption precedence, page-local database queries, issue/status codes, and
account-local FloodWait behavior.

## Data/Metadata
Use `telegramStableId` plus caption metadata. Never bind logical identity to a Telegram message ID.

## Existing Deep Reference
`docs/implementation/telegram-drive.md` in the repository contains longer historical implementation details.
