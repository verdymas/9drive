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

## Download and Preview Delivery

Authorization and active-file checks always happen in 9Drive before a provider
stream is opened. The Phase 1 delivery decision is proxy-only: Google Drive,
S3, and Telegram bytes stream through the backend with normalized range,
content length/range, content type, and content-disposition metadata.

Provider streams use Node stream backpressure and downstream disconnects abort
provider work where the provider supports cancellation. If opening a provider
stream fails before response headers are committed, the API returns the stable
`FILE_STREAM_UNAVAILABLE` JSON error. Errors after streaming starts terminate
the response rather than appending JSON to binary data.

Preview-token routes always use inline proxy delivery. Batch ZIP downloads also
remain backend streams because they compose multiple provider objects.

## Media-plane Routes

The byte-serving subset of `/files` — `GET /files/preview/:token`,
`GET /files/:id/download`, and `POST /files/batch-download` — is exposed as
`createFileMediaRouter()` from `file.routes.ts`. The all-in-one `fileRouter`
binds those same handlers, and the optional split deployment can mount the
media router (plus `/public/files/*` and `/webdav`) in its own process via
`backend/src/app-composition.ts`. External URLs, auth, and range semantics are
identical in both shapes; see `docs/runbooks/media-plane.md`.
