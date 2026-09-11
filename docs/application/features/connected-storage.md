# Feature: Connected Storage

## Supported Providers

- Google Drive
- S3-compatible object storage
- Telegram private-channel storage

## Backend Entry Points

- `backend/src/modules/connected-accounts/connected-account.routes.ts`
- `backend/src/modules/google/google.service.ts`
- `backend/src/modules/s3/s3.service.ts`
- `backend/src/modules/telegram/telegram*.ts`
- `backend/src/modules/storage/storage.routes.ts`

## Frontend Entry Points

- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/hooks/useSettings.ts`
- `frontend/src/pages/QuotaTrackerPage.tsx`
- `frontend/src/lib/connectedAccounts.ts`
- `frontend/src/lib/telegram.ts`

## Responsibilities

- list connected accounts;
- connect/reconnect Google;
- create/test S3 accounts;
- connect Telegram and select a storage channel;
- toggle/update account metadata, including auto-allocation;
- synchronize quota/usage;
- aggregate storage summary/breakdown;
- configure upload routing policy.

## Important Rule
Provider-specific credentials and configuration belong in provider configuration tables/services. Generic storage behavior should continue to operate against `ConnectedAccount`/`StorageAccount` abstractions.
