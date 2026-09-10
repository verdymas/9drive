# Domain: Storage Account

## Core Entities

- `ConnectedAccount` — a user's connection to a provider (`google_drive`, `s3`, `telegram`).
- `StorageAccount` — usage/quota snapshot for a connected account.
- `S3StorageConfig` / `TelegramStorageConfig` — provider-specific configuration.
- `ProviderConfig` — OAuth provider configuration, primarily Google.
- `UploadRoutingPolicy` — the user's automatic placement strategy.

## Important Rules

- Every account operation must be scoped by `userId`.
- An account with `reauth_required` is not eligible for upload placement.
- `autoAllocationEnabled=false` excludes an account from automatic routing, but an explicit manual pin can still be authoritative when the flow allows it.
- Telegram becomes usable as storage only after a storage channel is configured.
- S3 and Telegram are treated as indexed/unbounded when the provider does not expose a total quota; Telegram still has a **per-file limit** defined by `TELEGRAM_MAX_FILE_BYTES`.
- Stale quota data is refreshed on a best-effort basis before routing.

## Provider Identity

`ConnectedAccount.providerAccountId` identifies the provider account. `File.providerFileId` identifies the physical object on that provider.

## Related Files

- `backend/prisma/schema.prisma`
- `backend/src/modules/connected-accounts/connected-account.routes.ts`
- `backend/src/modules/storage/storage.routes.ts`
- `backend/src/modules/uploads/storage-routing.service.ts`
