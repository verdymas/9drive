# 9Drive — Live HTTP-Only Media/R​elay Root-Cause Investigation (V2)

> **For coding agent (GPT-5.6 / high-reasoning).** This is a **continuation of the completed investigation**, not a new implementation project. Execute real tests and iterate on evidence. Do not stop after writing another harness, passing mocked tests, or repeating the existing inconclusive report.

## Operator-provided input — fill before running

```text
PAGE_URL=https://sxyprn.com/post/6acb192a51cf9.html?sk=Gattouz0&so=0&ss=latest
```

**Operator:** Replace `{{PAGE_URL}}` above with the **actual source video page URL** before handing this prompt to the agent. The URL must be handled as sensitive if it contains a session/query token; never copy the entire URL into shared reports, git commits, CI output, or ordinary logs.

Other inputs are **optional**, obtained from a fresh 9Drive extension capture or browser DevTools only if necessary:

```text
MEDIA_INITIAL_URL={{OPTIONAL_FRESH_302_REQUEST_URL}}
MEDIA_FINAL_URL={{OPTIONAL_FRESH_206_REQUEST_URL}}
```

Do not invent any media URL. If URLs are unavailable, start by investigating what can genuinely be extracted from the page using HTTP-only methods, then ask the operator for the smallest missing input. Do not treat thumbnail URLs as full media.

## Goal

Find a **reproducible, generic, HTTP-only** explanation for why real media requests succeed from browser/local Direct in some observations but return upstream HTTP 404 from 9Drive's Virtual Private Server (VPS) Relay, and fix only the proven defect, if any.

Do **not** promise a software fix where the origin imposes an externally controlled restriction. Keep investigating until either:

1. A narrowly scoped HTTP-only fix has been demonstrated with genuine media bytes and regression tests; **or**
2. A controlled same-URL comparison demonstrates a source-side/environment restriction or an essential missing browser-only step that is not reproducible HTTP-only, and the investigation records precise proof and an honest blocker.

**No Chromium, Puppeteer, Playwright, Selenium, headless browser, browser automation, remote browser, page-JavaScript evaluation, proxy rotation, challenge bypass, or speculative bot-protection evasion.** Use Node.js 20 built-ins, normal HTTP semantics, and captured/authorized request context only. Do not add site-specific resolvers or hardcoded `trafficdeposit.com` logic.

## Existing evidence to reuse, not redo

Read these files first:

- `reports/9drive-http-only-relay-investigation.md`
- `backend/diagnostics/http-only-relay/README.md`
- `backend/diagnostics/http-only-relay/media-probe.mjs`
- `backend/diagnostics/http-only-relay/media-probe.test.mjs`
- Relevant `AGENTS.md`, existing Remote Import route-affinity, capture, and relay code only when directly relevant to a newly observed discrepancy.

Facts already established:

- The 9Drive path is browser capture → Remote Import probe → selected transport → HMAC POST `/fetch` → VPS relay → upstream. A relay HTTP 200 with `upstreamStatus=404` means an actual upstream response, not a missing `/fetch` endpoint.
- Cloudflare/Deno/VPS live failures reported 404; native Node `fetch()` in the VPS container independently returned `404 text/html`.
- VPS environment: Alpine 3.23, Node 20.20.2, non-root, no `curl` or `docker` executable in the application container. **Don't assume root or require installation.**
- An ordinary `GET` of the page returned HTML 200 and `Set-Cookie` present; prior sequence `media 404 → page 200 → media 404` shows a bare HTML visit alone did not fix that tested URL.
- A page HTML scan found many `vidthumb.mp4` references: **thumbnail assets**, not evidence of the actual video.
- Browser DevTools showed a `.vid` 302 followed by `.vid` 206 without pressing Play, and extension capture detected the media on page load. Which operation created that sequence is still unknown.
- The earlier `206 text/html` result was a ranged **HTML page** on the page host, **not** video.
- 11 mocked harness tests passed. **No simultaneous, fresh, identical-URL local-Direct-versus-VPS comparison has yet been executed.** Previous report outcome was inconclusive. Do not relabel hypotheses as confirmed.

## NON-NEGOTIABLE: real diagnostic execution

**You must attempt live diagnostics from the actual 9Drive VPS relay container AND the local/production Direct egress.** The environment of execution matters. Running the harness only on a developer laptop, CI runner, or coding-agent sandbox cannot demonstrate how the VPS network is treated.

1. Determine what environments you can access. If access is available, run the tests yourself using the existing harness and save redacted results.
2. If the VPS/Direct consoles aren't accessible from your agent environment, provide minimal, **copy/pasteable Node 20 and POSIX-shell commands** for the operator to run in *both* places. Stop **at that precise input dependency**, ask for the two actual results, and **continue the investigation once received**. Do not produce another pretend-complete root cause report based on mock tests alone.
3. Prefer the already written `media-probe.mjs`; modify it only to make real execution easier or address a measurable coverage gap. It may require making a diagnostic-only standalone file available for manual copy to `/tmp` on the non-root VPS container. Do not expose a new public diagnostic endpoint or store secrets in a deployment ZIP.
4. Give commands that set `PAGE_URL` and an identified `.vid` media URL **without putting credentials/tokens in git or logs**. Capture only the redacted machine-readable diagnostic output. Do not print full paths, query strings, `Location` URLs, Cookie/Authorization values, or secret env vars.
5. Keep the live test bounded: request `Range: bytes=0-1023` initially, short timeouts, manual redirects with a maximum of five hops, small response samples, no full media download, no unbounded crawling, and no high-volume retries. If the source ignores Range, stop reading/cancel after the necessary bytes.

## Iterative live experiments — do not skip the controls

### Experiment 1: URL provenance / type / freshness

- From `PAGE_URL`, retrieve HTML using Node `fetch()` and inspect bounded HTML / script references for **observed** player metadata, initial `.vid` links, or API references. Static HTML discovery is fine; execution of arbitrary page JavaScript is not.
- Inspect current Browser Capture matching/normalization to distinguish a captured **initial redirect URL** from the **final CDN media URL**. Reuse operator-provided DevTools evidence for the 302 → 206 pair if needed.
- Treat each URL as opaque. Do **not** infer expiry purely from an epoch-like path segment, extension, or hostname.
- Classify `vidthumb.mp4`, image previews, HTML pages, and unknown binary responses separately. A 206 alone is **never sufficient** to call a media request successful.
- Use canonical URL SHA-256 short fingerprints (`urlFp` / `finalFp`), host, extension, redirect hop statuses, Content-Range, media-type hints, and magic bytes. Use the same canonicalization in both environments.

### Experiment 2: identical URL, near-simultaneous egress comparison (**highest priority**)

- Capture a **fresh** initial 302 `.vid` URL (plus final 206 URL where obtainable) in DevTools/9Drive extension. No video Play required if the page generates the request automatically.
- Within a short interval (preferably under two minutes), run **the same method, exact URL, Range, and header values** from:
  - A. The real VPS relay application container (native Node fetch, bypassing the relay handler for this experiment).
  - B. The actual environment used by Direct in 9Drive (server/local container, not a different machine or IP unless its egress is independently verified).
- Compare URL fingerprints, sent header *names*, request context presence, redirect traces, final host, actual status, Content-Type, Content-Range, and media bytes classification.
- Run initial 302 and final CDN URL as **distinct** experiments. For both, record which hop first diverges.
- Check whether the local browser and Direct server truly share the same outbound public egress and IPv4/IPv6 policy, rather than assuming that merely sharing a LAN makes the IP identical. If not comparable, record the discrepancy.
- If URLs have expired, re-capture and retry once with a *fresh matched pair*; never use different media URLs to claim an egress differential.

### Experiment 3: one-variable HTTP context differences

Only when Experiments 1–2 identify a plausible request-context gap:

- Compare media fetch with and without the **actual observed** `Referer`, keeping the rest identical.
- Inspect *captured* request-header names available through 9Drive extension (`referer`, `origin`, `user-agent`, `cookie`, `accept*`, `sec-ch-ua*`, `sec-fetch-*`). Do not invent values to simulate a browser.
- Compare redirect/header handling and the exact origin-scoping logic. Do not send cookies, authorization, or HMAC credentials to unrelated hosts or across cross-origin redirects. Existing SSRF protections remain mandatory.
- If the page provides Set-Cookie and authorized browser state is relevant, test a controlled HTTP session with a properly origin/path-scoped cookie jar **only when authorized**, without disclosing the value. A cookie's mere existence doesn't prove it's used to authorize media.
- For each change, require `404 → verified 206/media` or `200/media` **on the same URL**, with at least one repeated fresh sample before treating it as a reliable fix.

### Experiment 4: HTTP-only page initialization (conditional)

- Compare media access **before and after** page GET on the **same VPS egress** using the same still-fresh media URL, with a no-warmup control.
- Optionally follow bounded, *observed* HTTP-only page/player initialization requests (e.g. a documented/player API request visible in a **user-provided, redacted** HAR/DevTools trace) if they are relevant, authorized, and needed to obtain a valid media URL. Do not crawl unrelated domains or blindly replay ad/tracker traffic.
- Re-test on a second fresh URL before attributing causality to the warmup step.
- If HTML-only warmup remains `404 → 404`, explicitly mark **that hypothesis unsupported**; stop repeating it. Do not assume JavaScript was executed.

### Experiment 5: compare native VPS request vs relay request (only if useful)

- If native VPS fetch returns verified media but VPS Relay returns 404 using the same canonical URL and context, compare actual HMAC envelope construction, allowed upstream headers, redirect policy, Range handling, method, and per-hop upstream status; apply a minimal fix with tests.
- If both native VPS and relay return 404, do not refactor relay serialization as a speculative cure. Distinguish true relay errors from origin-reported statuses.

## Security & scope

- Only test URLs and media the operator is authorized to access. Respect upstream access controls and rate limits. **Do not build a mechanism to circumvent an upstream IP, anti-bot, authentication, or other access restriction.** Diagnose and report it; seek supported access methods if needed.
- Preserve `9drive-relay-v1`, HMAC auth, source URL validation, DNS/SSRF checks (including redirect hops), safe cookie origin scoping, Range correctness, streaming/backpressure, and cancel behavior.
- **Never fall back automatically to Direct**, and never auto-switch a job's selected Worker provider.
- No domain-specific resolver, host-specific workaround, cloud provider rotation, IP spoofing, challenge solving, or general open proxy.
- Do not make a global product change based on one ambiguous test.
- Keep 1 vCPU / 1 GB RAM VPS constraints in mind; only bounded Node requests for diagnosis.

## Decision gate — implement only when the fix is proven

**A. Evidence-backed fix discovered:**

- State the exact root cause and show the paired live results, including URL fingerprint, true media-byte verification, and the first differing stage.
- Implement the **smallest generic** correction in the current request-context, redirect, probe, or relay pipeline. No speculative header additions. Prefer a configurable, opt-in behavior when warmup introduces extra network operations.
- Add focused tests for the proven failure and existing 206/404/416/redirect/range/security behavior.
- Re-run the same live test and verify the changed code is the code actually deployed before claiming success.

**B. No fix possible or insufficient environment access:**

- State **blocked / source-side restriction / insufficient live access** with exactly what was and was not demonstrated. A matched local-206/VPS-404 pair supports an egress-specific difference, but cannot by itself prove whether the origin made the decision based on IP reputation vs TLS/client differences.
- Provide a compact next-step request for operator evidence, or a supported alternative that doesn't circumvent source restrictions.
- Do not label the work solved based on offline test passes, 206 HTML, thumbnails, or a speculative browser-warmup hypothesis.

## Required working style

1. First briefly summarize what the previous investigation already established and what evidence is missing.
2. Start **live execution** immediately where permissions and available environments allow; don't spend the task creating a new suite of broad test scaffolding.
3. Maintain a per-experiment ledger: environment, UTC time, URL fingerprint, header names (never values), hop statuses, final status, verdict (`media`, `html`, `unknown`), and conclusion.
4. After each experiment, select the next test according to the observed result. Do not shotgun dozens of unrelated tests.
5. If external execution requires operator action, give one exact step and wait for results; resume from the ledger rather than restarting from scratch.
6. Finish with **one verified solution or one evidence-backed blocker**, and distinguish confirmed findings from hypotheses.

## Deliverables

Update `reports/9drive-http-only-relay-investigation.md` **in place** with:

- The actual supplied `PAGE_URL` recorded **only as a redacted host plus safe fingerprint**, not as a full URL.
- Live egress A/B table: same URL fingerprint, timestamps, per-hop statuses, final verdict, and whether headers/method/Range truly matched.
- Which of hypotheses URL freshness, request context, HTTP-only warmup, redirect behavior, and egress difference were confirmed or eliminated by real tests.
- Exact root cause if established; otherwise the narrowly worded blocker and missing evidence.
- Any minimal code changes, deployment steps, tests, and repeatable verification commands.

If the agent lacks console access, the first substantive response must be the **specific operator commands and expected sanitized output**, not a second offline-only 'investigation completed' report.
