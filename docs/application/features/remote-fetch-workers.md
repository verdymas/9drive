# Feature: Remote Fetch Workers

## Purpose
Manage selectable network relays that Remote Import can use to fetch a source through another network or region.

## Backend

- `backend/src/modules/remote-fetch-workers/workers.routes.ts`
- `workers.service.ts`
- `driver-registry.ts`
- `drivers/cloudflare.ts`
- transports: `direct-transport.ts`, `cloudflare-transport.ts`, relay protocol.

## Frontend

- `frontend/src/pages/WorkersPage.tsx`
- `frontend/src/lib/workers.ts`

## API

Base `/workers`:

- `GET /drivers`
- worker CRUD;
- `POST /:id/test`
- `POST /:id/enable`
- `POST /:id/disable`
- `POST /:id/set-default`
- standard delete and `force-delete` administrative fallback.

## State
Worker status vocabulary includes `unknown`, `healthy`, `unhealthy`, `disabled`, `provisioning`, and `provision_failed`.

## Security
Provider credentials/configuration are encrypted in the database. APIs may expose only safe metadata such as whether credentials are configured, capabilities, health, region, and explicitly non-secret endpoint information.

## Architecture Rule
Remote worker selection is independent from destination storage selection.
