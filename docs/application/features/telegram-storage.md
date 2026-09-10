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
The Telegram Sync BullMQ worker and periodic scheduler run inside the API process (`server.ts`). This differs from the Remote Import worker, which has its own process/container.

## Data/Metadata
Use `telegramStableId` plus caption metadata. Never bind logical identity to a Telegram message ID.

## Existing Deep Reference
`docs/implementation/telegram-drive.md` in the repository contains longer historical implementation details.
