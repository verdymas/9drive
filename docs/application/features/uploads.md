# Feature: Direct Upload

## Backend

- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/modules/uploads/storage-routing.service.ts`
- `backend/src/modules/storage/folder-materialization.service.ts`

## Frontend

- `frontend/src/context/UploadContext.tsx`
- upload UI is consumed by drive pages/components.

## HTTP Modes

- `POST /uploads` — generic direct/multipart handling.
- Google resumable:
  - `POST /uploads/resumable/init`
  - `POST /uploads/resumable/preflight`
  - `GET /uploads/resumable/status/:id`
  - `PUT /uploads/resumable/chunk/:id`

## Routing
Direct Upload and Remote Import use the same storage-routing logic. A destination folder can impose an account preference or constraint through physical folder mappings.

## Data
`UploadSession` stores the target account, folder, file metadata, status, and Google session URI when applicable.

## Agent Checklist
When adding a provider upload path, verify all of these together: routing eligibility, folder materialization, quota update, file DB registration, audit logging, frontend progress, and synchronization semantics.
