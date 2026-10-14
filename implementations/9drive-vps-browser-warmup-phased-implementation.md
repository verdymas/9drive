# 9Drive — VPS Browser Warmup (Chromium) + Browser Capture Page URL

## Role / Mission

You are the coding agent working in the existing 9Drive repository. Implement **Browser Warmup** only for the **Virtual Private Server** Remote Fetch Worker provider. The feature uses short-lived headless Chromium to visit the originating page **without pressing Play**, allows its normal page-load JavaScript / player initialization to run, closes the browser, and then performs the existing media download through the **same selected VPS relay** using the existing `9drive-relay-v1` streaming and HTTP Range behavior.

**This is a multi-phase, evidence-driven implementation. Do not declare success based only on page navigation or HTTP status 206. Prove that actual media bytes become accessible.**

### User-supplied diagnostic inputs

```text
SOURCE_PAGE_URL={{PAGE_URL}}
MEDIA_URL={{MEDIA_URL_OPTIONAL}}
```

- The operator will replace `{{PAGE_URL}}` with a real originating webpage URL (not the CDN media URL).
- `{{MEDIA_URL_OPTIONAL}}` may be left blank. Prefer a fresh media URL captured from the page by the existing 9Drive Browser Capture extension; never invent a URL or use a thumbnail as the target.
- Keep both URL values out of logs/reports if they contain tokens, signed path segments, or private query data. Record host, path extension, and a consistent canonical-URL SHA-256 truncated fingerprint instead.
- If the coding agent has no access to the actual VPS runtime or fresh captured URL, produce precise operator commands, **stop at the live verification gate**, and resume when the operator provides sanitized results. Offline tests alone are insufficient.

## Non-negotiable constraints

1. The UI provider name is exactly **Virtual Private Server**. Preserve its existing provider ID/driver conventions rather than renaming persisted records.
2. **No automatic VPS → Direct fallback** and no cross-provider failover. Worker-selected jobs must stay on their explicitly selected Worker for probes, retries, range requests, and downloads.
3. Do not modify Cloudflare, Deno, or unrelated features except minimal shared backward-compatible schema/interface changes needed for the optional Page URL.
4. No domain-specific resolver, TrafficDeposit-only logic, synthetic authorization, speculative header stuffing, IP-rotation, or bypass of source-site access controls.
5. Chromium is **only for short-lived page preparation**. Do not click Play, keep a browser alive during large transfers, use a browser as the actual download transport without a separately proven design, or warm up again for every Range request.
6. Preserve `9drive-relay-v1`, HMAC authentication, streaming/backpressure, redirects, accurate upstream-status handling, and existing SSRF protections.
7. Do not echo signed URLs, Cookies, tokens, HMAC secrets, or full request bodies in diagnostics.
8. Implement a limited PoC first. **If Chromium opens the page but normal VPS media fetch still returns 404, the core hypothesis is not confirmed; do not mark Browser Warmup successful or silently enable it for production.**

## Existing architecture / evidence to reuse

Read `AGENTS.md` and the relevant repo documentation index. Then inspect the current implementation before making assumptions. Start from the existing report if present:

`reports/9drive-http-only-relay-investigation.md`

Known relevant locations (verify current paths rather than assuming they still exist):

- `extensions/browser-capture/src/background.js`
- `extensions/browser-capture/src/request-headers.js`
- `backend/src/modules/remote-imports/remote-import.service.ts`
- `backend/src/modules/remote-imports/probe.ts`
- `backend/src/modules/remote-imports/secure-fetcher.ts`
- `backend/src/modules/remote-fetch-workers/transports/vps-transport.ts`
- `backend/src/modules/remote-fetch-workers/transports/cloudflare-transport.ts`
- `backend/src/modules/remote-fetch-workers/drivers/vps-relay/server.js`
- `backend/diagnostics/http-only-relay/media-probe.mjs`
- `backend/diagnostics/http-only-relay/README.md`
- `backend/package.json` script `npm run zip:vps-relay`

Current evidence: Native Node.js fetch from the VPS to some `.vid` URLs returns **404 text/html**; opening a source HTML page using Node.js fetch alone produced `404 → page 200 → 404`. Chrome DevTools on the user's machine displayed a `.vid` 302 → 206 sequence **without pressing Play**. A separate trace of `206 text/html` was only a ranged HTML document, not actual media. No controlled same-URL/same-time network comparison has yet confirmed the root cause. Therefore, the hypothesis "Chromium page initialization on the VPS allows subsequent Node.js fetch" is **unproven**.

---

## Phase 0 — Audit and design (no product changes yet)

Trace the actual lifecycle, including **when the initial media probe happens** (it may run while creating the Remote Import, before the download queue). Identify how capture items move from tab/request tracking into the extension UI, import API, persistent job model, selected Worker, and the VPS relay. Identify the existing request-context encryption/storage strategy and current HMAC envelope.

Write a short implementation plan specifying:

- How to bind captured media URLs to the **originating tab's** page URL at the time of capture, not to the currently active tab at import time.
- Exactly where to introduce a single warmup **before the first media probe**, not just before queued download.
- A job/import/attempt-scoped, concurrency-safe **warmup-once** marker and retry rules that avoid repeated Chromium launches on every probe, redirect, or Range request.
- How the backend and VPS relay exchange a warmup command via a backward-compatible authenticated route/protocol addition, with explicit capability discovery.
- Deployment and memory implications for a 1 vCPU / 1 GiB RAM VPS using an Upload ZIP + Dockerfile hosting panel.

Do not change code until this lifecycle and the PoC plan are explicit.

## Phase 1 — Standalone Chromium PoC on the VPS (mandatory success gate)

Build an isolated diagnostic command within the VPS deployment package (or a temporary diagnostic image running on the **same VPS egress**), using a supported headless Chromium + `puppeteer-core` or equivalent. Keep it independent of the 9Drive job path initially.

For a fresh `MEDIA_URL` and `SOURCE_PAGE_URL`, perform:

1. **BEFORE:** bounded `GET Range: bytes=0-1023` directly from VPS Node.js, recording true media classification (status, content-type, content-range, `ftyp` / EBML signature where applicable), source host and SHA-256 URL fingerprints.
2. Start a headless browser session. Attach request/response listeners **before navigation**.
3. Navigate to `SOURCE_PAGE_URL`, allowing normal page-load JavaScript to initialize. **Never click Play.** Wait for a bounded, clearly defined signal or timeout; do not rely blindly on `networkidle` when pages have ads or long polling.
4. Record a redacted timeline of relevant `.vid` / `.mp4` requests and redirects. Exclude obvious `vidthumb.mp4` thumbnail candidates from full-media success criteria. Never dump cookies or sensitive URLs.
5. **Close Chromium completely**, including page/context/process, within the timeout and memory budget.
6. **AFTER:** repeat the exact same normal Node.js ranged media fetch, maintaining the same media URL and same header set used in BEFORE. Browser-captured URL substitutions are a **separate experiment**, never silently substituted.
7. If AFTER still returns 404, separately test whether the browser itself genuinely obtained media `206` (validate content; `206 text/html` is not a media success), and whether its pre/post-redirect URLs differ from the input.
8. Repeat any promising `404 → 206/media` result on a second freshly captured URL, with a no-warmup control, to distinguish warmup effect from URL freshness / redirect differences.

Make diagnostics bounded by default: one Chromium instance at a time, conservative navigation timeout (e.g. 25 seconds), overall deadline, bounded sampled media bytes, no automatic full-file downloads, resource and memory metrics if supported, automatic cleanup on exceptions/cancellation.

**Gate:**

- `BEFORE 404 → AFTER 206 with genuine media bytes` on controlled repeated trials = **warmup hypothesis supported**; continue production integration.
- `Browser media 206 but Node.js still 404` = session/fingerprint/egress difference remains; **do not assume browser warmup solves relay**.
- `Browser 404 and Node.js 404` = likely source-side or URL/context restriction; report precisely, no fake fix.
- Agent cannot access VPS = prepare reproducible commands and wait for sanitized evidence, not an invented success.

## Phase 2 — Browser Capture Extension: add originating Page URL

Once Phase 1 proves a useful behavior (or when implementing backward-compatible scaffolding explicitly behind a disabled feature flag):

- Add an optional field named `sourcePageUrl` or the repository's established equivalent to capture payloads, backend API schemas, and relevant persisted job/request model.
- At media detection time, associate it with the tab/frame responsible for that media request using existing `requestId` + tab tracking; never infer it from whichever browser tab is active later.
- For embedded/iframe players, retain both top-level page URL and frame information if the existing model supports it; set the navigable source page using a documented, deterministic rule and avoid cross-tab leakage.
- Preserve the exact real URL needed for navigation, except strip fragments and embedded credentials; keep sensitive query values private and protected at rest according to current secure request-context conventions.
- Capture/share this information only when the user actually sends a media capture for import. Do not build background browsing-history collection.
- Preserve old extension payloads that omit `sourcePageUrl`. Allow a manual optional Page URL field in Remote Import if appropriate to existing UX.
- Show a safe human-facing label/domain for Page URL in UI, not signed query values or credentials.
- Add focused tests for tab changes, multiple concurrent media requests, iframe cases, tab closure, and absence of Page URL.

## Phase 3 — Backend: orchestrate exactly one warmup before first probe

Implement optional Browser Warmup strictly for **Virtual Private Server**:

- Keep existing VPS connections/imports backward compatible. If Page URL is missing, preserve the prior non-warmup behavior unless the user explicitly selected a warmup-required mode; do not fabricate it.
- Expose a clear per-job/per-VPS Browser Warmup setting. Avoid auto-enabling a hypothesis that failed Phase 1. Once verified, default may be **enabled only when VPS is selected and `sourcePageUrl` is present**, with an explicit disable option for diagnostics. Existing jobs remain unchanged.
- Perform warmup **before** media probing, including the initial probe in `createRemoteImport`, not just before download starts.
- Use a bounded, authenticated, idempotent warmup operation; maintain job/attempt-scoped state so retries, ranges and resumed transfers do not launch Chromium repeatedly. Define retry/TTL semantics and ensure concurrent workers cannot race to launch duplicate browsers.
- Keep `sourcePageUrl` separate from `referer`; a Page URL is for browser navigation, a Referer is an HTTP request header applied only under current scoped header rules.
- If warmup fails in a warmup-required flow, fail with explicit typed error and stage (e.g. navigation failure, browser launch failure, timeout, security rejection). **Do not silently switch to Direct, another Worker, or an ordinary fetch while reporting warmup success.**
- Emit joined trace identifiers for `warmup.requested`, `browser.launched`, `navigation.status`, `media.observed`, `browser.closed`, `probe.status`, `download.status` without logging secrets or full URLs.
- If the selected relay version does not advertise warmup capability, reject an enabled warmup job clearly before probing; legacy relays must still work for non-warmup jobs.
- Avoid broad schema changes to unrelated Remote Import providers or storage placement (Google Drive / S3 / Telegram).

## Phase 4 — VPS Relay: Chromium service implementation

Implement a short-lived browser command in the existing `Virtual Private Server` relay package and expose it through the established HMAC-authenticated transport. Choose the smallest protocol extension consistent with the existing code; do not mislabel a browser-health `200` as upstream media success.

Security and operational requirements:

- Use **strongly authenticated** warmup requests. Review whether the existing HMAC authenticates only method/path; if so, design the new warmup command to bind authentication to payload + timestamp/nonce (with replay resistance) without breaking legacy `/fetch` semantics. Never expose an unauthenticated arbitrary-URL browser service.
- Validate page URLs and browser redirect/resource destinations against SSRF rules: block loopback, RFC1918, link-local, metadata endpoints, unsafe schemes, DNS rebinding, disallowed ports. Bear in mind page subresources and service workers can initiate requests beyond the initial navigation; apply egress restrictions at a layer that covers them, rather than claiming top-level validation alone is sufficient.
- Run Chromium as a non-root user with sandboxing where supported. If container security limits force weakening Chromium sandboxing, explicitly document the risk and require compensating isolation; **never run an untrusted-page browser as privileged root**.
- Never pass HMAC keys or backend secrets into the browser environment or webpage context. Use a fresh incognito/isolated browser context per warmup; discard its cookies/cache/storage afterward. Do not assume browser cookies or IP are automatically shared with subsequent Node.js `fetch()`.
- One active Chromium warmup at a time, sensible queue or busy response for concurrent jobs, limited open tabs, navigation deadline, strict memory/CPU limits, bounded subresource transfer, process reaping on cancellation and OOM. Do not hold Chromium open throughout downloads.
- Use the existing VPS Docker packaging: `cd backend && npm run zip:vps-relay`. The generated `backend/artifacts/9drive-vps-relay.zip` must contain a deployable Dockerfile and all required Chromium binaries/dependencies; document build-size and storage requirements. Prefer a reproducible pinned browser/runtime combination that actually works on the deployed OS (currently reported as Alpine 3.23, Node 20) or justify a documented runtime-base change. Keep the relay listen port / TLS reverse proxy contract unchanged.
- Preserve streaming and Range functionality; do not buffer full media files in RAM/disk.
- Include a safe diagnostic field in System Health indicating `browserWarmup.supported`, `browserWarmup.configured`, `browserWarmup.lastErrorCategory` (no secrets), and a protected authenticated capability check. Do **not** expose detailed internals or operator-only diagnostics anonymously.

**Resource target:** 1 vCPU / 1 GiB RAM. State real observed peak RSS, startup time, and OOM behavior. If 1 GiB cannot reliably support both relay and temporary Chromium, report the limitation and propose a separate low-overhead deployment/instance rather than quietly reducing security or claiming production-readiness.

## Phase 5 — Automated tests and live end-to-end verification

Minimum automated tests:

1. Extension captures the originating Page URL correctly (including tab switching / iframe / concurrent captures).
2. Old extension API payloads and existing imports without Page URL continue to work.
3. Page URL is validated, privately persisted, redacted in logs, and correctly scoped.
4. VPS warmup runs **before initial HEAD/Range probe** only when enabled and supported.
5. Warmup executes **once per job/attempt**, not per HTTP Range, retry, redirect or resume. Concurrency race is tested.
6. Browser navigation and redirect outcomes are separated from actual media status.
7. Missing/invalid/unsafe Page URL, bad HMAC, replay, denied destination, timeout, browser crash/OOM, absent capability all fail safely.
8. Genuine media 206 is recognized via media bytes / headers, not `206 text/html` or `vidthumb.mp4`.
9. Browser session is disposed on completion, timeout and cancellation; no orphan Chromium processes.
10. Existing Cloudflare, Deno, Direct and non-warmup VPS jobs still pass regression tests; no route fallback.
11. `9drive-relay-v1` streaming, backpressure, HTTP Range, upstream status, security and health endpoints remain correct.

Live verification with fresh user-provided URLs:

- Same `MEDIA_URL`, same relevant HTTP request context, same VPS egress, recorded URL fingerprint and close timestamps.
- Compare baseline normal fetch, browser page warmup without Play, post-warmup normal fetch, with content validation.
- Ensure the redirected final URL and any changes to the captured URL are recorded separately.
- Demonstrate successful full Remote Import to the currently selected storage provider only after the media can be fetched, without leaking URL/cookies.
- Use a small authorized test media sample, then one representative larger Range/stream case; stop on quota/memory/rate-limit issues.

## Phase 6 — Deployment, documentation, and handoff

Update the extension API reference, Remote Import schema/UI docs, VPS Relay deployment README, ZIP packaging instructions, test commands, and health endpoint description. Include operator steps for updating the Browser Capture extension, applying migrations, deploying the VPS ZIP via Upload → Dockerfile, configuring `RELAY_SECRET`, and rolling back Browser Warmup without disabling ordinary relay downloads.

Produce a report at:

`reports/9drive-vps-browser-warmup-implementation.md`

The report must contain:

- Architecture and timing (prove warmup occurs before the first probe).
- Exact Phase 1 results: before/after status, redirect hops, media-verdict, same-URL fingerprints, whether browser or plain fetch succeeded.
- Any limitations regarding source-site access policy, browser session vs Node.js context, and 1 GiB RAM.
- Files modified, migration changes, VPS ZIP output, precise deploy/update commands.
- Automated and live test results; unresolved blockers clearly labeled.
- Rollback strategy and a security assessment for headless Chromium visiting untrusted user-provided pages.

### Definition of done

**Minimum implementation done:** optional Page URL is captured and preserved, VPS Chromium warmup is implemented securely with capability gating, it runs once before the initial probe, the VPS ZIP deploys, and existing providers are unaffected.

**Problem actually solved:** on a controlled fresh failing media URL, ordinary VPS fetch initially fails, opening the real source page in headless Chromium **without Play** demonstrably enables subsequent normal VPS fetch to return **genuine media** (`206/media` or valid equivalent); 9Drive completes a real import. If this does not reproduce, mark **not solved**, keep the risky feature disabled by default, publish the diagnostic evidence, and request the next specific input rather than inventing a success.
