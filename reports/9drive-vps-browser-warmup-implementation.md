# 9Drive — VPS Browser Warmup Implementation Report

Status: **minimum implementation DONE, problem NOT SOLVED (pending live gate)**.
Date: 2026-10-14. No live VPS access; offline tests only. Feature ships **disabled by default**.

## 1. Architecture and timing (warmup before first probe)

```
extension (originUrl/initiator at onHeadersReceived, never active-tab)
  pageUrl + sourcePageUrl ──► POST /browser-capture/resources ──► CapturedResource{pageUrl, sourcePageUrl}
  ──► POST /browser-capture/resources/:id/import {workerId, sourcePageUrl?, warmupMode?}
  ──► maybeWarmupBeforeProbe (import boundary, before HLS/opaque re-probe)
  ──► createRemoteImport{sourcePageUrlEncrypted, displayPageUrl, warmupMode, warmupStatus:pending}
  ──► BullMQ queued ──► processor: assertWorkerUsable → maybeWarmupBeforeProbe(importId~attempt)
  ──► probeSource (bytes=0-0) / HLS manifest ──► download → placement → upload
Manual path: RemoteImportModal Page URL + warmupMode ──► POST /probe (warms first) ──► POST / (persist) ──► same queue path.
PATCH /:id/download-url edits sourcePageUrl/warmupMode (validated, re-queued).
```

Warmup-once: `warmupIdempotencyKey=<importId>~<attempt>:<pageFp>` + backend in-memory single-flight + relay `idempotencyKey` echo + `warmingActive` mutex (429 busy). Skipped for resume stages (`uploading`/`remuxing`/`registering`) that never re-probe. `required` mode throws typed errors (`WARMUP_*`); `auto` preserves legacy behavior when URL/capability/switch missing. No VPS→Direct fallback anywhere.

Protocol: `POST /warmup` (new, backward-compatible). Auth payload-bound: `HMAC(secret,"POST /warmup\nsha256(body)\nTs\nNonce")` + `x-9drive-timestamp`/`x-9drive-nonce`, 300s window, single-use nonces. Legacy `/fetch` (`HMAC("POST /fetch")`) untouched. Health: `/health capabilities.browserWarmup{supported,configured}`, `/system-health browserWarmup{supported,configured,lastErrorCategory}` (safe enums only).

## 2. Phase 1 results (offline only — live gate PENDING)

BEFORE/AFTER harness built: `drivers/vps-relay/diagnostics/browser-warmup-probe.mjs` (same-egress, same URL + `Range: bytes=0-1023`, redacted hosts + `sha256[:12]`, `ftyp`/EBML verdict, rejects `206 text/html` + `vidthumb.mp4`, RSS metrics, immediate reap).

- Automated relay contract (`server.warmup.test.ts`): lean image advertises `supported:false`, answers `501 WARMUP_NOT_SUPPORTED` (never fake `warmed`), rejects bad HMAC (401), replays (403), unsafe URLs incl. loopback (400). Pass.
- **No live BEFORE/AFTER run** (no VPS runtime, no fresh captured URLs). Gate outcomes unobserved. Mark **not solved**; warmup stays `VPS_BROWSER_WARMUP_ENABLED=false` by default.
- Operator commands (run on the VPS egress, return sanitized JSON only):
  ```bash
  cd backend && npm run zip:vps-relay
  # Upload backend/artifacts/9drive-vps-relay.zip (Dockerfile at ZIP root) → port 3000 + HTTPS → RELAY_SECRET=... (+ warmup image: use Dockerfile.warmup as Dockerfile, BROWSER_WARMUP_ENABLED=true)
  node diagnostics/browser-warmup-probe.mjs --page 'https://SOURCE_HOST/...' --media 'https://MEDIA_HOST/...vid' --json
  # Repeat on a 2nd fresh URL + a no-warmup control; report statuses, content-types, hops, urlFp, RSS — never raw URLs/cookies.
  ```

## 3. Limitations

- Source-site access policy unknown until live gate; `browser 206 + node 404` would indicate session/fingerprint/egress gap warmup cannot fix.
- Browser cookies/IP are NOT shared with Node `fetch` (fresh incognito context, discarded after close).
- 1 vCPU / 1 GiB: lean relay ~MBs; warmup image +Chromium ~170–400MB transient RSS (one at a time, 25s bound). OOM fallback: separate micro-instance, never weaken sandbox silently.
- Subresource/service-worker egress beyond top-level SSRF check is bounded (timeout + single tab + disposal), not formally proxied — documented residual risk.

## 4. Files modified, migrations, ZIP, deploy commands

- Shared: `remote-fetch-workers/relay-protocol.ts` (+`/warmup` path/headers/schemas), `browser-warmup.ts` (new: sanitize/display/fp/idempotency/HMAC/capability), `types.ts` (+`browserWarmup`), `errors.ts` (+6 `WARMUP_*`), `drivers/vps.ts` (sanitize `browserWarmup`), `config/env.ts` (+3 `VPS_BROWSER_WARMUP_*`, default off).
- Backend: `remote-imports/vps-warmup.service.ts` (new: `maybeWarmupBeforeProbe`, single-flight, no fallback), `remote-import.service.ts` (+`sourcePageUrl`/`warmupMode` create/edit/serialize), `remote-import.routes.ts` (+schemas + pre-probe warmup), `processor.ts` (pre-probe warmup, resume-aware), `browser-capture.routes.ts`/`browser-capture.service.ts` (+`sourcePageUrl` submit/persist/thread + pre-probe warmup on import).
- Relay: `drivers/vps-relay/server.js` (`POST /warmup`, replay cache, SSRF, mutex, Chromium-optional `runChromiumWarmup`, health fields), `Dockerfile.warmup` (new, `node:20-slim` + Chromium), `.env.example` (+warmup vars), `README.md` (§7), `diagnostics/browser-warmup-probe.mjs` (new PoC).
- Extension: `background.js` (+`sourcePageUrl` at detection + context-menu, never active-tab), `api.js` (submit `sourcePageUrl`).
- Frontend: `lib/remoteImports.ts` (+types/probe extra/patch), `hooks/useRemoteImportForm.ts` (+page/mode state), `components/drive/RemoteImportModal.tsx` (+Warmup collapsible).
- Tests (new): `browser-warmup.test.ts`, `vps-warmup.service.test.ts`, `server.warmup.test.ts`; updated `server.system-health.test.ts` (allowlisted `browserWarmup`).
- Migration: `prisma/migrations/20261014000000_vps_browser_warmup/migration.sql` (`remote_imports` +6 cols, `captured_resources.source_page_url`; all nullable). Schema updated; `npx prisma generate` done. Apply with `cd backend && npm run prisma:migrate`.
- ZIP: `cd backend && npm run zip:vps-relay` → `backend/artifacts/9drive-vps-relay.zip` (23,653 bytes; root = Dockerfile + Dockerfile.warmup + server.js + package.json + .env.example + README.md + .dockerignore + diagnostics/). Lean deploys by default; warmup needs `Dockerfile.warmup` as the build Dockerfile + `BROWSER_WARMUP_ENABLED=true` + `CHROMIUM_EXECUTABLE_PATH`.
- Builds: `cd backend && npm run build` pass; `cd frontend && npm run build` pass.

## 5. Automated and live test results

- New: 8 (warmup service: off/direct/missing/non-vps/no-capability/single-flight/429/transport-failure, no fallback) + 9 (helpers/schemas/HMAC) + 4 (relay warmup: 501/advertise, 401/403, 400 SSRF, no fake warmed) pass.
- Regression: `remote-imports` + `remote-fetch-workers` + `browser-capture` = 66 files / 788 tests pass; extension `node --test` 14 pass.
- Live: **not run** (blocked, see §2). Unresolved blockers: need VPS egress + 2 fresh `PAGE_URL`/`MEDIA_URL` pairs + sanitized PoC JSON.

## 6. Rollback and security assessment

- Rollback: per-job `warmupMode:off` (or backend `VPS_BROWSER_WARMUP_ENABLED=false`) and/or redeploy lean `Dockerfile` — `/fetch` streaming/Range/HMAC/SSRF unchanged; no data migration (nullable cols).
- Security: `/warmup` authenticated (payload-bound + replay), SSRF top-level + per-hop `/fetch` parity, non-root `node`, incognito-per-warmup discarded, `RELAY_SECRET` never in page, one-at-a-time + deadlines + reap, safe logs (traceId + `sha256[:12]` + hosts, never URLs/cookies/tokens/bodies). Residual: `--no-sandbox` in containers without user-namespaces (documented, compensating isolation above); subresource egress bounded not proxied; operator must keep `/warmup` HMAC-only and Chromium pinned.
