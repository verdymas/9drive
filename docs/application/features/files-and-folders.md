# Feature: Files and Folders

## Frontend

- `frontend/src/pages/AllFilesPage.tsx`
- `frontend/src/pages/RecentPage.tsx`
- `frontend/src/pages/StarredPage.tsx`
- `frontend/src/pages/TrashPage.tsx`
- `frontend/src/components/drive/FileTable.tsx`
- `frontend/src/components/drive/FileGrid.tsx`
- `frontend/src/components/drive/FolderGrid.tsx`
- context menus/details drawer under `frontend/src/components/drive/`

## Backend

- `backend/src/modules/files/file.routes.ts`
- `backend/src/modules/folders/folder.routes.ts`
- `backend/src/modules/files/stream-file.ts`
- `backend/src/modules/storage/provider-folder.service.ts`
- `backend/src/modules/storage/folder-materialization.service.ts`

## Capabilities

Files: list/filter, detail, rename/move, batch update/delete/restore/permanent delete, download, batch ZIP, sharing, preview token, and provider view URL.

Folders: list/recent, create, rename/move/update styling, and delete a tree while coordinating provider objects.

## Cross-provider Rule
Every mutation that touches a physical file/folder must branch by provider. Do not add Google-only behavior to the generic logical layer without corresponding S3/Telegram handling or explicit unsupported behavior.
