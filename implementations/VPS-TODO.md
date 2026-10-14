# VPS Relay — Implementation Progress

## Status: DONE (all stages implemented + verified)

Provider: **Virtual Private Server** (`vps`, HMAC-only, manual-endpoint).
Runtime: Node 20 zero-dep. ZIP: `backend/artifacts/9drive-vps-relay.zip` (generated, 11897 bytes).
No Direct fallback / no cross-provider fallback — explicit by design.

## Stage 0 — Recon (done)
- Traced `9drive-relay-v1` in `relay-protocol.ts`, `transports/cloudflare-transport.ts`,
  `drivers/cloudflare-relay/worker.mjs`, `drivers/deno-relay/worker.ts`.
- Confirmed registry is generic (`driver-registry.ts`, `transport.ts`, `secure-fetcher.ts`);
  `RemoteFetchWorker.driver` is a string column → no DB migration needed.
- Confirmed usage/budget reuse via `RemoteFetchWorkerUsage` + `worker-usage.service.ts`.
- Minimum change set identified before editing; Cloudflare/Deno paths preserved.

## Stage 1 — Provider integration (done)
- [x] `types.ts`: `RelayProviderType += 'vps'`
- [x] `provider-capabilities.ts`: `VPS_CAPABILITIES` (selectable, streaming, range, no free-tier; local budgets only) + `PROVIDER_SAFETY_BUDGETS.vps = {null, null}`
- [x] `transports/vps-transport.ts` (new): wraps `CloudflareRemoteFetchTransport` with `driver:'vps'`
- [x] `drivers/vps.ts` (new): key `vps`, displayName `Virtual Private Server`, HMAC-only, endpoint preserve-subpath, encrypted secret, genuine `/health` test
- [x] `index.ts`: `registerDriver(vpsWorkerDriver)`
- [x] Frontend `WorkersPage.tsx`: auth select filtered by `driver.authTypes` (VPS shows HMAC only), `VpsDeployTutorial`, VPS budget placeholders (`blank = unbounded`)
- [x] Pinning preserved: same `workerId` across probe/download/range/retry/redirect via existing `secure-fetcher`/`transport`; failures stay VPS-route errors

## Stage 2 — Standalone relay (done)
- [x] `drivers/vps-relay/server.js` (zero-dep `node:http`): HMAC (`POST /fetch`, `GET /health`), public `/healthz`, exact v1 validation + `RELAY_PARSE_REASONS`, 15-header allowlist, Range/206/416 passthrough, manual redirect chain with per-hop SSRF re-validation, streaming pipe with backpressure + downstream-abort, concurrency default 2 → `429 CONCURRENCY_LIMIT`, header-only timeout (no short total timeout), envelope cap 5 MB, safe `traceId/urlFp/shape` logs, graceful shutdown
- [x] SSRF: http/https only, no credentials, IPv4/IPv6 blocklists (loopback/private/link-local/metadata/docs/multicast/reserved, incl. `::ffff:` mapped), full DNS `lookup(all)` validation per hop, internal-hostname deny; `ALLOW_PRIVATE_UPSTREAM` test-only bypass (default off, documented)
- [x] `ALLOW_PRIVATE_UPSTREAM` added to `.env.example` as test-only

## Stage 3 — ZIP + Dockerfile (done)
- [x] `drivers/vps-relay/Dockerfile` (node:20-alpine, non-root, `0.0.0.0:${PORT:-3000}`, HEALTHCHECK `/healthz`), `.dockerignore`, `package.json` (zero deps), `.env.example` (real names), `README.md` (Upload → Dockerfile → port 3000 + HTTPS → `RELAY_SECRET` → 9Drive `Virtual Private Server` → test → `relayHttpStatus` vs `upstreamStatus` → rotation; costs/proxy/caveats; cannot force 206 from 404)
- [x] `backend/scripts/zip-vps-relay.mjs` (excludes `*.test.ts`, `node_modules`, `.env`), `package.json:build` + `zip:vps-relay`, `backend/artifacts/.gitkeep`
- [x] Generated `backend/artifacts/9drive-vps-relay.zip` exists (ZIP root = Dockerfile + server.js + package.json + .env.example + README.md + .dockerignore)

## Stage 4 — Tests + validation (done)
- [x] `drivers/vps.test.ts` (12 tests): metadata, budgets, validateConfig, HMAC, health, transport via registry
- [x] `drivers/vps-relay/server.contract.test.ts` (10 tests): `/healthz`, HMAC `/health` good/bad, `/fetch` 401/400/`INVALID_PROTOCOL`/`INVALID_URL`, loopback blocked when bypass off, stream 200, Range 206 + `Content-Range`, upstream 404 preserved (`relay 200/upstream 404`), redirect final-URL, network exception → `502 UPSTREAM_FETCH_EXCEPTION`, concurrency 2 + 429
- [x] `vps-route-isolation.test.ts` (2 tests): VPS job pinned across probe/download; 404 stays VPS-route `DOWNLOAD_HTTP_ERROR`
- [x] Full `remote-fetch-workers` suite: 18 files / 250 tests pass; `probe-worker-route` + `processor-download`: 11 pass
- [x] `cd backend && npm run build` passes (tsc + relay asset + extension zip + vps zip)
- [x] `cd frontend && npm run build` passes
- [x] ZIP unpacked to clean temp dir, file list verified, `node --check server.js` OK
- [x] Docker build succeeds (`9drive-vps-relay:test`); container `/healthz` 200 + HMAC `/health` 200 verified; wrong secret → 401

## Deliverables
- Provider `Virtual Private Server`, fields: Name, HTTPS Endpoint URL, Authentication HMAC (only), Shared Secret, Region/Description, optional local budgets, Enable/Disable, Test connection.
- Changed paths: `types.ts`, `provider-capabilities.ts`, `transports/vps-transport.ts`, `drivers/vps.ts`, `index.ts`, `drivers/vps-relay/{server.js,Dockerfile,.dockerignore,package.json,.env.example,README.md}`, `scripts/zip-vps-relay.mjs`, `package.json`, `frontend/.../WorkersPage.tsx`, tests above. No schema migration (driver is a string; usage table reused).
- ZIP: `backend/artifacts/9drive-vps-relay.zip` — confirmed present.
- Panel steps: Upload ZIP → Build Dockerfile → context `/` → port 3000 + HTTPS → `RELAY_SECRET` → 9Drive Workers `Virtual Private Server` + same secret → Test + Range check.
- Logs: `[relay] event=upstream_response ... upstreamStatus=404 relayHttpStatus=200 fetchExecuted=true` (source 404) vs `[relay] event=validation_rejected ... relayHttpStatus=400 ... fetchExecuted=false` (relay rejection) vs `[remote-import:transport] relayHttpStatus=200 upstreamStatus=404 route=worker driver=vps ...`.
- **Direct fallback and cross-provider fallback are not implemented.** VPS jobs never switch route.
- Limits: 1 vCPU/1 GB → default 2 concurrent, streaming-only for large files; proxy buffering/idle timeouts must be raised; egress bills per host; alternative VPS IP is not guaranteed to fix upstream 404s.
