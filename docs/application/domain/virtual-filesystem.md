# Domain: Virtual Filesystem

## Purpose
Unify objects from multiple storage providers into one logical tree.

## Entities

### Folder
A user-owned logical folder. `parentId` forms the tree. `providerFolderId`/`connectedAccountId` are legacy/primary-location metadata; multi-provider physical locations are represented by `FolderStorageLocation`.

### FolderStorageLocation
Maps `(logical folder, connected account) → provider folder id`. This mapping is critical for multi-storage behavior and lazy folder materialization.

### File
A logical file with one physical `connectedAccountId + providerFileId`. A file stores `folderId`, provider, name, MIME type, size, status, and an optional Telegram stable ID.

## Invariants

- Folder/file queries must always be scoped to the user.
- Folders with `deletedAt != null` are excluded from the active tree.
- Active files use `status='active'`; delete/trash flows must not lose provider identity before physical operations complete.
- A logical folder must not be assumed to exist on only one account.
- When uploading to an account without a physical destination folder, use the folder materialization service.
- Renaming or moving a Telegram file must refresh its caption so `9drive:path` matches the logical path.

## Read/Stream
`streamProviderFile()` is the primary abstraction for provider-neutral streaming to preview, download, and WebDAV. Google has special export/range handling; S3 and Telegram each provide their own implementation.

## Related Files

- `backend/src/modules/files/file.routes.ts`
- `backend/src/modules/files/stream-file.ts`
- `backend/src/modules/folders/folder.routes.ts`
- `backend/src/modules/storage/folder-materialization.service.ts`
- `backend/src/modules/storage/provider-folder.service.ts`
