# VPS Browser Warmup — Implementation Progress

## Status: Phases 0–6 CODE DONE (offline) — LIVE GATE PENDING (not solved until proven)

Provider: **Virtual Private Server** (`vps`, HMAC-only). No rename of provider ID/driver.
Spec: `implementations/9drive-vps-browser-warmup-phased-implementation.md` (183 lines).
Decisions (operator-confirmed): scope = full plan 0–6; Chromium fallback = `node:20-slim` + pinned Chrome (`Dockerfile.warmup`); live access = none → stop at operator commands, wait for sanitized evidence.
Gate: `BEFORE 404 → AFTER 206 genuine media bytes` (same URL/headers/egress, 2nd fresh URL + no-warmup control). `206 text/html` / `vidthumb.mp4` ≠ success. Current: **not solved** (no live run); feature ships **disabled by default** (`VPS_BROWSER_WARMUP_ENABLED=false`).

Non-negotiables: no VPS→Direct fallback; VPS-only (Cloudflare/Deno untouched except minimal shared schema); Chromium = short-lived page prep only, never click Play / never per-Range relaunch / never held open for downloads; preserve `9drive-relay-v1`, HMAC, streaming/backpressure, Range, upstream-status, SSRF; no secret/URL/cookie echo (log host + ext + `sha256(canonical).slice(0,12)` only).

## Phase 0 — Audit and design (done)
- [x] Traced lifecycle: interactive `POST /probe` (`remote-import.routes.ts` → `probe.ts`) vs creation zero-I/O (`remote-import.service.ts`) vs queue probe (`processor.ts` → `processor-probe.ts`)
- [x] Traced capture→import→job→worker→relay: `background.js` (`pageUrl=originUrl||initiator`) → `api.js` → `browser-capture.service.ts` → `RemoteImport` → BullMQ → `SecureRemoteFetcher` → `vps-transport.ts` → `POST {endpoint}/fetch`
- [x] Confirmed gap: `CapturedResource.pageUrl` existed but dropped at import; `RemoteImport` had no page column; zero `sourcePageUrl` hits
- [x] Confirmed HMAC method+path only — warmup uses payload+timestamp/nonce binding + replay cache
- [x] Confirmed packaging: `Dockerfile` (`node:20-alpine`, `USER node`), `scripts/zip-vps-relay.mjs` → `backend/artifacts/9drive-vps-relay.zip`; health: HMAC `/health`, public `/system-health`, `/healthz`
- [x] Wrote full 0–6 plan; warmup insertion = before first probe, job/attempt-scoped once-marker, capability gating

## Phase 1 — Standalone Chromium PoC (code done, live run PENDING)
- [x] Isolated diagnostic `drivers/vps-relay/diagnostics/browser-warmup-probe.mjs`: BEFORE `Range 0-1023` → headless Chromium `goto(SOURCE_PAGE_URL)` (no Play, 25s bound, listeners before nav, redact timeline, skip `vidthumb`) → close/reap → AFTER same fetch → media-verdict (`ftyp`/EBML, not `text/html`)
- [x] Bound: 1 instance, 1 tab, overall deadline, sampled bytes only, RSS/startup metrics, cleanup on timeout/cancel/OOM
- [x] Slim fallback implemented as `Dockerfile.warmup` (`node:20-slim` + Chromium + `puppeteer-core`, pinned); lean ZIP stays deployable (501 without Chromium)
- [ ] LIVE gate (operator, same VPS egress): run twice on fresh `MEDIA_URL`s + no-warmup control; `404→206 media` = proceed / `browser 206 + node 404` = session gap, do not ship / `both 404` = source-side
- [ ] Operator commands (no agent VPS access — stopped here until sanitized `status/content-type/urlFp/hops/RSS` returned, no raw URLs/cookies):
  `cd backend && npm run zip:vps-relay` → Upload ZIP (Dockerfile at root) → port 3000 + HTTPS → `RELAY_SECRET=...` (+ warmup: `Dockerfile.warmup` as Dockerfile, `BROWSER_WARMUP_ENABLED=true`) → `node diagnostics/browser-warmup-probe.mjs --page ... --media ... --json`

## Phase 2 — Browser Capture Extension: `sourcePageUrl` (done, backward-compat)
- [x] Extension binds at detection (`background.js`, `api.js`) via `originUrl||initiator` + context-menu page; never active-tab; deterministic top-level rule; no history collection
- [x] Schemas: `browser-capture.routes.ts` submit/import accept optional `sourcePageUrl` (+`warmupMode` on import); `browser-capture.service.ts` validates http(s)/no-creds/strip-fragment, persists `CapturedResource.sourcePageUrl` (falls back to `pageUrl`), threads `sourcePageUrl ?? pageUrl` + `warmupMode` through `importCapturedResource` (incl. pre-probe warmup); old payloads still pass
- [x] Migration `20261014000000_vps_browser_warmup` (+ schema): `captured_resources.source_page_url`; safe domain label only in UI
- [x] UI: extension popup unchanged (backend derives label); `RemoteImportModal.tsx` optional manual Page URL + warmup select (VPS-only hint)
- [x] Tests: tab-switch/concurrent/iframe/close/absent covered by unit suites (helpers + service single-flight + routes); extension `node --test` 14 pass

## Phase 3 — Backend: once-before-first-probe (done)
- [x] Migration + Zod: `POST /`, `POST /probe`, `PATCH /:id/download-url` accept optional `sourcePageUrl`/`warmupMode`; `sourcePageUrl ≠ referer`; encrypted at rest (`sourcePageUrlEncrypted` + `displayPageUrl`), safe serialize (strip blob, keep label + `warmupMode`/`warmupStatus`)
- [x] Setting `warmup:{off|auto|required}` persisted; default `auto` = on iff VPS + URL + capability + master switch; `required` fails typed; old jobs unchanged (NULL = legacy)
- [x] Warmup-once: `warmupIdempotencyKey=<importId>~<attempt>:<pageFp>` + in-memory single-flight + relay idempotency; CAS-safe; skips resume stages (`uploading`/`remuxing`/`registering`); trace `warmup.requested/browser.launch-requested/browser.closed/warmup.completed/probe.status` (no secrets)
- [x] Capability gate: `RelayHealthResponseSchema` + `sanitizeCapabilities` + `types.ts` (`browserWarmup{supported,configured}`); `maybeWarmupBeforeProbe` rejects `required` on legacy relays before probing
- [x] Env: `VPS_BROWSER_WARMUP_ENABLED=false` (default off, can only disable), `VPS_BROWSER_WARMUP_TIMEOUT_MS=25000`, `VPS_BROWSER_WARMUP_REPLAY_WINDOW_SECONDS=300`

## Phase 4 — VPS Relay: Chromium service (done, lean-compatible)
- [x] `POST /warmup` with payload-bound HMAC + timestamp/nonce + replay window (single-use nonces, bounded cache); legacy `/fetch` semantics untouched; never unauthenticated arbitrary-URL browser
- [x] SSRF: page URL validated (scheme/creds/hostname/DNS blocklists); per-hop `/fetch` parity kept; subresource egress bounded (nav timeout + single tab + close/reap; residual risk documented in README §7)
- [x] Runtime: non-root (`USER node` both images), fresh incognito ctx per warmup, discard cookies/cache, never pass `RELAY_SECRET` to page; 1-at-a-time (`429 busy`), 1 tab, nav deadline, CPU/mem logs, reap on cancel/OOM; never held open for downloads
- [x] Packaging: `npm run zip:vps-relay` → `backend/artifacts/9drive-vps-relay.zip` (23,653 bytes; includes `Dockerfile`, `Dockerfile.warmup`, `diagnostics/`); warmup deps installed at Docker build (apt Chromium, not in ZIP); port/TLS contract unchanged
- [x] Health: `/health capabilities.browserWarmup{supported,configured}`; `/system-health browserWarmup{supported,configured,lastErrorCategory}` (no internals/secrets); `/fetch` streaming/Range/redirects preserved

## Phase 5 — Tests + live verification (auto done, live pending)
- [x] Auto: helpers/schemas/HMAC (9), service decisions/single-flight/no-fallback (8), relay warmup contract 501/401/403/400/no-fake-warmed (4), updated system-health allowlist; regression `remote-imports` + `remote-fetch-workers` + `browser-capture` = 66 files / 788 tests pass; extension 14 pass
- [x] Builds: `cd backend && npm run build` pass (tsc + relay asset + extension zip + vps zip); `cd frontend && npm run build` pass
- [ ] Live (operator, fresh URLs): baseline → warmup (no Play) → post-warmup, same URL/ctx/egress + fingerprints/timestamps + final-URL diff; small import → one larger Range/stream; stop on quota/mem/rate-limit

## Phase 6 — Deployment, docs, handoff (done except live evidence)
- [x] Docs: extension API (submit `sourcePageUrl`), Remote Import schema/UI (Page URL + mode), relay README §7 + `.env.example` + ZIP steps + `RELAY_SECRET` + rollback (warmup `off` / redeploy lean, ordinary relay intact), health fields, test commands
- [x] Report `reports/9drive-vps-browser-warmup-implementation.md`: architecture/timing proof, Phase 1 offline results + pending gate, limits (access policy, session vs Node ctx, 1GiB), files/migrations/ZIP output/deploy commands, auto+live results, blockers, rollback + Chromium-on-untrusted-page security assessment
- [ ] Done = minimum (URL plumbed, secure gated once-before-probe warmup, ZIP deploys, others intact) ✅ vs solved (controlled `404→206 genuine` + real import) ❌ — **not solved**, disabled by default, awaiting PoC evidence

## Operator input needed to resume
- Fresh `SOURCE_PAGE_URL` + `MEDIA_URL` (Browser Capture, never thumbnail/invented); VPS SSH/panel access; sanitized Phase 1 JSON back (statuses, content-types, hops, `urlFp`, RSS — no tokens/cookies/HMAC/full bodies). Apply DB migration: `cd backend && npm run prisma:migrate`.
