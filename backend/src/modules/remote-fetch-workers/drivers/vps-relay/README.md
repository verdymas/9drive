# 9Drive VPS Relay (`9drive-vps-relay.zip`)

Self-hosted `9drive-relay-v1` network relay for 9Drive Remote Import.
Runs on a **1 vCPU / 1 GB RAM VPS** via the hosting panel's **Upload ZIP → Dockerfile** workflow.
Zero runtime dependencies (plain Node 20 `node:http`).

## 1. Deploy with the hosting panel

1. Choose **Provider: Upload**.
2. Upload **`9drive-vps-relay.zip`** (this archive's root — `Dockerfile` must be at the ZIP root).
3. Set **Build Type: Dockerfile**, not Static.
4. Set build context/path to the ZIP root. If the panel asks for a path, use empty or `/` (both mean “ZIP root” — the `Dockerfile` sits beside `server.js`).
5. Configure the application/container port: **`3000`** (or your `PORT`), attach a domain, and enable **HTTPS**. The container listens on `0.0.0.0:${PORT:-3000}` over plain HTTP behind the panel's HTTPS reverse proxy — do not bake TLS certificates into the image.
6. Add environment variables:
   - `RELAY_SECRET` — **required**, cryptographically random (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Must exactly match the secret in 9Drive.
   - `RELAY_PUBLIC_URL=https://<your-domain>` — **optional but recommended**: the asserted public base URL shown by `GET /system-health`. Must be `https` with no credentials, query, or fragment. When unset, system-health reports `publicBaseUrl: null` with a warning.
   - `PORT=3000` (optional), `MAX_CONCURRENT_TRANSFERS=2`, `MAX_REDIRECTS=5`, `UPSTREAM_HEADER_TIMEOUT_MS=20000` (optional tuning).
   - In the panel, add each variable under the service's environment settings, then redeploy/restart so the container picks them up.
7. Deploy and check logs (no secrets appear in logs):
   - `GET https://<your-domain>/system-health` → setup-status JSON (public, no auth — see section 6 below).
   - `GET https://<your-domain>/healthz` → `{"status":"ok","service":"9drive-relay"}` (public liveness probe; also the Docker `HEALTHCHECK`).
   - Server log shows `[relay] listening on 0.0.0.0:3000 ... relaySecret=configured|missing` (boolean only, never the value).
8. In 9Drive: **Workers → Add Worker → Service: `Virtual Private Server`** → paste the HTTPS endpoint URL (e.g. `https://relay.example.com`, preserve any sub-path, no trailing slash needed) → Authentication **HMAC** → paste the **same** `RELAY_SECRET` → Save → **Test connection** → try a small streaming/Range transfer.

## 2. Expected responses

- Health (authenticated): `GET /health` with `x-9drive-signature: HMAC(secret, "GET /health")` → `{"service":"9drive-relay","protocolVersion":"9drive-relay-v1","status":"ok","capabilities":{...}}`.
- Fetch: `POST /fetch` with `x-9drive-signature: HMAC(secret, "POST /fetch")` and JSON `{protocolVersion:"9drive-relay-v1", url, method:"GET"|"HEAD"|"POST", headers, response:"stream"}`.
  - Streaming answer: HTTP `200` + `x-9drive-streaming: 1`, `x-9drive-upstream-status: <source status>`, `x-9drive-final-url: <post-redirect URL>`, body = raw upstream bytes.
  - **Read `relayHttpStatus` vs `upstreamStatus` separately**: relay `200` + `upstreamStatus 404` means *the source* returned 404 (fetch executed), not a relay failure. Relay `401/400/429/502` means the *relay* rejected/failed the request.
- Overload: `429 {"error":"overloaded","code":"CONCURRENCY_LIMIT"}` when more than `MAX_CONCURRENT_TRANSFERS` (default 2) are active.

## 3. Limits, costs, proxy caveats

- Defaults target 1 vCPU / 1 GB: max 2 concurrent transfers, no full-file buffering, bounded control JSON (64 KB), envelope cap 5 MB (streaming is uncapped/unbuffered).
- The VPS is **not inherently free**: bandwidth/egress, storage, and uptime bill per your host. 9Drive's local safety budgets (unbounded by default for VPS) only cap what 9Drive sends — they cannot see other traffic.
- Reverse proxy: disable response buffering for the relay domain and raise idle/proxy timeouts (e.g. ≥ 120 s) or long streams may be cut. The relay itself has no short total timeout once upstream headers arrive.
- Firewall: only the HTTPS port needs to be public. Never expose unencrypted `RELAY_SECRET` in build logs.
- Restart: stateless — safe to restart anytime; in-flight transfers retry via 9Drive (GET/HEAD, bounded backoff, same worker, no Direct fallback).

## 4. Diagnostics without leaking secrets

Compare the **same current URL** and effective headers across Direct vs VPS:
- 9Drive logs join on `traceId=<job>:<op>` + `urlFp=<sha256(canonical href)[0:12]>` (fingerprint, never the URL).
- VPS logs show `targetHost/finalHost`, `upstreamStatus`, `relayHttpStatus`, `fetchExecuted`, `hasRange`, header *names* only.
- The relay **cannot force `206`** from a destination that returns `404`: if both Direct and VPS report `upstreamStatus=404` for the identical URL, the origin has no such object/range — fix the source URL, do not rotate secrets.
- Upstream network errors (`DNS/TLS/connect`) return `502 {"code":"UPSTREAM_FETCH_EXCEPTION"}` — distinct from upstream HTTP `404`.

## 5. System Health (`GET /system-health`)

Open `https://<your-domain>/system-health` in a browser. It needs **no HMAC** (so it answers while HMAC is still unconfigured) and returns `Content-Type: application/json; charset=utf-8` with `Cache-Control: no-store`. It reports local configuration only — never secrets, hashes, env values, or file URLs — and never fetches an upstream URL.

Ready example (HTTP 200, `RELAY_PUBLIC_URL` set):

```json
{
  "service": "9drive-vps-relay",
  "provider": "Virtual Private Server",
  "protocol": "9drive-relay-v1",
  "status": "ready",
  "timestamp": "2026-10-14T01:00:00.000Z",
  "uptimeSeconds": 123,
  "publicBaseUrl": "https://relay.example.com",
  "endpoints": { "health": "/system-health", "relay": "/fetch" },
  "setup": {
    "relaySecret": { "configured": true },
    "authentication": { "mode": "hmac", "configured": true },
    "httpServer": { "listening": true },
    "relayHandler": { "registered": true },
    "publicUrl": { "configured": true }
  },
  "capabilities": { "rangeRequests": "implemented", "responseStreaming": "implemented" },
  "warnings": [],
  "message": "Relay service is configured. Use the authenticated connection test in 9Drive to verify that both sides share the same secret."
}
```

Missing-secret example (HTTP 503 — the process keeps serving diagnostics; `/fetch` and HMAC `/health` fail closed with `401` until the secret is set):

```json
{
  "service": "9drive-vps-relay",
  "provider": "Virtual Private Server",
  "protocol": "9drive-relay-v1",
  "status": "not_configured",
  "timestamp": "2026-10-14T01:00:00.000Z",
  "uptimeSeconds": 12,
  "publicBaseUrl": null,
  "endpoints": { "health": "/system-health", "relay": "/fetch" },
  "setup": {
    "relaySecret": { "configured": false },
    "authentication": { "mode": "hmac", "configured": false },
    "httpServer": { "listening": true },
    "relayHandler": { "registered": true },
    "publicUrl": { "configured": false }
  },
  "capabilities": { "rangeRequests": "implemented", "responseStreaming": "implemented" },
  "warnings": [
    "RELAY_SECRET is not set — set RELAY_SECRET and redeploy. Relay operations fail closed until it is configured.",
    "RELAY_PUBLIC_URL is not set — publicBaseUrl is null. Set RELAY_PUBLIC_URL to the relay https domain."
  ],
  "message": "Relay is not configured: set RELAY_SECRET in the deployment environment and redeploy, then use the authenticated connection test in 9Drive (Workers → Virtual Private Server) to verify that both sides share the same secret."
}
```

Notes:

- `status` is `ready` (HTTP 200), `degraded` (HTTP 200, secret set but `RELAY_PUBLIC_URL` invalid — `publicBaseUrl: null` plus a warning), or `not_configured` (HTTP 503, `RELAY_SECRET` missing).
- These are **local configuration checks**, not end-to-end tests: `configured: true` only means a non-empty value is present (not that it is random, and not that 9Drive holds the same secret). The next step is always 9Drive's authenticated connection test (`Workers → Virtual Private Server → Test connection`), which verifies HMAC compatibility.
- If reverse-proxy HTTPS is missing, the relay still answers over the container port, but register and test the `https://` domain in 9Drive — never an `http://` origin over the public internet. If the process fails to start at all, `/system-health` is unreachable; inspect container logs for the startup error instead.

## 6. Rollback / secret rotation

1. Generate a new `RELAY_SECRET`, set it on the VPS deployment, redeploy/restart.
2. In 9Drive Workers → edit the VPS worker → paste the new secret → Save → Test connection.
3. Old secret stops working immediately (`401`). No data migration needed. Keep the old deployment until the new health check passes, then switch the endpoint URL if it changed.

## 7. VPS Browser Warmup (optional, disabled by default)

Short-lived headless Chromium visits the originating page (**no Play click**), lets normal page-load JS/player init run, closes the browser, then 9Drive probes/downloads through the **same VPS relay** via existing `/fetch` streaming + Range. One warmup at a time; retries/ranges/resumes never relaunch.

- **Endpoint:** `POST /warmup` with JSON `{protocolVersion:"9drive-relay-v1", pageUrl, traceId?, idempotencyKey?, timeoutMs?}` + payload-bound HMAC (`x-9drive-signature=HMAC(secret,"POST /warmup\\nsha256(body)\\nTs\\nNonce")`, `x-9drive-timestamp`, `x-9drive-nonce`, 300s replay window, single-use nonces). Legacy `/fetch` keeps bare `METHOD path` HMAC untouched.
- **Answers:** `200 {status:"warmed", navigationStatus, mediaObserved, browserMedia206}` · `400 INVALID_URL` (incl. SSRF-blocked) · `401/403` auth/replay · `429` busy · `501 WARMUP_NOT_SUPPORTED` (lean image or disabled) · `502/504` navigation/timeout. `browserMedia206` is genuine media only (never `206 text/html`, never `vidthumb.mp4`).
- **Images:** lean `Dockerfile` (alpine, zero-dep) answers `501` and reports `browserWarmup.supported:false` — ordinary relay downloads unaffected. Warmup `Dockerfile.warmup` (`node:20-slim` + Chromium + `puppeteer-core`, `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`) enables it. Rename to `Dockerfile` if the panel only looks for that name. Build size grows ~170–400MB at deploy time (Chromium via apt, not in the ZIP).
- **Env:** `BROWSER_WARMUP_ENABLED=true` + `CHROMIUM_EXECUTABLE_PATH` both required for `supported:true`; `BROWSER_WARMUP_TIMEOUT_MS` (5–60s, default 25s), `BROWSER_WARMUP_REPLAY_WINDOW_SECONDS` (30–600, default 300). Backend master switch `VPS_BROWSER_WARMUP_ENABLED=false` by default (can only disable, never force); per-job `warmupMode off|auto|required` (auto = warm iff VPS + page present + capability).
- **Health:** HMAC `GET /health` → `capabilities.browserWarmup:{supported,configured}`; public `GET /system-health` → `browserWarmup:{supported,configured,lastErrorCategory}` (booleans/enums only, no internals/secrets).
- **Security:** SSRF validates the page URL (scheme/creds/hostname/DNS blocklists incl. redirects); subresource egress is bounded by nav timeout + single tab + immediate close/reap (see server.js `runChromiumWarmup`). Chromium runs as non-root `node`; `--no-sandbox` is required in containers without user-namespaces — compensating isolation is incognito-per-warmup, discard-after-close, authenticated `/warmup` only, `RELAY_SECRET` never entering the page. Never expose `/warmup` without HMAC.
- **PoC diagnostic (same-egress gate):** on the VPS, run `node diagnostics/browser-warmup-probe.mjs --page 'https://SOURCE_HOST/...' --media 'https://MEDIA_HOST/...vid' --json` (sampled `Range: bytes=0-1023`, redacted hosts + `sha256[:12]` fingerprints, `ftyp`/EBML verdict). `BEFORE 404 → AFTER 206 genuine` on two fresh URLs = proceed; browser-206 + node-404 = session gap, do not ship; both 404 = source-side.
- **Rollback:** set per-job warmup `off` (or backend `VPS_BROWSER_WARMUP_ENABLED=false`) and/or redeploy the lean `Dockerfile` — ordinary `/fetch` downloads keep working; no data migration.
