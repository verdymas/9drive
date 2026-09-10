# Feature: API Keys and Public Upload API

## API Key Management
The `/api-keys` base path uses user bearer authentication.

- `GET /` — list keys.
- `POST /` — create a key; the raw secret is returned only at creation time.
- `DELETE /:id` — revoke/delete according to the current implementation.

Secrets start with the `9d_live_...` format. The database stores a prefix + hash, never the raw secret. The currently defined scope is `files:upload`.

## External API
`POST /api/v1/uploads` uses `requireApiKey('files:upload')` and reuses the upload handler.

## Related Files

- `backend/src/modules/api-keys/api-key.routes.ts`
- `backend/src/middleware/api-key.middleware.ts`
- `backend/src/modules/public-api/public-api.routes.ts`
- `frontend/src/pages/ApiManagementPage.tsx`
