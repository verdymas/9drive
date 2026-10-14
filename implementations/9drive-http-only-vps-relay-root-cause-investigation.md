# 9Drive — HTTP-Only VPS Relay Root-Cause Investigation

## Mission

Act as a senior Node.js networking engineer and investigate why 9Drive Remote Import can retrieve media through a browser / sometimes through Direct on the same residential or production network, but receives **HTTP 404 from the upstream source** when fetched from Cloudflare Workers, Deno Deploy, Google Colab, and the **Virtual Private Server** relay.

**Goal:** Establish the exact cause with reproducible, controlled experiments and, **only if supported by evidence**, implement the smallest generic fix. Continue iterating through the defined experiments until a reproducible solution is verified **or** the remaining blocker is positively isolated. Never claim success just because an endpoint responds 200/206: verify it returns actual media bytes, not HTML.

**Absolute constraint: Do not use Chromium, Chrome Headless, Puppeteer, Playwright, Selenium, browser emulators, or install any browser runtime.** Use **Node.js 20 built-in APIs**, ordinary HTTP requests, existing 9Drive code, and optionally browser DevTools/extension request information supplied by the user as *reference evidence only*. Keep this investigation usable inside the current Alpine-based, non-root VPS Docker container. Do not require `docker`, `curl`, root, `apk`, or new packages for the primary experiments.

## Known evidence — do not reinterpret it as proof of a cause

1. The source media host is from the `trafficdeposit.com` family; a video page is on a separate origin. Some source URLs end in `.vid`, others in `.mp4`; the URL path sometimes contains epoch-like numbers and opaque segments. Do not assume those numbers are expiry timestamps without verification.
2. Direct from the production/local network **previously** returned `206`, but a tightly controlled simultaneous comparison for the **exact same URL, headers and time window** has not yet been established.
3. Cloudflare, Deno, and VPS relay have observed upstream `404`. On the VPS container itself, **native Node.js `fetch()` to a media CDN URL returns `404`, `text/html`, with no `Content-Range`** — so this case is not solely a bug in the relay handler.
4. The VPS container uses **Alpine 3.23**, **Node.js v20.20.2**, runs non-root, has no `curl` or `docker` CLI.
5. A native `fetch()` of the source HTML page returned `200` and `Set-Cookie` was present. A previous sequence `BEFORE media 404 -> PAGE HTML 200 -> AFTER media 404` shows an ordinary HTML GET alone does **not** establish access.
6. An HTTP-only page scanner read approximately **188 KB of HTML** and found about **24 `vidthumb.mp4` URLs**, apparently thumbnails, rather than the actual `.vid` media request. It also found external JavaScript references. Do not mistake thumbnails for full media.
7. Browser DevTools reportedly showed a `.vid` request returning **302**, followed by a `.vid` media request returning **206** **without pressing Play**. The 9Drive Browser Capture extension detected media as the page loaded. This suggests page-load initialization or a redirect chain but does **not** prove which request or state enables it.
8. A previous 'success' in a terminal trace returned `206`, `text/html`, host = **page origin**, `Content-Range: bytes 0-1023/30862`. That was **a ranged HTML page, not a video**. Require strong media validation.
9. A prior successful Xtreme Download Manager request included browser-like headers and an originating `Referer`, but the exact URL/request comparison was not sufficiently controlled.
10. 9Drive has a `9drive-relay-v1` protocol, HMAC-authenticated VPS relay, HTTP Range streaming, worker route selection, and diagnostic logging. An explicitly Worker-selected job must **never silently fall back to Direct or switch Worker providers**.

## Investigation boundaries

- Start from the current repository implementation, not assumed legacy code. Read `AGENTS.md` and focused documentation if available. Inspect only Remote Import, Browser Capture request-context forwarding, Worker transport selection, VPS relay, and relevant tests.
- Do not refactor or modify unrelated providers or features. Do not introduce domain-specific bypasses or change the active job's route.
- Do not add speculative HTTP headers blindly. Do not weaken SSRF, redirect, HMAC, or secret protection.
- Use traffic from legitimately accessible pages/media only; respect source access restrictions. If the source explicitly denies cloud/datacenter access, **report it as a restriction rather than attempting to bypass it**.
- Never execute remote JavaScript obtained from an untrusted page in Node.js. Static inspection/parsing of HTML/JS is permissible with tight response limits; no `eval`, `vm`, or dynamic code execution.
- Make all network tests optional and bounded, with explicit user-supplied `PAGE_URL` and `MEDIA_URL` or a sanitized user-supplied DevTools request record. No crawling, exhaustive discovery, or large downloads.
- Do not require the agent to possess SSH/container access when it does not. If unavailable, generate copy-pastable commands/scripts and **wait for user-supplied output** before asserting the outcome.

## Phase 0 — Reconstruct the actual transport chain

Trace and document:

`Browser/extension capture -> captured URL and request context -> Remote Import probe -> selected worker route -> VPS HMAC relay -> outbound HTTP request -> upstream response -> 9Drive error mapping`

Identify the actual request URLs and methods at each stage, redacting the path/query. Verify whether a 302 URL, final 206 URL, or a stale URL is passed to the relay. Compare URL representations using a stable, truncated hash of the **full canonical URL** generated consistently in each environment; log host and extension separately. Ensure URL redaction protects signed path segments as well as query strings.

## Phase 1 — Create a reusable HTTP-only diagnosis harness

Create a **small, dependency-free Node.js 20 tool** (preferably an executable script in a focused diagnostics folder, or a standalone script suitable for pasting into the Alpine container). It should:

- Accept `PAGE_URL`, `MEDIA_URL` and optional `REFERER_URL` via environment variables. Never include real target URLs or secrets in source control.
- Be read-only by default. Test only `https://` URLs supplied by the operator; impose URL/redirect safety checks, request timeouts, a maximum of 4–5 redirects, a small response-body read limit (e.g. 1–4 KiB for probing), and a cap on total requests per experiment. Do not send HMAC relay secrets to upstream sites.
- Perform bounded `GET` tests using `Range: bytes=0-1023`, but account for origins that ignore Range. Inspect `status`, `content-type`, `content-range`, `location` host (not full location), `content-length`, and an optional bounded first-byte signature. Cancel/close every response body promptly.
- Trace redirects **manually** and report each hop's status, source host, destination host, and content type. Preserve/strip sensitive headers across redirects according to normal origin boundaries; do not blindly forward cookies/authorization to a new host.
- Distinguish **HTML 206** from **media 206**. Validate actual response bytes, expected resource type, media characteristics (e.g. MP4 `ftyp` near the start where applicable), content-range plausibility, and final host/path relationship. `.vid` extension alone is not proof of media type.
- Produce a small structured JSON report with timings, URL fingerprints, header **names only**, redacted host/path information, final status, failure stage, and media validation result. Redact all secret URLs/path tokens, cookie values, HMAC keys, and response bodies.
- Handle empty environment variables, Node fetch exceptions, 302 without Location, 416 Range Not Satisfiable, content decompression, aborts/timeouts, and DNS/TLS failures cleanly.

**The harness must not fetch full videos.** Return and close body streams properly. Add local tests that mock HTTP redirects, HTML `206`, upstream `404`, and genuine media `206` before testing a live URL.

## Phase 2 — Controlled experiments, one variable at a time

Run the following on the **same fresh media resource** in a close time window; whenever possible compare from (A) VPS container and (B) known-working production/local Direct environment. Use identical request templates unless the experiment explicitly changes one dimension.

### Experiment A — Verify input identity and freshness

1. Obtain from a user-provided DevTools capture the initial `.vid` request **with status 302** and, separately, the subsequent final `.vid` request **with status 206**. Do not ask the user to publish full URLs or auth headers.
2. Check that the target in the VPS test is actually a `.vid`/`.mp4` media URL and not the HTML page or `vidthumb.mp4` thumbnail.
3. Compare full-URL hashes to determine whether the tested URL is identical between environments and whether the website generated a fresh redirect destination on page load.
4. Log initial redirect and resulting final media response separately. Do not treat an already-expired or different URL as a valid A/B comparison.

### Experiment B — Classify failure by redirect hop

Test **initial 302 URL** and **final media URL** separately, with manual redirects:

- Initial 302 -> final 206 (actual media bytes)
- Initial 302 -> final 404
- Initial URL directly 404
- Initial/final requests that return HTML `206`, not media

Produce a comparison table for VPS and local Direct: initial status, redirect chain, final upstream host, final status, returned content type, and media validation.

### Experiment C — Minimal request-context matrix

Starting with an identical fresh URL and explicit baseline request, vary **one item per test** where user-approved and actually observed in a successful browser request:

- `Referer` absent vs. true source-page Referer.
- `Origin` only where the browser sent it and where appropriate.
- `Range` absent vs. `bytes=0-1023`.
- Actual `User-Agent`, `Accept`, `Accept-Language`, and `Accept-Encoding: identity` as shown in the successful request, rather than guessed blanket headers.
- Whether a request was initiated by page loading versus by direct URL selection.
- HTTP method and redirect behavior.

For browser-only headers such as `Sec-Fetch-*`, record observed values but do **not** pretend those alone reproduce browser TLS/network behavior. If authentication, cookies, or a one-time URL are required, note that plainly; handle such values only when explicitly provided by an authorized user through secure local configuration, never in logs or code.

### Experiment D — HTTP-only page warmup and media discovery

Without a browser runtime:

1. Fetch the video source HTML and identify `Set-Cookie` **presence**, redirects, relevant response headers, and referenced script/API endpoints. Do not print cookie values.
2. Identify actual media candidates distinctly from thumbnails. Inspect static player configuration in HTML or JS text using bounded reads and safe parsing. If media URLs only originate in executable JavaScript, explicitly mark them as **not reproducible with HTML-only fetch** rather than inventing a parser.
3. If the user-provided Network trace identifies a specific **documented/observed page-load XHR or media-initialization request**, test that **single known request** via HTTP-only Node, with normal authorization and safety checks. Do not guess/brute-force private endpoints.
4. Rerun the **identical** media probe before and after the page initialization sequence. Keep URL freshness, timing, response media verification, and outbound IP in view.
5. If `404 -> 206` occurs, repeat the experiment with a fresh independent URL and a control run without warmup. Otherwise mark the hypothesis unsupported or unresolved, not fixed.

### Experiment E — Network / egress separation

Record only coarse egress context (provider and whether local or VPS), not sensitive public IPs in shared reports unless explicitly approved. Test the **same URL fingerprint** and **same request** from local Direct and VPS as close together as practicable.

- Local 206 (verified media), VPS 404 with identical effective request: investigate provider/network-based access differences and source-side policy; do not claim this conclusively proves IP reputation, TLS fingerprint filtering, or expiry by itself.
- Local 404, VPS 404: revisit freshness, media URL selection and actual browser redirect chain.
- VPS native fetch 206 (media), VPS relay 404: the bug is now likely in relay request construction/routing/serialization; debug it specifically.

Do not implement proxy rotation, WAF evasion, CAPTCHA solving, TLS-fingerprint spoofing, or other measures to circumvent an explicit source access policy.

## Phase 3 — Root-cause decision tree

At the end of experiments, assign one of the following classifications and show the evidence:

1. **Wrong resource** (HTML 206 or thumbnail mistaken for main media).
2. **URL freshness or identity mismatch** (including dynamic page-generated media URL or redirect).
3. **Incomplete request context** (a single observed, authorized header/method or initialization step changes outcome reproducibly).
4. **Redirect propagation defect** in capture, Worker relay, or backend.
5. **Actual upstream network-policy difference** between local and cloud egress (with uncertainty noted if unproven).
6. **VPS relay implementation defect** isolated by successful native fetch on the same VPS.
7. **Inconclusive** with exact next evidence needed.

Do not call a root cause 'confirmed' without a reproducible differential test.

## Phase 4 — Implement only a demonstrated fix

If and only if an HTTP-only approach reproducibly obtains **valid media 206 from the intended VPS route**:

- Integrate the minimal **generic** correction into the existing 9Drive Remote Import/Virtual Private Server flow (e.g. preserve the exact captured URL, correct observed headers, propagate safe redirect semantics, or add an **optional** page-preparation step if a known HTTP-only sequence is proven necessary).
- Do not hardcode any TrafficDeposit domain, path, endpoint, token pattern, or site-specific resolver; use general abstractions, allowlists and provider capability flags where appropriate.
- Keep security guarantees: HMAC, strict SSRF validation for **every** redirect and preparation request, protection against local/private network destinations, short timeouts and strict request-count limits, no token/cookie exposure, and connection cleanup.
- Preserve `9drive-relay-v1` status/body/Range/streaming integrity, job route affinity, usage accounting, and no automatic Direct fallback or provider switching.
- Add deterministic tests verifying the exact regression, media-body correctness, unauthorized destinations rejected, and existing Cloudflare/Deno/Direct behavior unchanged.
- Do not deploy changes or trigger large transfers without approval.

If the evidence points to origin-side datacenter restrictions or cannot demonstrate successful HTTP-only access from VPS, **do not invent a workaround or implement a speculative warmup feature**. Report the limitation and the next valid diagnostic action instead.

## Deliverables

1. `reports/9drive-http-only-relay-investigation.md` with:
   - Evidence already available vs. newly reproduced evidence.
   - Redacted and correlated test matrix: exact test setup, header names, timings, URL identity hashes, hop-by-hop status, media validation.
   - Confirmed root cause or bounded uncertainty.
   - Why a previously observed `206 text/html` is not a video success.
   - Which HTTP-only hypotheses succeeded or failed, and why.
   - Precise next step if no permitted HTTP-only solution exists.
2. A dependency-free Node.js 20 diagnostic script usable inside the non-root Alpine VPS container, with README and focused offline/mocked tests.
3. **Only if verified:** minimal, reviewed 9Drive code changes plus regression tests.
4. A short summary: files changed, tests run, actual outcomes, required user action, and any deployment notes.

## Definition of done / stop rules

- **Success:** A fresh media request that previously failed from the VPS is reproducibly fetched through the intended route, with **actual media bytes** (`206`/valid `Content-Range` or valid whole-body media semantics), confirmed on a second fresh case, and 9Drive integration tests pass.
- **Valid investigation completion:** Controlled testing identifies an upstream restriction or provides a precise, evidence-backed blocker that cannot be solved with the permitted HTTP-only methods. State this plainly instead of pretending the task was solved.
- Do not run indefinite retries. Limit each experiment to a small bounded number of requests and stop on repeated identical 404s with no new evidence. Stop immediately for access-control, rate-limit, or permission concerns.
- **Never** introduce Chromium, browser automation, arbitrary scraping, silent direct fallback, unauthenticated open proxy behavior, or unrelated refactors.

Begin by reporting the current code path and generating the test harness. Then execute the smallest decisive experiment. If the agent cannot access the production VPS, provide exact commands for the user to execute and wait for results before proceeding with findings.
