# Remote Fetch Workers

**Workers** are **network relays only** — Remote Fetch Workers let an import
route the initial remote fetch through an external relay (first supported
service: **Cloudflare Worker**). Everything else about a Remote Import stays on
9Drive: FFmpeg, HLS parsing, segment orchestration, retry, progress, temp
files, and the final Google Drive / S3 upload.

```
Remote Source
      │
      ▼
Remote Fetch Worker (relay, optional)          ← the external worker
      │
      ▼
9Drive secure fetcher                            ← always on 9Drive
      │
      ▼
HLS parsing / orchestration → temp files → FFmpeg → upload → register
```

Direct (no-worker) mode remains the default and is always valid.

## Terminology

| Term | Meaning |
|---|---|
| **Remote Fetch Worker** | A registered external network relay that 9Drive can use to fetch remote resources. NOT the internal BullMQ job worker that processes Remote Imports. |
| **Worker driver** | A backend implementation of the relay protocol for one provider (e.g. `cloudflare`). |
| **Direct** | The normal path — 9Drive fetches the remote resource itself. `RemoteImport.workerId` is `null`. |

## Database

`remote_fetch_workers` is **provider-agnostic**: the `driver` column is a
string resolved against the backend driver registry (`cloudflare` today;
`vercel`, `generic-http-relay`, `self-hosted` later). Adding another provider
means implementing + registering a driver — **no schema migration, no CRUD API
change, no menu change**.

Key columns:

- `driver` — registry key; validated in application code, not by an enum.
- `endpointUrl` — **system-generated** for managed (provisioned) drivers: null
  while provisioning and after a failed provision; a manual driver supplies it
  at registration.
- `secretEncrypted` / `configEncrypted` — AES-256-GCM encrypted at rest
  (`TOKEN_ENCRYPTION_KEY`). `secretEncrypted` holds the generated relay secret
  (managed) or the shared secret / bearer token (manual). `configEncrypted`
  holds provider registration + credentials:
  ```json
  { "version": 1,
    "config":     { "accountId": "...", "workerName": "9drive-relay" },
    "credentials":{ "apiToken": "..." },
    "runtime":    { "endpointUrl": "...", "protocolVersion": "9drive-relay-v1" } }
  ```
  **Never returned by any API**: the wire carries `credentialConfigured: true`
  plus the safe `config` sub-object (`providerConfig`) for the edit form — the
  `credentials` (apiToken) never leave the encrypted blob.
- `capabilitiesJson` / `metadataJson` — safe last-known capability/display data
  from a successful test connection.
- `status` —
  `unknown | healthy | unhealthy | disabled | provisioning | provision_failed`,
  plus `lastHealthCheckAt` / `lastHealthyAt` / `lastFailedAt` / `lastErrorCode`.
- `deletedAt` — soft delete; historical Remote Imports keep their `workerId`
  and a `workerNameSnapshot` of the name.

`RemoteImport` gains `workerId` (nullable; `null` = Direct) and
`workerNameSnapshot` (history even after rename/delete).

## Driver architecture

```
RemoteFetchWorkerDriver { key, displayName, managed,
                          validateConfig, testConnection, getMetadata,
                          provision?, update?, deprovision?, createTransport? }
        │
RemoteFetchWorkerDriverRegistry ── cloudflare (managed)
                                   ── (future) vercel (managed), self-hosted (manual)
```

- `managed: true` — 9Drive **provisions and manages** the remote deployment
  through the provider API (Cloudflare today). The generic Worker service
  branches on this flag, never on `driver === 'cloudflare'`.
- `validateConfig` — validates driver registration fields (for Cloudflare:
  Account ID, API Token, Worker Name), verifies credentials against the
  provider, and returns the safe `configEncryptedInput` blob to store.
- `provision` — managed drivers: deploy the bundled relay, configure the
  generated secret binding, discover the workers.dev endpoint.
- `update` — managed drivers: diff the new config (rename → deploy new script +
  verify + remove old; account change → re-provision; token-only → no redeploy).
- `deprovision` — managed drivers: remove the remote deployment. Idempotent
  (404 = already gone).
- `testConnection` — `GET {endpoint}/health` with a backend-only HMAC signature
  (`X-9Drive-Signature`), validating the relay identity `{ service:
  "9drive-relay" }` and `protocolVersion` (`9drive-relay-v1`).
- `createTransport` — reserved; **not implemented this phase**.

Adding a future provider = implement the driver, register it, and ship its
form field metadata (the `managed` flag and per-driver registration `fields`).
No `if (driver === 'cloudflare')` spreads exist in controllers, services or
the UI. A manual driver (e.g. a future self-hosted relay) keeps the legacy
register-an-endpoint flow with `managed: false`.

## Registering a Cloudflare Worker relay (managed provisioning)

For Cloudflare the user provides only:

```
Service     [ Cloudflare Worker ▼ ]
Account ID  [ your-cloudflare-account-id ]
API Token   [ ••••••••••••••••••• ]
Worker Name [ 9drive-relay ]
```

No Endpoint URL, Region, Authentication selector, Shared Secret, or Description
— 9Drive handles all of it. The API token needs the **Workers Scripts** permission
("Edit" / "Workers Scripts") on the account — a token that verifies but lacks
Worker permissions fails the upload step with `WORKER_CREDENTIAL_INVALID`. A
global API key is not required. On **Add Worker**, the backend:

```
validate Account ID / API Token / Worker Name
  → verify the API token against Cloudflare (GET /user/tokens/verify)
  → generate a relay secret (crypto-random)
  → encrypt the API token + relay secret at rest
  → persist the worker as status = provisioning
  → CloudflareWorkerDriver.provision():
        build relay artifact (static worker.mjs from disk, preflight-parsed
          locally; any build failure → WORKER_RELAY_BUILD_FAILED, no API call)
        PUT /accounts/{id}/workers/scripts/{name}   (multipart FormData upload:
            worker.mjs part = static relay source
                              (Content-Type: application/javascript+module)
            metadata part   = main_module + compatibility_date +
                              RELAY_SECRET secret_text binding carrying the
                              relay secret)
        GET .../scripts/{name}/subdomain            (discover workers.dev endpoint)
  → driver.testConnection() against the discovered endpoint
  → persist status = healthy + endpointUrl + capabilities
```

The module upload and the secret binding happen in ONE multipart PUT — the
metadata part carries the `RELAY_SECRET` secret_text binding, so the relay
secret is never a separate request and never appears inside the Worker source
(source is a deterministic static asset). Two details matter to Cloudflare's
parser:
- the uploaded module part must be NAMED exactly like the entry module and
  `metadata.main_module` must reference exactly that name (`worker.mjs` on
  both — part name, filename, and main_module all match), and
- the module part's `Content-Type` must be `application/javascript+module`
  (per the Workers Scripts multipart API contract; an unresolvable
  main_module or wrong part content type is what trips parser error 10021).
The multipart body is built with native `FormData`/`Blob` — the runtime
generates the boundary and per-part framing; 9Drive never hand-assembles the
multipart string. The `compatibility_date` is a fixed app-controlled constant
(RELAY_COMPATIBILITY_DATE, tied to protocol 9drive-relay-v1), never derived
from the current date.

A duplicate-named script surfaces as `WORKER_PROVISION_CONFLICT` (HTTP 409 or
CF error code 10053) with a rename hint — 9Drive never silently overwrites a
possibly-foreign script.

Provisioning failures surface the failing step + the safe Cloudflare numeric
error code (e.g. `(step: upload) (Cloudflare error 10021)`). Known codes:
10021 script content/format error, 10053/10058/11005 script already exists,
10022 validation failed, 10051 invalid name, 10061 not a valid module.

A **provisioning failure** persists `status = provision_failed` + a safe
`lastErrorCode`, triggers best-effort `deprovision()` cleanup of any partially
deployed script, and surfaces a clear error identifying the failing step
(`token_verify`, `upload`, `subdomain`) plus the safe Cloudflare numeric error
code (e.g. `(step: upload) (Cloudflare error 10021)`). The row remains for
retry/delete — no fake endpoint is ever invented.

Common failures and what they mean:

| Symptom | Cause | Fix |
|---|---|---|
| `WORKER_CREDENTIAL_INVALID` | Token invalid or lacks Workers Scripts permission | Create a token with **Workers Scripts: Edit** + **Account Settings: Read** permissions |
| `WORKER_PROVISION_CONFLICT` (or CF 10053) | A script with that name already exists | Choose a different Worker Name |
| `step: subdomain — no workers.dev subdomain` | The account has never enabled workers.dev | Enable the free Workers.dev subdomain in the Cloudflare dashboard |
| `step: upload` + a CF code | The upload itself was rejected | Check the Cloudflare error code for the specific reason |

The UI shows the flow: **Deploying Cloudflare Worker… → Testing relay… →
Worker ready**. The deployed relay is **network-only** (README: `GET /health`,
`POST /fetch`) — no HLS, FFmpeg, remux, or upload logic ever ships into the
Worker.

### Editing a managed worker

- **API Token** — shown as "Credential configured"; **blank = keep the stored
  token**, a new value replaces it. Never returned by the API.
- **Account ID / Worker Name** — prefilled from the safe `providerConfig`.
- Worker Name change → the driver deploys the new script, verifies it, then
  removes the old one. Account change → re-provision under the new account.

### Deleting a managed worker

`driver.deprovision()` removes the remote script FIRST; if that fails, the
delete is blocked with `WORKER_DEPROVISION_FAILED` (retry) — 9Drive never
pretends the remote resource was removed. Success → existing soft delete;
historical Remote Imports keep their `workerId` + `workerNameSnapshot`.

## Multi-worker behavior

- 0 or 1 **default** enabled worker (`isDefault` uniques enforced
  transactionally; setting B default unsets A).
- A disabled worker cannot be default; disabling/deleting the default clears
  it (default becomes `null` — no automatic replacement).
- Status is **manual** (Test Connection) in this phase; the model supports
  periodic checks later.

## Remote Import selection

The create modal adds **Network Route**:

```
[ Direct / No Worker ▼ ]
9drive-relay — Healthy
relay-b — Healthy
```

- Only **enabled and ready** workers are selectable (provisioning /
  provision_failed workers have no usable endpoint); the enabled default
  worker is preselected when it exists, otherwise Direct; the user can always
  override.
- `unhealthy` is selectable with a warning; `unknown` shows "Not tested".
- Selected `workerId` is **persisted on the Remote Import before enqueueing**,
  survives retries, and is displayed in the import card ("Network route: …").
- The backend re-validates `workerId` at create (`REMOTE_IMPORT_WORKER_INVALID` /
  `_DISABLED` / `_DRIVER_UNSUPPORTED`) and at **retry**: an import whose worker
  was deleted/disabled/unsupported fails clearly
  (`REMOTE_IMPORT_WORKER_UNAVAILABLE`) — **never** a silent fallback to Direct.

## This phase: no relay transport yet

`RemoteFetchWorkerDriver.createTransport` is intentionally unimplemented. An
import created with a worker will fail its job explicitly with
`WORKER_TRANSPORT_NOT_IMPLEMENTED` — the source is never fetched via Direct
silently. The transport seam (`RemoteFetchTransport`) is ready for the next
phase: wire the Cloudflare relay, and execution resolves
`workerId → registry → driver → transport` with no changes to the Worker
table, the CRUD API, the Workers menu, or Remote Import business logic.

## Credential security

- Secrets are AES-256-GCM encrypted at rest (`TOKEN_ENCRYPTION_KEY`).
- `GET/POST/PATCH /workers` never return `secretEncrypted`/`configEncrypted`
  or decrypted values. The API returns `credentialConfigured` plus the **safe**
  `providerConfig` (accountId / workerName) for the edit form — the API token
  (and the relay secret) never leave the encrypted blobs.
- Edit forms: blank token/secret field = keep existing; a new value replaces it.
- The Cloudflare API token and the generated relay secret are **never logged**
  and never included in audit metadata — only booleans like `credentialUpdated`.
- Cloudflare API **error bodies are redacted** before surfacing (they can echo
  request details); callers see only the safe `WORKER_*` code + message.
- Health HMAC signing happens **only in the backend**; the frontend never sees
  the relay secret.
- Audit log records worker create/update/enable/disable/set-default/test/
  delete plus provisioning lifecycle actions (`worker.provisioned`,
  `worker.provision_failed`, `worker.deprovisioned`) — never secret values.

## API

All routes `requireAuth` (9Drive has no role system — any authenticated user
manages Workers, matching the SMB dashboard "admin-equivalent" pattern):

```
GET    /workers/drivers          safe driver metadata for the Service selector
GET    /workers                  list (non-deleted)
POST   /workers                  create (201)
GET    /workers/:id              detail
PATCH  /workers/:id              update (blank secret = keep)
DELETE /workers/:id              soft delete (204)
POST   /workers/:id/test         test connection (backend → endpoint)
POST   /workers/:id/enable
POST   /workers/:id/disable      clears default
POST   /workers/:id/set-default  unsets previous default atomically
```

Test-connection failures map to safe codes only:
`WORKER_CONNECTION_TIMEOUT`, `WORKER_CONNECTION_REFUSED`, `WORKER_TLS_ERROR`,
`WORKER_AUTH_FAILED`, `WORKER_PROTOCOL_INVALID`, `WORKER_PROTOCOL_UNSUPPORTED`,
`WORKER_UNHEALTHY` — raw error bodies never reach the UI. Provisioning failures
map to `WORKER_CREDENTIAL_INVALID`, `WORKER_PROVISION_FAILED`,
`WORKER_PROVISION_CONFLICT` (a script with that name already exists — rename),
`WORKER_DEPROVISION_FAILED`.

## Relay integration test (no Playwright)

A development-only end-to-end harness provisions a REAL temporary 9Drive relay
Worker through the production Cloudflare driver, then exercises the REAL stack
against it: `CloudflareRemoteFetchTransport` (serializer + HMAC) → deployed
`worker.mjs` → the test URL, plus the Remote Import application probe path
(`probeRemoteUrl(workerId)` → resolver → transport) and HLS master/variant/
segment fetches through the same Worker. It also fails the run if any
`route=direct` request appears while a Worker is selected.

Credentials are read from the environment ONLY (never committed, never printed):

- `TEST_CLOUDFLARE_ACCOUNT_ID` (required)
- `TEST_CLOUDFLARE_API_TOKEN` (required; never printed, never in any file)
- `TEST_CLOUDFLARE_WORKER_NAME` (optional; a unique `9drive-relay-test-*` name
  is generated when absent — the harness deletes exactly that Worker on exit)
- `TEST_REMOTE_IMPORT_URL` (optional; defaults to the JWPlatform HLS sample)

Run inside the backend container (the image bakes `src`/`scripts`, so rebuild
first: `docker compose build backend`):

```bash
docker compose exec -T \
  -e TEST_CLOUDFLARE_ACCOUNT_ID="<account-id>" \
  -e TEST_CLOUDFLARE_API_TOKEN="<api-token>" \
  -e TEST_REMOTE_IMPORT_URL="http://content.jwplatform.com/manifests/vM7nH0Kl.m3u8" \
  backend npm run test:cloudflare-relay
```

Host fallback (backend deps installed): `cd backend && TEST_CLOUDFLARE_ACCOUNT_ID=... TEST_CLOUDFLARE_API_TOKEN=... npx tsx scripts/test-cloudflare-relay.ts`.

Expected output (all PASS):

```
Cloudflare Relay Integration Test
validate credentials ........ PASS
provision worker ............ PASS
health check ................ PASS
relay HEAD .................. PASS
relay GET ................... PASS
relay Range GET ............. PASS
Remote Import probe ......... PASS
HLS master .................. PASS
HLS variant ................. PASS
direct-route leak ........... PASS
cleanup ..................... PASS
```

A relay `400` carries the worker's safe reason code
(e.g. `reason=INVALID_PROTOCOL`) plus a redeploy hint — see
`transports/cloudflare-transport.ts`. The serializer → worker parser contract
is guarded by `drivers/cloudflare-relay/worker-contract.test.ts` (executes the
actual `worker.mjs` artifact with the actual serializer).

## Environment

- `WORKER_TEST_TIMEOUT_SECONDS` (default 10) — health-check timeout.
- `WORKER_ALLOW_LOCALHOST_HTTP` (default false) — allow `http://localhost`
  endpoints for local relay stubs in development only.
- `CLOUDFLARE_API_BASE` (default `https://api.cloudflare.com/client/v4`) —
  Cloudflare Workers API base; tests point it at a local fake.
- `CLOUDFLARE_DEPLOY_TIMEOUT_SECONDS` (default 30) — per-call timeout during
  Cloudflare provision/deprovision.