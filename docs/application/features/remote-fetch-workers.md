# Feature: Remote Fetch Workers

## Purpose
Manage selectable network relays that Remote Import can use to fetch a source through another network or region.

## Backend

- `backend/src/modules/remote-fetch-workers/workers.routes.ts`
- `workers.service.ts`
- `worker-usage.service.ts` (monthly request/egress accounting + safety budgets)
- `provider-capabilities.ts` (verified free-tier capabilities per provider)
- `driver-registry.ts`
- `drivers/cloudflare.ts` (managed)
- `drivers/deno.ts` (manual-endpoint; managed provisioning deferred)
- `drivers/deno-relay/worker.ts` (deployable Deno template, same `9drive-relay-v1` contract)
- transports: `direct-transport.ts`, `cloudflare-transport.ts`, `deno-transport.ts`, relay protocol.

## Frontend

- `frontend/src/pages/WorkersPage.tsx`
- `frontend/src/lib/workers.ts`

## API

Base `/workers`:

- `GET /drivers` (includes `evaluatedOnly`: Vercel experimental, Netlify excluded)
- worker CRUD (manual drivers accept optional `reqBudgetMonthly` / `egressBudgetBytesMonthly` overrides);
- `GET /:id/usage` (monthly requests/egress/failures + budget status, bigints stringified);
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

## Provider notes
See `docs/application/integrations/relay-providers.md` for verified free-tier
constraints, safety-budget defaults, hard-stop behavior, and the evaluated-only
(Vercel) / excluded (Netlify) rationale. A Worker-selected job stays on its
exact provider across probes, downloads, Ranges and retries — never Direct,
never another provider.
