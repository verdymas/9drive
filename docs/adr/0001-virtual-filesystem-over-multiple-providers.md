# ADR 0001: Virtual Filesystem over Multiple Storage Providers

## Status
Accepted

## Context
9Drive must present files from Google Drive, S3-compatible storage, and Telegram as one tree even though each provider has different folder and identity semantics.

## Decision
The logical filesystem is stored in MySQL through `Folder` and `File`. Physical placement remains referenced through `ConnectedAccount`, `providerFileId`, and `FolderStorageLocation`.

`FolderStorageLocation` allows one logical folder to have physical representations on multiple accounts/providers. A physical provider folder can be created lazily when an upload needs a destination on that provider.

## Consequences

- The UI must not assume one logical folder equals one provider folder.
- Rename, move, and delete operations must account for all related physical locations.
- Synchronization reconciles provider state into the logical DB instead of creating a separate tree per account.
- Upload routing may choose a different account as long as the destination folder can be materialized on that account.

## Related Files

- `backend/prisma/schema.prisma`
- `backend/src/modules/storage/folder-materialization.service.ts`
- `backend/src/modules/storage/provider-folder.service.ts`
- `backend/src/modules/files/file.routes.ts`
- `backend/src/modules/folders/folder.routes.ts`
- `backend/src/modules/sync/*`
