# Claude Code Prompt — Add Multi-Provider Worker Registry for 9Drive

You are working inside the existing 9Drive project.

The next feature is **Worker Management** for Remote Import networking.

Important architectural goal:

- Workers are **network bridges / relay transports only**.
- FFmpeg, HLS parsing, segment orchestration, remuxing, temp files, retry logic,
  progress tracking, and final Google Drive/S3 upload remain inside 9Drive.
- The first supported worker service is **Cloudflare Worker**.
- The database and application architecture MUST remain flexible so additional
  worker services can be added later without redesigning the database.
- 9Drive must support **multiple registered workers**.
- A Remote Import can choose which registered worker to use.
- Direct/no-worker mode must remain possible.

Do not implement the full Cloudflare relay protocol yet unless a minimal health
contract is required for Worker registration/testing.

This phase focuses on:

1. Worker registry/domain model.
2. Worker CRUD/admin menu.
3. Multi-provider driver architecture.
4. Worker health/test connection.
5. Remote Import worker selection.
6. Persistence of selected worker on Remote Import.
7. Clean abstractions for later Cloudflare relay execution.

Do not hard-code the database schema specifically around Cloudflare.

---

# 1. Mandatory initial inspection

Before changing code, inspect:

- `AGENTS.md`
- `README.md`
- backend `package.json`
- frontend `package.json`
- Docker Compose
- Prisma schema
- current admin/settings navigation
- current reusable CRUD/table/form patterns
- existing encryption utilities
- existing secret/token storage patterns
- current Remote Import schema/model
- Remote Import create modal
- Remote Import queue/job payload
- Remote Import worker/backend service
- permissions/RBAC
- audit/activity logging if present
- API validation conventions
- frontend query/mutation conventions
- existing health-check/service-status UI patterns
- existing tests

Search for:

```text
RemoteImport
remote-import
storage account
provider
driver
adapter
registry
settings
admin
encrypt
decrypt
secret
credential
health
status
enabled
default
capabilities
```

Before implementation, provide a concise plan with:

- files/modules to change
- migration/model changes
- API changes
- frontend pages/components
- Remote Import changes
- tests

Then continue unless there is a real blocker.

---

# 2. Terminology

Use a generic domain term such as:

```text
Remote Fetch Worker
```

or:

```text
Worker
```

The UI menu should be:

```text
Workers
```

Do NOT call the menu:

```text
Cloudflare Workers
```

because Cloudflare is only the first driver.

A Worker means:

```text
A remote network relay used by 9Drive to fetch remote resources.
```

It does NOT mean the internal BullMQ job worker.

Avoid ambiguous code naming where possible.

For backend classes/types, prefer names such as:

```text
RemoteFetchWorker
RemoteFetchWorkerDriver
RemoteFetchWorkerRegistry
RemoteFetchTransport
```

rather than generic `Worker` when it could conflict with queue workers.

---

# 3. Database design must be provider-agnostic

Create a provider-agnostic table/model.

Conceptually:

```text
RemoteFetchWorker
```

Recommended fields:

```text
id
name
slug
driver
endpointUrl
isEnabled
isDefault
priority
region
description

authType
secretEncrypted
configEncrypted

capabilitiesJson
metadataJson

status
lastHealthCheckAt
lastHealthyAt
lastFailedAt
lastErrorCode

createdAt
updatedAt
```

Adapt to existing schema conventions.

Do not create Cloudflare-specific columns such as:

```text
cloudflareAccountId
cloudflareZoneId
cloudflareWorkerName
cloudflareApiToken
```

unless they are genuinely required for the relay protocol itself.

The Worker registry should only care about the deployed relay endpoint and its
driver configuration.

---

# 4. Do not use a rigid DB enum for driver if it blocks future services

The database must be flexible.

Preferred:

```text
driver: string
```

Examples:

```text
cloudflare
generic-http-relay
vercel
future-provider
```

Application code should validate the driver against the installed/supported
driver registry.

This avoids requiring a database migration every time a new worker provider is
introduced.

If project conventions strongly require enums, explain the tradeoff before
choosing one. Prefer extensibility.

---

# 5. Versioned provider config

Provider-specific settings should live in a versioned config object rather than
new DB columns per provider.

Conceptually:

```json
{
  "version": 1,
  "protocol": "9drive-relay-v1"
}
```

Store sensitive provider config encrypted.

Use:

```text
configEncrypted
```

for secrets/private provider settings.

Use:

```text
metadataJson
```

only for safe non-sensitive display metadata.

Do not expose encrypted/decrypted secrets through normal APIs.

---

# 6. Authentication model

Prepare the model for multiple authentication modes.

Conceptually:

```text
authType:
- hmac
- bearer
- none
```

For the first Cloudflare relay implementation, prefer:

```text
hmac
```

but do not hard-code the whole Worker model to HMAC.

Sensitive values such as:

```text
shared secret
bearer token
private credential
```

must be encrypted at rest.

Never return the original secret after creation/update.

UI may only show:

```text
Credential configured
```

or:

```text
Secret ••••••••
```

---

# 7. Driver registry architecture

Create a driver registry.

Conceptually:

```ts
interface RemoteFetchWorkerDriver {
  key: string
  displayName: string

  validateConfig(...)
  testConnection(...)
  getCapabilities(...)

  // Reserved for next phase:
  createTransport?(...)
}
```

Driver registry:

```text
RemoteFetchWorkerDriverRegistry
├── cloudflare
└── future drivers
```

Do not scatter:

```ts
if (worker.driver === 'cloudflare')
```

through controllers/services/UI.

Provider-specific behavior should live behind the driver.

---

# 8. First driver: Cloudflare

Implement the first registered driver:

```text
driver = cloudflare
displayName = Cloudflare Worker
```

For this phase it needs enough functionality to:

- validate endpoint URL
- validate Cloudflare relay configuration
- test connection
- report capabilities if available

Do not put remux logic inside this driver.

Do not make Cloudflare responsible for HLS orchestration.

Cloudflare remains a network relay only.

---

# 9. Future driver compatibility

The architecture should allow adding later:

```text
Vercel Edge/Function relay
Fly.io relay
generic HTTP relay
self-hosted relay
another edge provider
```

without changing:

```text
Remote Import business logic
Remote Import database relationship
Worker CRUD API shape
Workers menu structure
```

Adding another provider should mostly mean:

```text
implement driver
register driver
add provider-specific form schema/UI
```

not redesigning the Worker table.

---

# 10. Worker capabilities

Prepare a generic capability structure.

Conceptually:

```json
{
  "streaming": true,
  "rangeRequests": true,
  "requestContext": true,
  "hls": true,
  "maxBodyBytes": null,
  "protocolVersion": "1"
}
```

Do not assume all future workers have identical capabilities.

Store last-known capabilities as non-sensitive JSON if useful.

Runtime code should eventually be able to reject selecting a Worker that lacks
a required capability.

For this phase, at minimum display capabilities returned by health/test
connection when available.

---

# 11. Worker status

Use clear status semantics.

For example:

```text
unknown
healthy
unhealthy
disabled
```

Do not persist highly transient state unnecessarily if existing architecture
has a better health-state mechanism.

Useful fields:

```text
lastHealthCheckAt
lastHealthyAt
lastFailedAt
lastErrorCode
```

Do not store raw sensitive upstream error bodies.

---

# 12. Workers menu

Add a new menu:

```text
Workers
```

Place it in the appropriate admin/settings/infrastructure section based on the
existing navigation design.

The page should show a responsive table or list with:

```text
Name
Service
Endpoint
Region
Status
Enabled
Default
Last Check
Actions
```

Actions:

```text
Add Worker
Edit
Test Connection
Enable / Disable
Set as Default
Delete
```

Follow the existing starter-kit design system.

Do not create a completely new visual language.

---

# 13. Add Worker flow

Clicking:

```text
Add Worker
```

opens the existing project-standard modal/page/drawer pattern.

Fields:

```text
Name
Service
Endpoint URL
Region
Description
Enabled
Set as default
```

Then show driver-specific configuration.

For Cloudflare:

```text
Authentication
Shared Secret
```

Use the actual protocol/config required by the implementation.

Do not expose irrelevant Cloudflare account-management fields if 9Drive only
needs the deployed relay endpoint.

---

# 14. Service selector

The form should use:

```text
Service
[ Cloudflare Worker ]
```

The options must come from the backend-supported driver registry or a shared
safe driver-definition source.

Do not hard-code assumptions that only Cloudflare will ever exist.

Later it should be possible to add:

```text
Generic HTTP Relay
Vercel
Self Hosted
```

without redesigning the form.

---

# 15. Dynamic driver configuration

Provider-specific form configuration should be isolated.

Conceptually:

```text
WorkerForm
  └── DriverConfigFields
       ├── CloudflareWorkerFields
       └── future drivers
```

Do not put every future provider's fields into one massive component.

The common Worker fields remain shared.

---

# 16. Endpoint validation

Worker endpoint must:

- be valid HTTP/HTTPS
- preferably require HTTPS outside local development
- reject embedded credentials in URL
- reject CR/LF
- normalize trailing slash consistently
- not contain secrets in query strings if avoidable

Do not allow:

```text
javascript:
file:
ftp:
```

If localhost HTTP is needed for development/testing, gate it by environment.

---

# 17. Test Connection

Add:

```text
Test Connection
```

from both:

- Add/Edit form
- Workers list action

The browser should NOT directly call the Worker endpoint.

Flow:

```text
Browser
→ 9Drive backend
→ driver.testConnection()
→ registered Worker endpoint
```

This ensures credentials remain server-side.

For Cloudflare, use a simple relay health/protocol endpoint, conceptually:

```text
GET /health
```

or:

```text
GET /v1/health
```

depending on the relay contract.

The response may report:

```json
{
  "status": "ok",
  "service": "9drive-relay",
  "protocolVersion": "1",
  "capabilities": {
    "streaming": true,
    "rangeRequests": true,
    "requestContext": true
  }
}
```

Do not require the Worker to fetch a third-party URL just to test registration.

---

# 18. Health authentication

If the relay health endpoint should be authenticated, use the driver's auth
strategy.

Do not expose:

```text
shared secret
HMAC details
bearer token
```

to frontend JavaScript.

All signing happens in the 9Drive backend.

---

# 19. Worker CRUD API

Add clean admin APIs following project conventions.

Conceptually:

```text
GET    /workers
POST   /workers
GET    /workers/:id
PATCH  /workers/:id
DELETE /workers/:id

POST   /workers/:id/test
POST   /workers/:id/enable
POST   /workers/:id/disable
POST   /workers/:id/set-default
```

Adapt naming/routes to the repository style.

Avoid separate Cloudflare-specific CRUD endpoints.

---

# 20. Safe API responses

Never return:

```text
secretEncrypted
decrypted secret
configEncrypted
raw credentials
```

Return:

```json
{
  "credentialConfigured": true
}
```

For edit:

- leaving secret blank means keep existing secret
- explicit replace-secret action/value updates it
- do not prefill old secret

Use project form conventions.

---

# 21. Default Worker rules

Support one optional default Worker.

Rules:

```text
0 or 1 enabled default Worker
```

When setting one Worker as default:

```text
unset previous default
set selected default
```

Perform atomically/transactionally.

A disabled Worker should not remain default.

If default Worker is disabled/deleted:

```text
default becomes null
```

Do not automatically pick another unless product behavior explicitly requires
it.

---

# 22. Delete behavior

Do not blindly delete a Worker referenced by historical Remote Imports.

Preferred approach:

```text
soft delete
```

or:

```text
prevent hard delete when referenced
```

depending on project conventions.

Historical Remote Import records must retain understandable Worker information.

If using hard delete, use a nullable foreign key with safe historical snapshot
fields, but prefer existing project patterns.

Do not cascade-delete Remote Imports.

---

# 23. Remote Import relationship

Extend Remote Import with a nullable Worker relationship.

Conceptually:

```text
RemoteImport.workerId nullable
```

Semantics:

```text
null
→ Direct / no relay

workerId
→ use that registered Remote Fetch Worker
```

Do not overload storage-account fields.

Network Worker and destination Storage Account are separate concepts.

---

# 24. Preserve historical selection

A Remote Import should remember which Worker was selected.

Display it in Remote Import details/history:

```text
Network Route
Cloudflare SG #1
```

or:

```text
Direct
```

If the Worker is later renamed, decide whether history should display the
current name or a snapshot.

Preferred pragmatic approach:

- keep `workerId`
- optionally store a safe `workerNameSnapshot`
- never snapshot secrets

Follow current audit/history patterns.

---

# 25. Remote Import modal selection

Update the existing Remote Import create modal.

Add a field:

```text
Network Route
```

Recommended UX:

```text
Network Route

[ Direct ]
[ Worker: Cloudflare SG #1 ]
[ Worker: Cloudflare US #1 ]
```

Or:

```text
Use Worker
[ Direct / No Worker ▼]
```

Only show enabled Workers.

Each option should safely show:

```text
name
service
region
health indicator
```

Example:

```text
Cloudflare SG #1
Cloudflare Worker · Singapore · Healthy
```

Do not expose endpoint secrets.

---

# 26. Default selection in Remote Import

If an enabled default Worker exists:

```text
preselect it
```

Otherwise:

```text
Direct
```

The user can override it per Remote Import.

Do not force the default Worker if the user explicitly selects Direct.

---

# 27. Worker health warning during selection

If a Worker is:

```text
unknown
unhealthy
```

allow behavior according to sensible product rules.

Recommended:

- `unhealthy`: selectable only with warning OR disable selection
- `disabled`: never selectable
- `unknown`: selectable with "Not tested" indicator

Prefer not to block experienced users purely because a cached health status is
stale.

However, do block disabled/deleted Workers.

---

# 28. Backend validation during Remote Import creation

Do not trust submitted `workerId`.

Backend must verify:

```text
Worker exists
Worker belongs to allowed scope/tenant
Worker is enabled
Worker driver is supported
```

If invalid:

```text
REMOTE_IMPORT_WORKER_INVALID
REMOTE_IMPORT_WORKER_DISABLED
REMOTE_IMPORT_WORKER_DRIVER_UNSUPPORTED
```

Use project naming conventions.

---

# 29. Queue/job persistence

The selected Worker must survive queueing and retries.

Do not rely only on the frontend payload.

Persist `workerId` on Remote Import before enqueueing.

When execution starts:

```text
load Remote Import
→ load selected Worker
→ resolve driver
→ build transport
```

For this phase, if the actual relay transport is not implemented yet, keep the
selection wired and ready but do not fake successful relay behavior.

---

# 30. Retry semantics

Retry should use the same selected Worker by default.

If the Worker has since been:

```text
disabled
deleted
unsupported
```

fail clearly:

```text
Selected Remote Import Worker is no longer available.
```

Do not silently switch to Direct.

Do not silently choose another Worker.

Later a UI action can support:

```text
Retry with another Worker
```

but that does not need to be implemented in this phase unless easy and aligned
with the existing retry UI.

---

# 31. Driver service abstraction for next phase

Prepare but do not over-engineer the transport API.

Conceptually:

```ts
interface RemoteFetchTransport {
  request(input: RemoteFetchRequest): Promise<RemoteFetchResponse>
}
```

Implementations eventually:

```text
DirectRemoteFetchTransport
CloudflareRemoteFetchTransport
FutureRemoteFetchTransport
```

Selection:

```text
RemoteImport.workerId == null
→ DirectRemoteFetchTransport

RemoteImport.workerId != null
→ Worker registry
→ driver
→ driver creates transport
```

Keep HLS/remux code unaware of Cloudflare specifics.

---

# 32. Never put FFmpeg/remux in Worker drivers

Explicitly preserve this architecture:

```text
Remote Source
      ↓
Remote Fetch Worker / relay
      ↓
9Drive SecureRemoteFetcher
      ↓
HLS parsing / download orchestration
      ↓
local temp files
      ↓
FFmpeg / ffprobe
      ↓
final output
      ↓
Google Drive / S3
```

The Worker driver is only responsible for remote byte transport.

---

# 33. Worker scope / ownership

Inspect whether 9Drive is:

```text
single-user
multi-user
multi-tenant
admin-managed
```

Apply the existing authorization model.

Recommended infrastructure behavior:

```text
Workers are admin-managed global infrastructure resources
```

unless the existing product requires per-user Workers.

Normal users should only see/select Workers they are allowed to use.

Do not let arbitrary users retrieve worker secrets.

---

# 34. Permissions

Add/use permissions equivalent to:

```text
workers.view
workers.create
workers.update
workers.delete
workers.test
```

Remote Import users may need:

```text
workers.use
```

Use the existing RBAC/permission system.

Do not create a parallel permission mechanism.

---

# 35. Audit/activity logging

If audit/activity logs exist, record important actions:

```text
Worker created
Worker updated
Worker enabled
Worker disabled
Worker set as default
Worker test succeeded/failed
Worker deleted
```

Never include secrets in activity properties.

For secret updates record only:

```text
credentialUpdated = true
```

---

# 36. Worker list filters

Useful filters:

```text
Service
Status
Enabled
Region
```

Do not overbuild this if current list sizes are small.

At minimum support search by:

```text
name
endpoint host
region
```

without exposing secret query data.

---

# 37. UI status badges

Use existing Badge/Status components.

Examples:

```text
Healthy
Unhealthy
Not Checked
Disabled
```

Avoid custom one-off styling.

Show:

```text
Last checked 2 minutes ago
```

using existing date formatting.

---

# 38. Worker detail/edit UX

Recommended sections:

```text
General
Connection
Authentication
Capabilities
Health
```

Keep forms compact.

Do not show raw encrypted JSON.

Driver-specific advanced configuration may be represented through typed fields.

---

# 39. Cloudflare-specific registration fields

For the first Cloudflare driver, start minimal.

Recommended:

```text
Name
Service = Cloudflare Worker
Endpoint URL
Region
Description

Authentication = HMAC
Shared Secret

Enabled
Default
```

Do NOT require:

```text
Cloudflare email
Cloudflare API token
Cloudflare Account ID
Zone ID
```

because 9Drive is registering an already-deployed relay, not managing the
Cloudflare account itself.

---

# 40. Worker protocol version

Prepare for relay protocol evolution.

Cloudflare health response should ideally expose:

```text
protocolVersion
```

Store/display the last detected version.

Driver can define supported protocol versions.

Example:

```text
9drive-relay-v1
```

If unsupported:

```text
Worker is reachable but uses an unsupported relay protocol.
```

Do not tie DB migrations to every protocol version.

---

# 41. Capability negotiation

On successful Test Connection:

```text
validate service identity
validate protocol version
read capabilities
persist safe last-known capabilities
update health status
```

Do not blindly mark any HTTP 200 endpoint as a valid 9Drive Worker.

The Cloudflare driver should verify something equivalent to:

```json
{
  "service": "9drive-relay"
}
```

and supported protocol information.

---

# 42. Health-check error handling

Map failures to safe codes:

```text
WORKER_CONNECTION_TIMEOUT
WORKER_CONNECTION_REFUSED
WORKER_TLS_ERROR
WORKER_AUTH_FAILED
WORKER_PROTOCOL_INVALID
WORKER_PROTOCOL_UNSUPPORTED
WORKER_UNHEALTHY
```

Do not expose internal stack traces or credentials.

Store only safe last error code/message.

---

# 43. Do not build automatic periodic monitoring yet unless already natural

This phase needs:

```text
manual Test Connection
```

and status persistence.

Do not introduce a new scheduled health-monitoring subsystem unless the
repository already has an appropriate scheduler pattern and it is trivial.

Design the model so periodic checks can be added later.

---

# 44. API driver metadata

Expose safe supported-driver metadata to frontend.

Conceptually:

```text
GET /workers/drivers
```

Response:

```json
[
  {
    "key": "cloudflare",
    "name": "Cloudflare Worker",
    "authTypes": ["hmac"],
    "fields": [...]
  }
]
```

Do not expose secrets/default secret values.

This can drive the Service selector and make future drivers easier to add.

If a typed frontend registry is cleaner within the existing monorepo, use that
instead while keeping backend authoritative.

---

# 45. Migration strategy

Create a clean Prisma migration.

Potential relationship:

```text
RemoteFetchWorker
       ↑
       |
RemoteImport.workerId?
```

Add indexes for common admin/use queries:

```text
driver
isEnabled
isDefault
status
```

Do not add unnecessary unique constraints.

`slug` may be unique if useful.

Endpoint URL does not necessarily need to be globally unique because future
configurations may intentionally point to the same relay with different
credentials/policies.

---

# 46. Secret handling tests

Add tests proving:

```text
create Worker with secret
→ DB stores encrypted form
→ API does not return secret

edit Worker without secret
→ existing secret preserved

edit Worker with new secret
→ secret replaced

list Workers
→ no secret

detail Worker
→ no secret

test connection
→ backend decrypts secret internally
→ frontend never receives it
```

---

# 47. Worker CRUD tests

Test:

```text
create Cloudflare Worker
list
detail
edit
enable
disable
set default
test connection
delete/soft-delete
```

Also test:

```text
only one default
disabled cannot remain default
unsupported driver rejected
invalid endpoint rejected
```

---

# 48. Remote Import integration tests

Test:

```text
create Remote Import with Direct
→ workerId null
```

Test:

```text
create Remote Import with Worker A
→ workerId A persisted
→ queue/retry can load A
```

Test:

```text
create Remote Import with Worker B
→ workerId B persisted
```

Test disabled Worker:

```text
submit disabled workerId
→ rejected
```

Test deleted/unavailable Worker on retry:

```text
clear safe error
→ no silent fallback
```

---

# 49. Multiple Worker test

Create:

```text
Cloudflare SG
Cloudflare US
Cloudflare EU
```

Verify all appear in the Remote Import selector.

Selecting each must persist the correct ID independently.

Do not accidentally use the default Worker after the user explicitly selects
another Worker.

---

# 50. Future-service testability

Add a test stub/fake driver in tests to prove the registry is not Cloudflare
hard-coded.

Example:

```text
driver = test-relay
```

Register it only in tests.

Verify:

```text
Worker CRUD/validation
driver lookup
test connection
Remote Import selection
```

can operate without Cloudflare-specific branching.

This is important for future Vercel/self-hosted support.

---

# 51. Frontend regression

Do not regress existing Remote Import behavior:

```text
URL/cURL input if already implemented
Request Context
filename detection
destination selection
storage account selection
HLS options
retry
progress
upload progress
canonical filename
```

Worker selection is an additional orthogonal field.

Do not mix:

```text
destination storage
```

with:

```text
network relay worker
```

---

# 52. Suggested Remote Import UI layout

Keep the existing layout.

Add near source/network options:

```text
Network Route
[ Direct / No Worker ▼]
```

Dropdown examples:

```text
Direct / No Worker

Cloudflare SG #1
Cloudflare Worker · Singapore · Healthy

Cloudflare US #1
Cloudflare Worker · US · Healthy
```

If default Worker exists:

```text
Default
```

badge may be shown.

Avoid large worker configuration inside the Remote Import modal.

Worker management belongs in the Workers menu.

---

# 53. Worker menu empty state

When none are registered:

```text
No workers registered yet.
Add a worker to route Remote Import traffic through an external relay.
```

CTA:

```text
Add Worker
```

Do not imply a Worker is required; Direct remains valid.

---

# 54. Documentation

Update project docs.

Add documentation for:

```text
Workers overview
Worker vs internal queue worker terminology
Cloudflare Worker registration
multi-worker behavior
default Worker
Remote Import selection
credential security
driver architecture
future service extension
```

Clearly state:

```text
The remote Worker is only a network relay.
FFmpeg/remux still runs on 9Drive.
```

Do not document relay deployment details that are not implemented yet.

---

# 55. Required verification commands

Determine exact commands and run all applicable:

```text
Prisma format
Prisma validate
Prisma generate
Prisma migration
backend lint
backend typecheck
backend tests
frontend lint
frontend typecheck
frontend tests
frontend build
Docker Compose validation
```

Do not claim a command passed unless it actually ran.

Fix failures introduced by this implementation.

Clearly separate unrelated pre-existing failures.

---

# 56. Acceptance criteria

Do not consider this phase complete until:

- a new generic `Workers` menu exists
- multiple Workers can be registered
- Cloudflare is the first supported service/driver
- database is not Cloudflare-specific
- driver is extensible without redesigning the Worker table
- secrets/config are encrypted appropriately
- secrets never appear in normal API responses
- Worker can be enabled/disabled
- exactly zero or one default Worker is supported
- Test Connection works through backend
- service identity/protocol is validated
- health status is visible
- Remote Import can choose Direct or a specific Worker
- selected `workerId` is persisted
- default Worker is preselected when applicable
- explicit user selection overrides default
- disabled Workers cannot be newly selected
- retry preserves selected Worker
- unavailable Worker never silently falls back to Direct
- Worker and Storage Account remain separate concepts
- Cloudflare-specific code is behind a driver abstraction
- a test/fake driver proves future-provider extensibility
- documentation is updated
- all relevant tests/builds pass

---

# 57. Final report

At completion provide:

## Architecture

Explain:

```text
RemoteFetchWorker
RemoteFetchWorkerDriver
RemoteFetchWorkerDriverRegistry
RemoteFetchTransport
```

and their responsibilities.

## Database

Show the final generic Worker model and Remote Import relationship.

Explain why adding another provider does not require redesigning the schema.

## Cloudflare driver

Explain which Cloudflare-specific logic exists in the driver only.

## Workers menu

Describe:

```text
list
create
edit
test
enable/disable
default
delete
```

## Remote Import

Show how:

```text
Direct
Worker A
Worker B
```

selection is persisted and loaded.

## Security

Explain:

```text
secret encryption
API redaction
backend-only health authentication
permission checks
audit logs
```

## Tests

List exact test commands/results.

## Next-phase readiness

Explain how the next implementation can add actual Cloudflare relay transport
without changing:

```text
Worker registry
Remote Import relationship
Workers menu
```

Do not implement unrelated features.
