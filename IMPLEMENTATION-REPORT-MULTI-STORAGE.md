# Implementation Report — Multi-Storage Virtual Folders with Lazy Physical Folder Replication

Date: 2026-08-07
Spec: `9drive-multiaccount-folder-virtual.md` (fully implemented)

## Root cause

Previously each virtual `Folder` was bound to exactly one connected account
(`Folder.connectedAccountId` + `Folder.providerFolderId`). Upload routing read
that binding and treated it as a **strict pin** (`allowFallback: false`) in four
places (multipart, resumable init, HLS import, direct import), because
uploading into a Drive folder via a different account yields provider 404s.
Consequence: every file in a folder was forced onto one account, wasting
capacity elsewhere, and Automatic could not help when that account filled up.

The refactor decouples the two concepts:

- **Virtual folder** — the logical tree the user navigates; owns no storage.
- **FolderStorageLocation** — a physical folder instance of a virtual folder on
  one connected account (its `providerFolderId`). A virtual folder has 0..N
  locations, one per account.

## Schema changes

```prisma
model Folder {
  id                 String  @id @default(uuid()) @db.Char(36)
  // ...
  connectedAccountId String? @map("connected_account_id") @db.Char(36)  // legacy (kept)
  providerFolderId   String? @map("provider_folder_id") @db.VarChar(191) // legacy (kept)
  storageLocations   FolderStorageLocation[]
}

model FolderStorageLocation {
  id                 String           @id @default(uuid()) @db.Char(36)
  folderId           String           @map("folder_id") @db.Char(36)
  connectedAccountId String           @map("connected_account_id") @db.Char(36)
  provider           String           @db.VarChar(32)
  providerFolderId   String           @db.VarChar(191)
  createdAt          DateTime         @default(now()) @map("created_at")
  updatedAt          DateTime         @updatedAt @map("updated_at")
  folder             Folder           @relation(fields: [folderId], references: [id], onDelete: Cascade)
  connectedAccount   ConnectedAccount @relation(fields: [connectedAccountId], references: [id], onDelete: Cascade)
  @@unique([folderId, connectedAccountId])
  @@index([connectedAccountId])
  @@index([folderId])
  @@map("folder_storage_locations")
}
```

`File.connectedAccountId` remains required — a file always lives on exactly one
physical account; the refactor never moves provider ownership into locations.

> **Post-verification fix (2026-08-07):** `providerFolderId` in the
> `FolderStorageLocation` model originally lacked `@map("provider_folder_id")`.
> The generated client therefore queried the literal column `providerFolderId`
> while the hand-written migration had created `provider_folder_id`, producing
> `column does not exist` at `GET /folders` in production. Added the missing
> `@map` in `schema.prisma` — the migration did not need re-running (DB was
> already correct); only the client needed regeneration/redeploy.

## Migration

`backend/prisma/migrations/20260807080000_multi_storage_locations/migration.sql`
(hand-authored, following the repo's folder-per-migration conventions):

1. `CREATE TABLE folder_storage_locations` — unique `[folder_id, connected_account_id]`,
   named indexes, `utf8mb4_unicode_ci`, cascading FKs.
2. Backfill `INSERT ... SELECT UUID(), id, connected_account_id, provider,
   provider_folder_id, NOW(3), NOW(3) FROM folders WHERE connected_account_id
   IS NOT NULL AND provider_folder_id IS NOT NULL AND NOT EXISTS (...)`
   — every legacy bound folder becomes one location row; idempotent via the
   `NOT EXISTS` guard, so a partial re-run is safe.
3. The legacy `folders.connected_account_id` / `provider_folder_id` columns are
   **kept** (WebDAV and sync-google still read them during the migration
   period; dropping them is a follow-up).

You (the user) must run `prisma migrate dev` / `migrate deploy` against your
live MySQL to apply it.

## Routing changes

**Old**: folder-ownership pins made Automatic meaningless for subfolder
uploads — the folder's account won unless the file exceeded its quota, and
then the upload failed.

**New**: `resolveUploadPlacement(userId, virtualFolderId, requestedAccountId,
sizeBytes, reservedBytesByAccount, mode, excludeAccountIds)` in
`backend/src/modules/storage/upload-placement.service.ts` is the single
placement seam shared by multipart, resumable, HLS and direct imports:

- **Automatic** (`requestedAccountId` unset): `selectAccount` routes among ALL
  eligible connected accounts. Quota is the hard filter (a 2 GB account with
  the destination folder loses to a 45 GB account without it). Accounts that
  already hold a physical location for the destination folder are a **soft
  tie-breaker only** (`preferredAccountIds`), never a constraint.
- **Manual** (user pick): authoritative. It is used or the request fails with a
  clear `STORAGE_ACCOUNT_INSUFFICIENT_QUOTA` / `STORAGE_ACCOUNT_NOT_ELIGIBLE`
  — no silent switch (spec §15).
- **Bounded reroute**: `rerouteOrFail` re-selects excluding tried accounts
  (max 2) when the chosen account's quota turns out insufficient mid-flight in
  automatic mode; after the bound it throws
  `AUTOMATIC_STORAGE_REROUTE_EXHAUSTED`. Manual pins never reroute.
- `NO_ACCOUNT_WITH_ENOUGH_SPACE` (the code the UI knows) is kept as the mapped
  error for `AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT`.

`selectAccount`'s signature is backward compatible; the 4 old pin reads
(`folderRecord.connectedAccountId`) are gone.

## Lazy folder materialization

`ensureFolderStorageLocation(userId, virtualFolderId, connectedAccountId)`
(`backend/src/modules/storage/folder-materialization.service.ts`):

- Returns the existing `FolderStorageLocation` row when present (fast path, no
  provider calls).
- Otherwise loads the virtual folder + ancestor chain in one `findMany`,
  ensures the provider root once, then walks the chain root-first calling
  `createProviderFolder` per level and **persisting each location row
  immediately** — so a concurrent materialization re-reads the winner's row
  (P2002 → re-read) instead of duplicating.
- Returns `{ location, createdCount }`; callers use `.location.providerFolderId`.
- Deterministic and idempotent: calling twice creates once.
- Bounded retry (3 attempts) then `FOLDER_MATERIALIZATION_FAILED`.

## Upload integration

- **Multipart** (`upload.routes.ts`): the folder-pin block is replaced with
  `resolveUploadPlacement(userId, folderId, undefined, size, reservations,
  'multipart')`; the Google parent is
  `placement.folderStorageLocation.providerFolderId`; S3 object keys are built
  with the location's folder prefix via `buildS3ObjectKey(config, userId,
  fileId, fileName, folderPrefix?)`.
- **Resumable**: init resolves placement with the user's pin
  (`body.targetAccountId`); `targetParentId` = placement location; manual
  insufficiency → `STORAGE_ACCOUNT_INSUFFICIENT_QUOTA` (no fallback). Preflight
  stays an account-only capacity planner (the frontend sends no folderId per
  file); placement correctness is guaranteed at init.
- **Batch**: reservations count against both automatic selection and manual
  quota checks.

## Remote Import integration

Both selection blocks in `processor.ts` (HLS at the `SELECTING_STORAGE` stage,
direct after download) call the same `resolveUploadPlacement(..., 'remote-import')`:

- Direct: size = `downloaded.contentLength ?? 0n`; HLS: `pipeline.downloadedBytes`.
- `uploadTempFile` receives `placement.folderStorageLocation.providerFolderId`
  as the provider parent; `google-resumable-uploader.ts` now accepts the parent
  id instead of re-reading `folder.providerFolderId`.
- The registered file keeps the **virtual** `folderId` and the placed account's
  `connectedAccountId`, so files from different accounts aggregate into one
  virtual folder.
- Manual pins are now **strict** for imports too (a deliberate behavior change
  per spec §15): insufficient quota fails with the raw
  `STORAGE_ACCOUNT_INSUFFICIENT_QUOTA`; automatic exhaustion maps to
  `NO_ACCOUNT_WITH_ENOUGH_SPACE` (the code the UI knows).

## All Files behavior

Files are listed/aggregated by `folderId` — the virtual folder id — so uploads
that landed on Drive A and Drive B (or S3) all appear in the same virtual
folder. `GET /folders` and `/recent` expose `storageLocationCount` (from
`_count`) and `primaryLocation` (the most recent location per folder,
computed with one extra `findMany`). The frontend keeps its unified folder
tree; the `FileDetailsDrawer` shows per-file account, which is now correct
per spec §33.

## Folder operations

- **Create**: virtual-first — no provider folder, no location row. A physical
  folder appears lazily when an upload/import/move first needs it on some
  account.
- **Rename**: updates the virtual name (authoritative) then calls
  `renameProviderFolder` per location (Google renames each Drive folder; S3 is
  a no-op — prefixes derive from the virtual path). Provider failures are
  logged, never fatal.
- **Move**: cycle check unchanged; virtual `parentId` update is authoritative,
  then for each existing location `ensureFolderStorageLocation(newParent,
  account)` materializes the new parent on that account and
  `moveProviderFolder` moves the physical folder under it (root → provider
  root). Failures logged, not fatal.
- **Delete**: collects descendants; deletes every active file per provider
  (Google `drive.files.delete`, S3 `deleteS3Object` — S3 files are now actually
  deleted), deletes every `FolderStorageLocation`'s physical folder per account
  (S3 no-op; objects were removed with their files), then removes location
  rows and soft-deletes files + folders, and syncs quota per touched account.
  The `9drive` root is never deleted.

## Concurrency

- The DB unique key `[folderId, connectedAccountId]` is the primary guard;
  every level's location row is persisted immediately after its provider
  folder is created, so a racing materialization re-reads the winner (P2002 →
  re-read) instead of creating duplicates.
- Provider-level reconciliation: `createProviderFolder` (Google) does a
  find-by-name-in-parent before create, so two workers racing the same missing
  level reuse the same Drive folder when possible.
- Residual race (two same-name Drive siblings from a concurrent first
  materialization) is documented as a limitation; mappings stay correct
  because the DB re-read wins.

## Provider differences

- **Google Drive**: `providerFolderId` is a real Drive folder id; folder
  operations hit the Drive API (`files.list`/`create`/`update`/`delete`).
- **S3**: folders are object-key prefixes. `providerFolderId` stores the
  prefix (`9drive/Movies/Action`); `createProviderFolder` just joins prefixes
  (no real object); rename/move/delete are no-ops; upload keys derive from the
  location prefix. Pre-existing flat-key objects (`prefix/userId/fileId/name`)
  are **not migrated** — new uploads with a folder location use the prefixed
  scheme; objects uploaded to the root keep the flat key.
- All provider-dispatching folder operations live in
  `backend/src/modules/storage/provider-folder.service.ts`; routes never call
  the Drive API for folder ops directly (only file delete still does, via the
  authed client).

## Files changed

New:
- `backend/src/modules/storage/folder-materialization.service.ts`
- `backend/src/modules/storage/upload-placement.service.ts`
- `backend/src/modules/storage/provider-folder.service.ts`
- `backend/prisma/migrations/20260807080000_multi_storage_locations/migration.sql`
- `backend/src/modules/storage/folder-materialization.test.ts` (10 tests)
- `backend/src/modules/storage/upload-placement.test.ts` (12 tests)
- `backend/src/modules/folders/folder.routes.test.ts` (6 tests)
- `backend/src/modules/remote-imports/processor-placement.test.ts` (4 tests)

Modified (backend):
- `backend/prisma/schema.prisma` (FolderStorageLocation + relations)
- `backend/src/modules/uploads/storage-routing.service.ts` (preferred-account tie-breaker)
- `backend/src/modules/uploads/upload.routes.ts` (placement-based, 3 spots)
- `backend/src/modules/remote-imports/processor.ts` (placement-based, 2 spots + uploadTempFile parent)
- `backend/src/modules/remote-imports/google-resumable-uploader.ts` (accept parentProviderFolderId)
- `backend/src/modules/folders/folder.routes.ts` (create/rename/move/delete/list, `storageLocationCount` + `primaryLocation`, drop `ensureProviderFolderIds`)
- `backend/src/modules/files/file.routes.ts` (batch move keeps account + materializes dest; `.location.providerFolderId` call sites)
- `backend/src/modules/google/google.service.ts` (sync-google scoped by locations, legacy fallback)
- `backend/src/modules/s3/s3.service.ts` (`buildS3ObjectKey` folder-prefix param)
- `backend/src/modules/remote-imports/processor-hls.integration.test.ts` (adapts to placement seam)

Modified (frontend):
- `frontend/src/pages/AllFilesPage.tsx` (folder type + `primaryLocation` copy-folder-link)
- `frontend/src/data/drive-data.ts` (`FolderItem.primaryLocation`)

Docs: `README.md` "Storage architecture" section.

## Tests added

| File | Coverage |
|---|---|
| `storage/folder-materialization.test.ts` | account eligibility, FOLDER_NOT_FOUND, idempotent reuse, full parent-chain materialization (Movies→Action→Marvel), reuse-missing-tail, per-account physical folders, S3 prefix chain, P2002 race recovery, FOLDER_MATERIALIZATION_FAILED, determinism |
| `storage/upload-placement.test.ts` | Scenarios A-E (preference tie-breaker, quota hard filter, no eligible account, manual authoritative + no silent switch, reroute bound), reservations, root upload without materialization, upload-1-on-A/upload-2-on-B same virtual folder |
| `folders/folder.routes.test.ts` | listing (storageLocationCount + primary most-recent), rename → both locations renamed, move → parent materialized per account + moved, move-to-root via provider root, cycle rejection, delete → files per provider + locations + soft-delete tree |
| `remote-imports/processor-placement.test.ts` | direct import routes through placement, virtual folderId kept on registered file, NO_ACCOUNT_WITH_ENOUGH_SPACE mapping, raw quota code for manual pin, Drive A full → Drive B lands same virtual folder |

## Commands executed

| Command | Result |
|---|---|
| `cd backend && npx prisma format` | ✅ formatted |
| `cd backend && npx prisma validate` | ✅ schema valid |
| `cd backend && npx prisma generate` | ✅ (DATABASE_URL set) |
| `cd backend && npm run build` | ✅ tsc clean |
| `cd backend && npm test` (vitest run) | ✅ 21 files, 227 tests passed |
| `cd frontend && npm run build` | ✅ tsc + vite clean |
| `cd frontend && npm test` (`--config ./vite.config.test.ts`) | ✅ 3 files, 43 tests passed |
| `docker compose config --quiet` | ✅ syntax valid |
| `prisma migrate dev` | ⏸ **requires live MySQL — run by the user** |

## End-to-end result

The mandatory scenario (spec §55: Drive A full → Automatic selects Drive B →
lazy materialize → upload → both accounts' files visible in one virtual
folder) is scripted and green in the automated suite:

- `upload-placement.test.ts` — "Scenario B": quota is the hard filter — a
  folder-present account with 2 GB loses to a 10 GB account; the chosen
  account's physical folder is materialized lazily. "upload-1-on-A /
  upload-2-on-B land in the same virtual folder": both files carry the same
  virtual `folderId`, and `ensureFolderStorageLocation` is called per account.
- `folder-materialization.test.ts` — "gives different accounts different
  physical folders for the same virtual folder": Drive A and Drive B each get
  their own physical folder for `Movies`, while both map to the one virtual
  folder; the Movies/Action/Marvel chain materializes root-first.
- `processor-placement.test.ts` — "Drive A full → Automatic selects Drive B":
  the direct import routes through `resolveUploadPlacement`, the file lands on
  B's `drive-movies-b` parent via the real uploader call, and the registered
  file keeps `folderId: 'movies'` with `connectedAccountId: 'acc-b'`.

Full live-Drive verification (real accounts) is out of the automated suite —
providers are mocked; the tests prove the placement/materialization logic end
to end through the real services and routes.

## Remaining limitations

- **S3 key scheme is forward-only**: pre-existing flat-key objects
  (`prefix/userId/fileId/name`) are not migrated to the folder-prefixed scheme;
  new uploads into a materialized folder use the prefixed key, root uploads
  keep the flat key.
- **Residual Google duplicate-folder race**: two workers concurrently creating
  the same missing level can still create two same-name Drive siblings; the DB
  re-read keeps mappings correct, but a duplicate physical folder may exist
  until manually cleaned. Mitigated (not eliminated) by the find-by-name
  reconciliation in `createProviderFolder`.
- **Legacy columns kept**: `Folder.connectedAccountId` / `providerFolderId`
  remain (WebDAV + sync-google read them during the migration period). Dropping
  them is a follow-up after a deployment cycle.
- **Remote Import manual pins are now strict** (were soft): a pinned import
  fails with the clear quota error instead of silently switching providers —
  per spec §15, this is intended.
- **No rebalancing**: existing files stay on their account; moving them is out
  of scope (spec §24).
- **Live provider e2e not automated**: real Drive/S3 flows need real accounts.
- **WebDAV** still reads the legacy `Folder.providerFolderId` in places; the
  file-streaming path is account-correct via `file.connectedAccount`, but a
  full multi-location WebDAV folder listing remains legacy-bound until the
  columns are dropped.

## Follow-up recommendations

- Drop `Folder.connectedAccountId` / `Folder.providerFolderId` after a
  deployment cycle; migrate WebDAV + sync-google to locations exclusively.
- Manual storage rebalance (move a file/folder between accounts).
- Soft pins for Remote Import (a UI opt-in that allows fallback) if desired.
- Live-provider e2e harness (real Drive + S3 accounts) for the §55 scenario.
- Sweep for duplicate Drive siblings from the residual race (one-time script
  that finds same-name folders in one parent and merges).
