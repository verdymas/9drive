# Backend Route Reference

Routes are mounted in `backend/src/app.ts`. Almost all private routes use bearer JWT authentication; exceptions are described in the Auth column.

## Health / Auth

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | Public | API + Remote Import queue health |
| POST | `/auth/register` | Public | Email registration |
| POST | `/auth/login` | Public | Email login |
| GET | `/auth/google/url` | Public | Start Google sign-in |
| GET | `/auth/google/callback` | Public/OAuth | OAuth callback |
| POST | `/auth/google/exchange` | Handoff | Exchange handoff token |
| POST | `/auth/refresh` | Refresh token | Rotate/refresh session |
| POST | `/auth/logout` | Bearer | Revoke session |
| GET | `/auth/me` | Bearer | Current user |

## Connected Accounts / Storage

| Method | Path |
|---|---|
| GET | `/connected-accounts` |
| POST | `/connected-accounts/s3` |
| GET | `/connected-accounts/google/connect-url` |
| GET | `/connected-accounts/google/connect` |
| GET | `/connected-accounts/google/callback` |
| POST | `/connected-accounts/:id/reconnect` |
| POST | `/connected-accounts/:id/sync-quota` |
| PATCH | `/connected-accounts/:id` |
| DELETE | `/connected-accounts/:id` |
| GET | `/storage/summary` |
| GET | `/storage/routing-policy` |
| PATCH | `/storage/routing-policy` |
| GET | `/storage/breakdown` |

## Uploads

| Method | Path |
|---|---|
| POST | `/uploads` |
| POST | `/uploads/resumable/init` |
| POST | `/uploads/resumable/preflight` |
| GET | `/uploads/resumable/status/:id` |
| PUT | `/uploads/resumable/chunk/:id` |
| POST | `/api/v1/uploads` (API key `files:upload`) |

## Files

`GET /files/preview/:token` is public-by-token. Other routes under `/files` use bearer authentication.

| Method | Path |
|---|---|
| GET | `/files/preview/:token` |
| GET | `/files` |
| PATCH | `/files/batch` |
| DELETE | `/files/batch` |
| GET | `/files/trash` |
| POST | `/files/batch/restore` |
| DELETE | `/files/batch/permanent` |
| GET | `/files/shared-links` |
| POST | `/files/sync-google` |
| GET | `/files/:id` |
| PATCH | `/files/:id` |
| POST | `/files/:id/share` |
| POST | `/files/:id/public-permission` |
| DELETE | `/files/:id/share` |
| POST | `/files/:id/preview-token` |
| GET | `/files/:id/view-url` |
| GET | `/files/:id/download` |
| DELETE | `/files/:id` |
| POST | `/files/batch-download` |

## Folders / Invites / Public

| Method | Path |
|---|---|
| GET | `/folders` |
| GET | `/folders/recent` |
| POST | `/folders` |
| PATCH | `/folders/:id` |
| DELETE | `/folders/:id` |
| GET | `/invites` |
| POST | `/invites` |
| DELETE | `/invites/:id` |
| GET | `/public/files/:token` |
| GET | `/public/files/:token/download` |
| GET | `/public/files/:token/preview` |

## Sync

| Method | Path |
|---|---|
| POST | `/sync/all` |
| POST | `/sync/account/:id` |
| POST | `/sync/account/:id/cancel` |
| GET | `/sync/runs` |

## Remote Imports

| Method | Path |
|---|---|
| POST | `/remote-imports/probe` |
| POST | `/remote-imports/parse-curl` |
| POST | `/remote-imports` |
| GET | `/remote-imports` |
| GET | `/remote-imports/:id` |
| POST | `/remote-imports/:id/cancel` |
| POST | `/remote-imports/:id/retry` |
| POST | `/remote-imports/:id/retry-convert` |
| DELETE | `/remote-imports/:id` |

## Remote Fetch Workers

| Method | Path |
|---|---|
| GET | `/workers/drivers` |
| GET/POST | `/workers` |
| GET/PATCH/DELETE | `/workers/:id` |
| POST | `/workers/:id/force-delete` |
| POST | `/workers/:id/test` |
| POST | `/workers/:id/enable` |
| POST | `/workers/:id/disable` |
| POST | `/workers/:id/set-default` |

## Browser Capture

Dashboard/device authentication differs by endpoint; inspect `browser-capture.routes.ts` before changing the authentication boundary.

| Method | Path |
|---|---|
| POST | `/browser-capture/devices/pairing` |
| GET | `/browser-capture/devices` |
| PATCH | `/browser-capture/devices/:id` |
| POST | `/browser-capture/devices/:id/rotate` |
| DELETE | `/browser-capture/devices/:id` |
| GET | `/browser-capture/resources/count` |
| POST | `/browser-capture/devices/register` |
| POST | `/browser-capture/heartbeat` |
| POST | `/browser-capture/resources` |
| GET | `/browser-capture/resources` |
| POST | `/browser-capture/resources/mark-consumed` |
| DELETE | `/browser-capture/resources/:id` |
| GET | `/browser-capture/extension.zip` |
| GET | `/browser-capture/import-options` |
| POST | `/browser-capture/resources/:id/import` |

## Telegram

| Method | Path |
|---|---|
| POST | `/telegram/auth/start` |
| POST | `/telegram/auth/verify` |
| GET | `/telegram/accounts/:accountId/channels` |
| POST | `/telegram/accounts/:accountId/channel` |
| POST | `/telegram/accounts/:accountId/test` |
| POST | `/telegram/accounts/:accountId/index` |
| POST | `/telegram/accounts/:accountId/import` |
| POST | `/telegram/files/:fileId/sync-caption` |
| POST | `/telegram/sync` |
| GET | `/telegram/sync/runs` |
| GET | `/telegram/accounts/:accountId/status` |
| GET | `/telegram/accounts/:accountId/sync-issues` |
| POST | `/telegram/sync-issues/:id/resolve` |
| POST | `/telegram/sync-issues/bulk-resolve` |

## API Keys / Provider Config / Audit / System

| Method | Path |
|---|---|
| GET/POST | `/api-keys` |
| DELETE | `/api-keys/:id` |
| POST | `/provider-configs/google` |
| GET | `/provider-configs` |
| DELETE | `/provider-configs/:id` |
| GET | `/audit-logs` |
| POST | `/system/update` |
| GET | `/system/update-log` |
| GET/POST | `/system/google-config` |
| GET | `/system/backup` |
| POST | `/system/restore` |

## WebDAV / SMB

- `GET /webdav/status` is a public status endpoint; subsequent WebDAV filesystem requests use WebDAV authentication.
- `/smb/*` uses bearer authentication.
- SMB endpoints: shares CRUD, `/reload`, `/status`, users CRUD.

> This route reference is for agent navigation. When changing request/response contracts, read the relevant route file and Zod schema as the source of truth.
