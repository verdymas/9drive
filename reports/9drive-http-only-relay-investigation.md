# 9Drive — HTTP-Only VPS Relay Investigation Report

Date: 2026-10-14. Status: **valid investigation completion with bounded
uncertainty — no fix implemented** (Phase 4 gate not met: no permitted
HTTP-only method has yet reproducibly fetched genuine media bytes through
the VPS route).

V2 live pass (same day, later): agent-sandbox live runs executed — bounded
page scan (2 fetches, 117-URL census: 0 `.vid`, 23 `vidthumb.mp4`) plus one
bounded thumbnail probe (`206 video/mp4`, `mp4-ftyp` from sandbox egress).
VPS-container and production-Direct A/B remain blocked on operator console
access — see §8. Still no fix implemented (gate not met).

## 0. Transport chain (Phase 0, reconstructed from current code)

`extension capture -> request context -> Remote Import probe -> worker route
-> VPS HMAC relay -> upstream -> error mapping`

| Stage | Current implementation | URL / method at this stage (redacted) |
| --- | --- | --- |
| Browser capture | `extensions/browser-capture/src/request-headers.js` (`RequestHeaderTracker`: allowlist-only, `Range` never captured) + `src/background.js` (matches by `requestId` + URL, TTL 60 s) | Captured media URL as seen on the wire; request context = `referer / origin / userAgent / cookie / accept* / sec-ch-ua* / sec-fetch-*` values only |
| Import creation / probe API | `backend/src/modules/remote-imports/remote-import.service.ts` (`createRemoteImport`: worker validated first, `validateRemoteUrl` with backend DNS skipped in relay mode) → `probe.ts` (`probeRemoteUrl`: HEAD, then ranged `GET bytes=0-0`, then one bounded manifest GET for HLS hints) | `GET`/`HEAD` of the stored `sourceUrl`; redirects followed per-hop with `hopHeaderResolver` (cookie re-scoped to the exact source origin every hop) |
| Route selection | `secure-fetcher.ts` (`createSecureFetcherForWorkerId`: `workerId null → Direct`, else registry → driver; logs `[remote-import:route] route=worker …`) — retries/edits re-validate the worker and **never silently fall back to Direct** | Same canonical URL; route identity logged as `route=direct` vs `route=worker workerId driver relayHost`, joinable on `traceId` + `urlFp` (`sha256/12` of `new URL(href).href`) |
| VPS relay transport | `transports/vps-transport.ts` (thin wrapper) → `transports/cloudflare-transport.ts` (`CloudflareRemoteFetchTransport`: `POST <endpoint>/fetch`, HMAC `x-9drive-signature = HMAC(secret, "POST /fetch")`, `response: "stream"`, `traceId` preserved across retries) | Relay `POST /fetch` carrying `{protocolVersion, url, method, headers, traceId}`; upstream method `GET`/`HEAD`; `Range` applied last so a captured value can never override the generated probe/download range |
| VPS relay server | `drivers/vps-relay/server.js` (`doValidatedFetch`: per-hop SSRF DNS+blocklist validation incl. redirect destinations, `redirect: manual`, max 5 hops; streaming mode pipes raw upstream bytes with `x-9drive-upstream-status` / `x-9drive-final-url`) | Outbound `GET <target>` with allowlisted headers only (`referer, origin, user-agent, cookie, accept*, sec-ch-ua*, sec-fetch-*, range`); redirects followed server-side, final URL reported |
| Error mapping | Transport: relay `400 → WORKER_RELAY_PROTOCOL_ERROR`, `401/403 → WORKER_AUTH_FAILED`, relay `!ok → WORKER_UNHEALTHY`; **upstream 404 rides inside relay-HTTP-200 as `status: 404`** (proven by `relay-404-diagnostics.test.ts`). Fetcher `downloadToFile`: upstream `>= 400 → DOWNLOAD_HTTP_ERROR 502` | A VPS-relay `404` in 9Drive logs with `relayHttpStatus=200 / upstreamStatus=404` is the **source answer**, never a relay routing failure; relay-level 404 (wrong path) surfaces as `WORKER_UNHEALTHY` instead |

URL-identity accounting: backend, relay, and the new diagnosis harness all
compute `sha256(canonical href).slice(0, 12)` identically, so `urlFp` values
can be compared across environments without ever exposing signed path
segments or query values. Host and extension (`vid`/`mp4`) are logged
separately from the fingerprint.

## 1. Evidence: available vs newly reproduced

### 1a. Available (from the mission brief — treated as leads, not proof)

1. Source host in the `trafficdeposit.com` family; page and media on
   separate origins; `.vid` and `.mp4` URLs with epoch-like/opaque segments.
2. Direct from prod/local **previously** 206 — but no simultaneous,
   same-URL/headers/time-window comparison exists.
3. Cloudflare, Deno, and VPS relay observed upstream 404; native Node
   `fetch()` on the VPS container returned `404 text/html, no Content-Range`.
4. VPS container: Alpine 3.23, Node v20.20.2, non-root, no `curl`/`docker`.
5. Source HTML page `GET → 200` with `Set-Cookie` present; sequence
   `media-404 → page-200 → media-404` proves an ordinary page GET alone does
   not establish access.
6. Page scanner found ~188 KB HTML with ~24 `vidthumb.mp4` URLs (thumbnails,
   not the `.vid` media) plus external JS references.
7. DevTools: `.vid 302` then `.vid 206` without pressing Play; extension
   detected media on page load (suggests page-load init / redirect chain —
   does not identify which request enables it).
8. Prior "206 success" trace was `206 text/html`, `Content-Range:
   bytes 0-1023/30862`, host = page origin — **a ranged HTML page, not video**
   (see §4).
9. Xtreme Download Manager with browser-like headers + Referer reportedly
   succeeded once — uncontrolled comparison.
10. `9drive-relay-v1` route affinity holds (worker-selected jobs never fall
    back); verified in code (`secure-fetcher.ts`, `transport.ts`) and in
    `vps-route-isolation` / `route-isolation` tests.

### 1b. Newly reproduced (this session, offline, deterministic)

New harness: `backend/diagnostics/http-only-relay/media-probe.mjs`
(dependency-free, Node 20 built-ins only) plus
`media-probe.test.mjs` (`node --test`, 11/11 green on Node v24.16.0):

| Mocked case | Setup | Result |
| --- | --- | --- |
| Genuine media 206 | `206 video/mp4`, `Content-Range: bytes 0-1023/5000`, `ftyp` at offset 4 | `verdict: media, magic: mp4-ftyp` |
| **HTML 206 trap** | `206 text/html`, `Content-Range: bytes 0-1023/30862` (mirrors evidence #8) | `verdict: html`, never media |
| Upstream 404 | `404 text/html` | Preserved as `final.status: 404`, not thrown |
| Redirect chain | `302 /redirect?token=… → /final.vid?token=…` | 2 hops traced, query shape preserved, `redirectCount: 1` |
| 302 without Location | bare `302` | `error.stage: redirect-without-location`, clean |
| 416 | `416` for ranged probe | `final.status: 416`, clean |
| Range-ignoring origin | `200` despite `Range` | `rangeIgnored: true`, still media-classified via magic |
| Opaque `.vid`, no magic | `application/octet-stream`, no `ftyp` | `verdict: unknown` — `.vid` alone never proof |
| Empty input | no `MEDIA_URL` | `failureStage: input`, exit 2, zero requests |
| SSRF literal gate | loopback / `http:` / `https:` matrix | Blocked unless explicitly allowed for mocked tests |
| Redaction | secret query values | No secret appears in fingerprint / shape / report |

CLI smoke: empty env prints the input-stage JSON and exits `2`.

**Not yet reproduced** (requires operator-supplied fresh URLs + VPS access):
Experiments A–E against the live source from (A) VPS container vs (B)
local/Direct in the same time window.

## 2. Redacted test matrix (live — awaiting operator runs)

Run the identical command on both egresses within minutes, with a freshly
captured URL (see harness README for copy-paste commands):

```sh
PAGE_URL='<page>' MEDIA_URL='<media>' REFERER_URL='<page>' node media-probe.mjs
```

| Exp. | VPS result (paste `final.status / contentType / verdict / finalFp / finalHost`) | Local result | Same `finalFp`? | Interpretation |
| --- | --- | --- | --- | --- |
| B: initial-302 URL probe | _pending_ | _pending_ | _pending_ | Distinguishes redirect-hop failure from terminal-404 |
| B: final-media URL probe | _pending_ | _pending_ | _pending_ | Same-fingerprint 206-vs-404 isolates egress policy from stale URL |
| C: `media-no-referer` vs `media-with-referer` | _pending_ | _pending_ | — | Single-variable Referer test; `Sec-Fetch-*` values recorded, never spoofed as proof |
| D: before/after page-warmup | _pending_ | — | — | `404 → 206` must repeat on a **second fresh URL** with a no-warmup control, else unsupported |
| E: same-fingerprint VPS-vs-local | _pending_ | _pending_ | _pending_ | Local-206 + VPS-404 with identical request → source-side egress policy (reported, never circumvented) |

Header names sent by the harness (values never logged):
`user-agent, accept, accept-encoding, range` (+ `referer` only in the
with-referer run, stripped on cross-host redirects).

## 3. Root-cause classification (decision tree)

**Current verdict: (7) Inconclusive with exact next evidence needed —**
bounded to three surviving hypotheses:

- **(2) URL freshness / identity mismatch** — still viable: no controlled
  same-fingerprint comparison exists, and the observed `302 → 206` chain
  means a stale pre-redirect URL is a plausible (not proven) failure mode.
- **(3) Incomplete request context** — still viable: exactly one uncontrolled
  success (XDM + Referer) exists; no single-header differential has been
  reproduced.
- **(5) Upstream network-policy difference (cloud/datacenter egress)** —
  still viable: native VPS `fetch()` 404 keeps this on the table, but it is
  **not proven** (freshness/context were uncontrolled in that observation).

**Ruled out / demoted by evidence:**

- **(1) Wrong resource** — demoted for the *relay path* (probe uses the
  captured URL, thumbnail confusion was a scanner artifact), but remains the
  explanation for the old HTML-206 trace (see §4).
- **(4) Redirect propagation defect** — demoted: relay follows redirects
  server-side (max 5) and reports `finalUrl`; envelope/streaming tests prove
  404/206/status/header preservation. Revisit only if live traces show a
  `finalFp` mismatch between relay-reported and directly-probed finals.
- **(6) VPS relay implementation defect** — demoted as the *sole* cause:
  native VPS `fetch()` (no relay code involved) also saw 404. A relay-only
  defect would require native-206 + relay-404 on the same fingerprint, which
  has not been observed. Revisit only on that differential.

No hypothesis meets the "reproducible differential test" bar, so no root
cause is marked confirmed.

## 4. Why the old `206 text/html` is not a video success

The trace showed `206`, `text/html`, `Content-Range: bytes 0-1023/30862`,
host = page origin. That is a web server honoring `Range` against an **HTML
document** (30,862 bytes total), returning its first 1,024 bytes. The status
`206` describes range semantics, not content semantics. Media validation
requires all of: media `content-type` (or a magic number: `ftyp`/`EBML`/…),
a plausible `Content-Range` against a media-sized total, a final host on
the media origin, and non-HTML bytes. The harness encodes this: that exact
shape classifies as `verdict: html` (mocked test `HTML 206 trap`, green).
Any automation that treats "status 206" alone as success will false-positive
on every ranged page fetch.

## 5. HTTP-only hypotheses: status

| Hypothesis | Status | Why |
| --- | --- | --- |
| Fresh-URL + redirect-hop tracing resolves it | **Open, elevated** — static census of 117 page URLs found 0 `.vid` (23 thumbs only); the DevTools `302 → 206` media URL must be minted per page load (JS-generated), so any non-fresh URL is invalid by construction; decisive A/B still needs operator URLs |
| Single observed header (`Referer`) flips 404→206 | **Open** — harness runs the exact A/B, live run pending | XDM lead is uncontrolled; `Sec-Fetch-*` noted but not relied on |
| HTTP-only page warmup (`GET` page → media 206) | **Unsupported so far** | Prior `404 → page-200 → 404` sequence counts against it; page sets `PHPSESSID` but the stale-URL caveat voids that test; needs fresh-URL repeat + control |
| Egress-policy difference | **Open, refined** — blanket blocking of the media-origin family is REFUTED for unsigned assets (sandbox → `b3.trafficdeposit.com` thumb `206 media`), so a VPS 404 on `.vid` cannot be read as family-wide IP blocking; per-URL origin policy or URL freshness remains; VPS leg still untested |
| Static HTML yields full-media `.vid` (Exp 1) | **Closed (negative)** — two bounded page fetches (`~185 KB`, full window, absolute + protocol-relative + page-relative census) found 0 `.vid` / 0 other media; marked not-reproducible-HTTP-only per mission rule |
| Relay serialization bug (path/query/method/headers) | **Closed** (regression-covered) | `relay-404-diagnostics.test.ts` proves verbatim preservation; harness re-verifies end-to-end once live |
| Speculative blanket headers / proxy rotation / TLS spoofing / JS execution | **Rejected** | Prohibited by the mission (no bypasses, no `eval`/`vm`, no guessed headers) |

## 6. Next step (precise, permitted)

1. Operator captures a **fresh** `.vid` 302 + final 206 pair in DevTools
   (URLs stay local; only hosts + the knowledge "302 then 206" are shared).
2. Within minutes, run the harness command from §2 on the **VPS container**
   (`/tmp/probe-vps.json`) and on **local/Direct** (`probe-local.json`)
   against the **same** `MEDIA_URL` (+ `REFERER_URL` = page URL).
3. Paste both JSON files back. Decision from that pair:
   - Same `finalFp`, local-206/media + VPS-404 → report (5) as the
     restriction; **no workaround implemented** (policy respected).
   - Different `finalFp` or both-404 → re-capture freshness / redirect-chain
     handling (2)/(4); no code change until a differential reproduces.
   - VPS `media-no-referer` 404 → `media-with-referer` 206/media, repeated on
     a second fresh URL → minimal generic fix becomes eligible (forward the
     exact captured `Referer` through the existing request-context path —
     no new headers, no domain hardcoding).
   - VPS native-206 + relay-404 on the same fingerprint → relay-construction
     bug (6); debug `cloudflare-transport.ts` payload vs `server.js`
     `buildUpstreamHeaders` with `traceId`-joined logs.

## 7. Files changed / tests run / deployment notes

- Added `backend/diagnostics/http-only-relay/media-probe.mjs` (harness).
- Added `backend/diagnostics/http-only-relay/media-probe.test.mjs`
  (`node --test`: 11/11 pass).
- Added `backend/diagnostics/http-only-relay/page-scan.mjs` (V2 Experiment 1
  static-discovery + bounded candidate/thumb probes; verified offline via a
  throwaway mock harness: empty→exit 2, discovery, `--probe 1`→media/exit 0,
  `--page-file` extraction, redaction holds).
- Added `backend/diagnostics/http-only-relay/README.md` (operator runbook;
  V2: documents `page-scan.mjs`).
- `cleanExit()` settle-then-exit guard in both diagnostic CLIs (fixes a
  Windows-only libuv `UV_HANDLE_CLOSING` assertion when exiting immediately
  after a fetch; report output unaffected; Linux/VPS behavior unchanged).
- Added this report (`reports/9drive-http-only-relay-investigation.md`).
- **No** 9Drive product code changed (Phase 4 gate not met — correct per
  the mission: do not invent a workaround for an unproven cause).
- Backend `npm run build` / existing suite untouched by these additions
  (new files live outside `backend/src`, so `tsc` scoping is unaffected).
- Deployment: none required. Operator action: run the §2/§8 probes and return
  the redacted JSON reports.

## 8. V2 live-diagnosis addendum (2026-10-14) — blocked on egress A/B

### 8a. Prior attempt (pre-existing text, not re-verified this session)

Supplied `PAGE_URL` (redacted): host `sxyprn.com`, `urlFp` `6228a88d11f2`
(`sha256/12` of canonical href; full URL never recorded in reports/logs).

Prior status reused: 11/11 mocked harness tests green (re-verified this
session on Node v24.16.0); no simultaneous fresh same-URL VPS-vs-Direct
comparison exists; hypotheses (2) freshness, (3) request context, (5)
egress policy remain open; (4)/(6) demoted; HTML-206 trap stands.

Experiment 1 (agent sandbox only — NOT VPS, NOT Direct, not decisive):
bounded `GET` of `PAGE_URL` from the coding-agent sandbox returned HTML
`200 text/html`, `Set-Cookie` present, ~188 KB, 24× `vidthumb.mp4`, 35×
`<script`, 0× `<source>`, 0 directly fetchable `https://…​.vid` media URLs
(single `.vid` substring is markup-bound, not a full media URL). Player
hints: 56× `player`, 0× `jwplayer/videojs`, 0× `m3u8`, 0× `/api`.
Conclusion: static HTML alone yields no usable media URL; a fresh
browser-observed `.vid` 302 + final 206 pair (DevTools/extension) is still
required. Thumbnails are not media. No JS was executed.

Ledger (this session):

| Exp | Env (UTC 2026-10-14) | `urlFp` | Hop/final status | Verdict | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Harness green-check | agent sandbox | — | 11/11 pass | — | Harness valid, no live signal |
| Exp 1 page scan | agent sandbox (≠ VPS/Direct egress) | `6228a88d11f2` | page `200 text/html`, `Set-Cookie` yes | `html` | No extractable media URL; need fresh captured `.vid` pair |

Live egress A/B (Exp 2, highest priority) — **pending operator runs**:

| Exp | VPS result (`final.status / verdict / finalFp`) | Direct result | Same `finalFp`? | Interpretation |
| --- | --- | --- | --- | --- |
| B: initial-302 URL probe | _pending_ | _pending_ | _pending_ | Redirect-hop vs terminal-404 |
| B: final-media URL probe | _pending_ | _pending_ | _pending_ | Same-fingerprint 206-vs-404 isolates egress policy |

### 8b. Live runs this session (verified, redacted — agent sandbox egress)

Egress label: coding-agent sandbox (Windows dev machine, Node v24.16.0).
This is a **third egress: NOT the VPS relay container, NOT production
Direct**. Results below are real but cannot substitute the Exp 2 A/B.

Page fingerprint reproduced independently: host `sxyprn.com`,
`urlFp 6228a88d11f2`, `pathLen 24`, `queryKeys sk+so+ss` — matches §8a, so
both passes tested the same canonical page URL.

| Exp (UTC 2026-10-14) | Requests | Hop/final status | Verdict | Conclusion |
| --- | --- | --- | --- | --- |
| Exp 1 page scan, 06:59:38Z, 639 ms | 1 | page `200 text/html; charset=UTF-8`, no redirects, `Set-Cookie: PHPSESSID` (1 name only), `~185.9 KB` full window (not truncated) | `html` | Baseline OK; session cookie present |
| Exp 1 census (absolute URLs), same run | 0 | 65 URLs: 0 `.vid`, 0 thumbs, 0 other media | — | Absolute-URL census is barren |
| Exp 1 census (absolute + protocol-relative + page-relative), 07:00:06Z, 426 ms | 0 | 117 URLs: **0 `.vid`**, **0 other media**, **23 `vidthumb.mp4`** on `b1/b2/b3.trafficdeposit.com` (`pathLen` 88–89, no query), 4 same-host + ad/tracker script hosts, 18 inline scripts, empty player-key census | — | Full-media URL is not in static HTML in any URL shape → JS-minted per page load; marked **not reproducible with HTML-only fetch** (mission rule, no parser invented) |
| Thumb reachability, ~07:01Z | 1 | `b3.trafficdeposit.com` thumb: **`206 video/mp4`, `Content-Range: bytes 0-1023/524556`, `mp4-ftyp`, 0 redirects**, Cloudflare-fronted (`cf-ray`) | `media` (kind `thumb` — reachability only, never full-media proof) | Media-origin family serves unsigned static assets to a non-VPS egress → a VPS 404 on `.vid` cannot be read as family-wide IP blocking; per-URL origin policy or URL freshness remains |

Total live footprint this session: 3 page/thumb requests, all bounded
(`Range: bytes=0-1023` on probes, 256 KiB window on pages), no retries, no
JS executed, no credentials sent, no secrets recorded.

Hypothesis deltas from §8b (see also §5): (2) freshness **elevated** —
every page load must mint its `.vid` URL via JS, so only a freshly captured
pair is a valid test input; (5) blanket-egress-blocking **refuted** for
unsigned assets, per-URL policy still open; Exp 1 static discovery **closed
(negative)**; (3) context and (4)/(6) unchanged (still open / demoted).

Blocker: this agent has no VPS-relay-container or production-Direct
console access, so Experiments 2–5 cannot be executed from here. No product
code changed in V2 (gate not met). Next step is exactly one operator action
(details below): fresh DevTools capture + the two copy-paste probe runs,
then paste back both redacted JSON files for the decision gate.
