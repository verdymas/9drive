# 9Drive — Add "Virtual Private Server" Remote Fetch Worker Provider

## Role and goal

You are the implementation agent working **inside the existing 9Drive repository**. Implement a new Remote Fetch Worker provider with the **exact UI label `Virtual Private Server`**. It must be a self-hosted, authenticated HTTP relay that can run on a **1 vCPU / 1 GB RAM VPS** and be deployed using a hosting panel's **Upload ZIP → Dockerfile** workflow.

The VPS relay is an additional selectable transport alongside existing Direct, Cloudflare Worker, and Deno Deploy paths. **It is not a fallback.** In particular, a job assigned to the VPS relay must not switch to Direct or a different provider after an error.

Deliver both:
1. A minimally invasive, integrated 9Drive backend/frontend/database implementation for the `Virtual Private Server` provider.
2. A **standalone, deployment-ready ZIP** containing the actual VPS relay application, Dockerfile, safe example environment configuration, and operator README. Do not merely write instructions for a ZIP or expect the operator to clone the full 9Drive repository on the VPS.

## Context and hard constraints

- Existing relay transport protocol: `9drive-relay-v1`; inspect its actual request, response, HMAC signing, streaming, error, and metadata contracts in the repository. **Do not invent a second protocol.**
- Existing implementations are expected around:
  - `backend/src/modules/remote-fetch-workers/transports/cloudflare-transport.ts`
  - `backend/src/modules/remote-fetch-workers/drivers/cloudflare-relay/worker.mjs`
  - `backend/src/modules/remote-fetch-workers/drivers/deno-relay/worker.ts`
  - Remote Import routing/worker configuration, admin UI, and focused tests.
  These paths are hints, not an excuse to assume the code is unchanged; locate the actual implementation.
- VPS: **1 vCPU, 1 GB RAM**, hosting panel supports Dockerfile builds and source ZIP uploads, HTTPS/domain routing, and environment variables. The app must listen on `0.0.0.0` and the configured `PORT` (default `3000`). HTTPS can terminate at the hosting panel's reverse proxy; don't bake TLS certificates into the ZIP.
- User chooses the Worker provider manually. **No Direct fallback, no cross-provider automatic fallback.**
- Previous diagnostics: source host `c9.trafficdeposit.com` returned upstream HTTP `404` from Deno and Colab; testing an independent streaming test URL returned HTTP `206` through Deno. An alternative VPS IP **might** behave differently but **is not guaranteed** to resolve the upstream 404. Keep exact error provenance visible.
- Scope: the Remote Fetch Worker provider + standalone VPS relay + necessary settings, tests, and docs. Do **not** refactor unrelated Remote Import, storage providers, queues, or UI screens.

## Stage 0 — Repository reconnaissance (before editing)

1. Read `AGENTS.md` and the project's relevant documentation and testing conventions.
2. Trace the current `9drive-relay-v1` wire contract end-to-end, including outer relay HTTP status vs inner upstream status, HMAC canonicalization, header allowlists, body streaming, Range/206, redirects, URL validation, cancellation, and error classification.
3. Find how provider drivers are registered, persisted, validated, selected, displayed, tested, and used in probes, downloads, ranges, and retries. Identify the existing per-worker usage/budget accounting tables, if present.
4. Summarize the minimum files/schema changes needed before implementing. Preserve backward compatibility for existing Cloudflare/Deno worker configurations.

## Stage 1 — Provider integration in 9Drive

- Add a new provider with **UI display name exactly `Virtual Private Server`**. Use a stable machine identifier consistent with existing conventions (e.g. `vps` / `virtual_private_server` only if compatible with current registries and schema).
- Reuse shared relay transport, `9drive-relay-v1`, and existing HMAC configuration rather than cloning cloud-provider-specific implementation. If a shared HTTP relay adapter can be reused safely, prefer that.
- UI/configuration must let an authorized user:
  - Choose `Virtual Private Server` among Remote Fetch Worker providers.
  - Set a descriptive worker name and HTTPS **Endpoint URL**.
  - Choose or confirm **Authentication: HMAC**; configure a secret through the existing encrypted secret storage path.
  - Perform a genuine authenticated health/protocol test and inspect an actionable result.
  - Enable/disable the worker using existing mechanisms and see sanitized diagnostics.
- Preserve endpoint exact path where relevant (do not strip a configured relay path or append a wrong one), and follow existing URL validation/secret redaction conventions.
- Keep migration changes small and backward compatible. Reuse existing per-worker request/egress usage tracking and budgets if implemented; do not add duplicate counter systems. If VPS limits are operator-defined, label them as **local safety budgets**, not provider-free-tier allowances.
- A job selected for this VPS worker must use **that exact worker** across initial probe, download, ranged GET, retries, and redirects. An upstream `404`, timeout, HMAC rejection, or VPS outage must remain a VPS-route failure. Never silently route through Direct or other providers.

## Stage 2 — Standalone VPS relay

Create a self-contained, deployable server application in a discoverable repository folder, ideally under `backend/src/modules/remote-fetch-workers/drivers/vps-relay/` if consistent with the repository. A lightweight Node.js server is preferred if it allows safe reuse of protocol implementation; a compiled Go binary is acceptable if it genuinely reduces runtime footprint without duplicating contract semantics. **Do not use browser automation, databases, Redis, or a heavy application framework for this relay.**

### Wire compatibility

- Implement the **actual** `9drive-relay-v1` protocol as it currently exists, including authenticating HMAC requests and maintaining binary response/metadata semantics exactly as expected by the backend.
- Reuse or extract protocol fixtures and shared logic when feasible. Do not silently alter HMAC signature base strings, header normalization, JSON serialization, timestamps, or payload formats.
- If existing HMAC has an identified weakness (e.g. replay protection), document it and apply a backwards-compatible, narrowly scoped remedy with tests; never make a breaking speculative security change.
- Return distinct diagnostic classifications for: ingress/routing errors, bad HMAC, malformed protocol, destination validation, upstream network failure, upstream HTTP status, and response-stream errors. Record **actual upstream status separately from relay HTTP status**.
- Support `GET`, `HEAD`, and only other upstream methods already required/allowed by the existing protocol. Do not expose unrestricted methods.

### Streaming and low-resource operation

- Stream bytes from upstream to client as they arrive; **never `arrayBuffer()` / buffer the full video/file**, write full files to `/tmp`, or base64-wrap large payloads.
- Propagate backpressure, abort the upstream request when the downstream disconnects, release streams/sockets, and handle graceful termination.
- Preserve Range, Content-Range, Content-Length when valid, Accept-Ranges, HTTP 206/416, Content-Type, and other safe response headers required by the protocol. Avoid implicit decompression/recompression or header mismatches.
- Correctly handle redirect chains consistent with existing SSRF policy. Distinguish the relay endpoint response code from the source's code; never rewrite upstream 404 into a misleading success.
- Configurable concurrency limit with a conservative default of **2 active transfers**; configurable request/connect/inactivity timeouts and maximum redirects. Avoid a short **total** timeout that would terminate legitimate long file streams.
- Keep steady-state memory conservative for 1 GB RAM. Avoid unbounded queues, body buffering, unlimited logs, or worker-thread pools. Handle overload explicitly with a stable, machine-readable response.
- Do not assume media content is small; support arbitrarily large files through bounded streaming, subject to configured transfer and network limits.

### Security

- **HMAC authentication is mandatory** for all relay operations that can access an upstream URL. Use the existing secret format and constant-time signature comparison where appropriate. No unauthenticated generic proxy endpoint.
- Enforce strict server-side SSRF defenses: only allowed protocols (HTTP/HTTPS), no URLs with embedded credentials, deny loopback/private/link-local/metadata IPs and internal hostnames, validate DNS results and every redirect destination, account for IPv4/IPv6 and DNS rebinding/resolution-connect differences. Follow the existing codebase's established defenses if stronger.
- Do not forward arbitrary inbound headers: only the existing approved upstream header allowlist. Never send HMAC auth headers or relay secrets to upstream.
- Limit the size of control JSON and inbound bodies. Never log signed URL query parameters, cookies, authorization values, request bodies, secrets, or full target URLs.
- Give each request a correlation ID and safe stage logs: `received`, `authenticated`, `validated`, `upstream-dispatched`, `upstream-responded`, `relay-responded` / `stream-error`. Include safe destination hostname, URL fingerprint, outer/inner statuses, request duration, transmitted bytes, and redacted error type as appropriate.
- Health readiness should not expose sensitive deployment details. A public basic `/healthz` may return minimal status, but any URL-fetching diagnostic must require authentication.
- Document TLS requirements: the public 9Drive endpoint must be HTTPS; internally the container may listen on HTTP behind the panel's HTTPS reverse proxy.

## Stage 3 — Upload ZIP + Dockerfile deployment

Generate a **real ZIP file** in the repository's documented build artifacts/output location. Name it **`9drive-vps-relay.zip`**. Its root must contain files ready for the hosting panel's **Upload → Dockerfile** workflow, rather than a nested checkout of the entire monorepo.

Minimum ZIP contents (adjust filenames to match the implementation):

```text
9drive-vps-relay.zip
├── Dockerfile
├── .dockerignore
├── package.json                  # only if needed
├── src/ or server.js             # self-contained relay implementation
├── .env.example                  # placeholders, NEVER actual secrets
└── README.md                     # exact hosting-panel deployment guide
```

Requirements:
- Dockerfile builds without requiring the 9Drive monorepo or private dependencies. Use a maintained, compact runtime base image. Prefer non-root runtime user and production-only dependencies.
- Build context must be the ZIP root. Prefer a direct source-based Dockerfile that the VPS panel can build with 1 GB RAM; if a local compilation step is necessary, prebuild or otherwise keep the VPS build lightweight and document architecture compatibility.
- Start a single server process bound to `0.0.0.0:${PORT:-3000}`; supply a usable `HEALTHCHECK` when appropriate.
- Do not include `.env`, production secrets, source signed URLs, test credentials, node_modules, massive assets, or needless artifacts in the ZIP.
- Provide `.env.example` with explicit variable names and safe descriptions, including `RELAY_SECRET` and `PORT`; use actual verified names from code, not placeholders pretending to work.
- README must cover **the pictured deployment workflow**:
  1. Choose **Provider: Upload**.
  2. Upload **`9drive-vps-relay.zip`**.
  3. Set **Build Type: Dockerfile**, not Static.
  4. Set build context/path to ZIP root as required by the hosting panel; note whether empty or `/` is accepted rather than guessing.
  5. Configure the application/container port (default `3000`) and attach a domain with HTTPS.
  6. Add `RELAY_SECRET` as a secure environment variable using a cryptographically random value; configure optional `PORT`, concurrency, and timeouts.
  7. Deploy and check logs/health without leaking secrets.
  8. In 9Drive, select **Virtual Private Server**, paste the correct HTTPS endpoint URL and **the same HMAC secret**, then test connection and a small streaming/Range transfer.
  9. Explain expected responses, how to read `relayHttpStatus` vs `upstreamStatus`, and safe rollback/secret rotation steps.
- Document default memory/concurrency limits, firewall exposure, reverse-proxy buffering/idle-timeout caveats, bandwidth/egress costs, and expected restart behavior. The VPS is **not inherently free**.
- Do not claim the relay can force `206` from destinations that return `404`; include a short diagnostic method comparing an identical current URL and effective headers across Direct and VPS without disclosing secrets.

## Stage 4 — Deterministic tests and validation

Implement focused tests rather than relying solely on a live media host:

1. Existing Cloudflare and Deno provider configurations and tests still work.
2. New provider selection, input validation, encryption/redaction, and persistence work.
3. 9Drive's existing relay HMAC fixture authenticates against the VPS relay; invalid/missing HMAC fails.
4. Signed probe, GET, HEAD (if allowed), Range GET with upstream 206, Content-Range, 416, and ordinary 404 preserve original statuses and payload semantics.
5. Upstream network exception is not confused with upstream HTTP 404; logs show correct error stage.
6. Redirects to disallowed/private/metadata targets are blocked (including IPv6 and DNS-rebinding-resistant cases).
7. Range downloads stream with bounded memory and correct backpressure; cancellation releases the upstream connection.
8. Two concurrent transfers work within default limits; additional requests are safely rejected/deferred without uncontrolled resource growth.
9. Probe, download, retry, and range requests stay on the selected VPS worker. No automatic Direct or other provider fallback.
10. Authentication secrets, cookies, query strings, and full signed URLs never appear in logs.
11. ZIP is genuinely produced; unpack it to a clean temporary folder, verify its Dockerfile build context, build the image, start the container, and exercise `/healthz` plus an authenticated relay request against a local mocked upstream (if Docker is unavailable, report this limitation and still perform static package checks).
12. Run project-relevant lint/typecheck/test commands and report exact results.

## Deliverables and completion report

When finished, provide:

- The newly supported provider name **Virtual Private Server** and its exact configuration fields.
- Repo paths changed, schema changes/migrations, and backward-compatibility notes.
- Location of the generated `9drive-vps-relay.zip` and confirmation that the archive actually exists.
- Copy-ready instructions for uploading that ZIP in the user's panel using **Dockerfile** mode and connecting the resulting HTTPS endpoint to 9Drive via HMAC.
- Focused test results and any tests not run with reasons.
- Safe example log lines demonstrating the distinction between relay errors and upstream 404 responses.
- An explicit statement that **Direct fallback and cross-provider fallback are not implemented**.
- Any remaining uncertainty or observed limitation for 1 vCPU / 1 GB RAM.

**Do not declare success merely because the health endpoint returns 200. A real authenticated request must work, and a mocked upstream 206 must preserve streaming and Range semantics end to end.**
