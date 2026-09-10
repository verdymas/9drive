# Integration: Google Drive

## Direction
Bidirectional: OAuth/connect, upload, metadata synchronization, rename/move/delete, preview/download, and quota.

## Core Files

- `backend/src/modules/google/google.service.ts`
- `backend/src/modules/connected-accounts/connected-account.routes.ts`
- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/modules/remote-imports/google-resumable-uploader.ts`
- `backend/src/modules/sync/sync-drive.ts`
- `backend/src/modules/files/stream-google-file.ts`

## Authentication
OAuth configuration can come from encrypted database configuration. Connected accounts store encrypted access/refresh tokens. Reauthentication failures mark the account `reauth_required`; such accounts must not be selected for uploads.

## Storage Convention
The project creates/uses a root `9drive` folder in Google Drive. Provider folders are mapped to logical folders through storage-location mappings.

## Special Cases
Google-native documents may require export MIME mappings when downloading. Do not treat every Drive object as a raw-byte file.
