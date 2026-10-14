# HTTP-only media probe — VPS relay diagnosis harness

Dependency-free Node.js 20 tool for the 9Drive HTTP-only VPS relay
root-cause investigation. No npm packages, no browser runtime, no `eval`/`vm`,
no full-video fetches. Safe to paste into the non-root Alpine VPS container —
it needs only `node`.

Files:

- `media-probe.mjs` — the harness (executable, `node media-probe.mjs`).
- `media-probe.test.mjs` — offline mocked tests (`node --test`).
- `page-scan.mjs` — Experiment 1 static page discovery + bounded
  candidate/thumb probes (standalone, single-file copy to `/tmp`).

Both CLIs settle briefly before exiting (clean exit codes on Windows and
Linux; report output is flushed first).

## Quick start (local)

```sh
cd backend/diagnostics/http-only-relay
node --test media-probe.test.mjs   # offline first — must be green before any live URL
```

## Live probe (same fresh URL, close time window)

```sh
PAGE_URL='https://<page-host>/<redacted-path>' \
MEDIA_URL='https://<cdn-host>/<redacted-path>' \
REFERER_URL='https://<page-host>/<redacted-path>' \
node media-probe.mjs > probe-vps.json
```

Run the identical command from (A) the VPS container and (B) the
known-working local/Direct environment, within minutes of each other, using a
**freshly captured** media URL. Compare `probe-vps.json` against
`probe-local.json` — never paste full URLs, cookies, or bodies into chat;
the JSON report is already redacted (hosts, truncated URL fingerprints,
header names only).

Optional tuning (all bounded):

| Var | Default | Max | Notes |
| --- | ------- | --- | ----- |
| `DIAG_TIMEOUT_MS` | 15000 | 30000 | per-request timeout |
| `DIAG_MAX_REDIRECTS` | 4 | 5 | manual-redirect hops |
| `DIAG_PROBE_BYTES` | 1024 | 4096 | `Range: bytes=0-N` + body read cap |
| `DIAG_MAX_REQUESTS` | 10 | 20 | total-request budget |
| `DIAG_ALLOW_HTTP` | off | — | `1` ONLY for local mocked tests |
| `DIAG_ALLOW_PRIVATE` | off | — | `1` ONLY for local mocked tests |

## VPS container copy-paste

The container has no `curl`/`docker` and runs non-root. Copy the single file
`media-probe.mjs` into the container (hosting-panel file upload or
equivalent), then:

```sh
node --version   # expect v20.x
node media-probe.mjs   # no env -> prints input-stage JSON, exit 2 (gate check)
PAGE_URL='...' MEDIA_URL='...' REFERER_URL='...' node media-probe.mjs > /tmp/probe-vps.json; echo "exit=$?"
cat /tmp/probe-vps.json
```

Paste back **only** the JSON file content (it contains no secrets).

## Page scan (Experiment 1 — find what static HTML actually yields)

```sh
node page-scan.mjs --page-file /tmp/page-input.md --probe 2 --probe-thumbs 1 > /tmp/scan.json; echo "exit=$?"
```

- `--page-file <path>` reads the first `PAGE_URL=<value>` line so the
  sensitive URL never appears in shell history (`PAGE_URL` env works too).
- `--probe N` (max 3) bounded-probes observed non-thumbnail `.vid`/media
  candidates with `Range: bytes=0-1023`. Thumbnails are never probed here.
- `--probe-thumbs N` (max 2) probes observed thumbnails as a reachability
  census only — a thumb `206` is reported as `thumb-only`, never as media
  proof.
- Static census covers absolute, protocol-relative, and page-relative URL
  shapes (generic shapes, no site-specific parsing, no JS execution).
  Exit `0` = media proved, `1` = discovery/candidate outcome, `2` = input.

## What it does (one variable at a time)

1. `media-no-referer` — bounded `GET` with `Range: bytes=0-N`, no `Referer`
   (explicit baseline). Manual redirect trace, hop-by-hop.
2. `media-with-referer` — identical request plus `Referer: <REFERER_URL>`
   (single-variable change; skipped when `REFERER_URL` is empty).
3. `page-warmup` — bounded `GET` of `PAGE_URL` (cookie *presence* only,
   never values; thumbnail vs media URLs are not confused).

Redirect policy: `Referer` is stripped when leaving the initial host
(origin boundary). `Cookie`, `Authorization`, HMAC secrets, and relay
credentials are never sent upstream.

## Reading the verdict

- `mediaValidation.verdict: "media"` with status `206` and
  `magic: mp4-ftyp | webm-ebml | …` — genuine media bytes in the bounded
  prefix. This is the only success signal.
- `verdict: "html"` with status `206` — **a ranged HTML page, not video**
  (the known `bytes 0-1023/30862` + `text/html` trap). Never treat as success.
- `verdict: "unknown"` — no media signal in the prefix (opaque `.vid`
  without magic, empty body, or plain-text error page).
- `final.status: 404` — the upstream source answered 404 for this exact
  request (compare `finalFp` + `finalHost` across environments before
  concluding anything about IP policy vs stale URL).
- `final.status: 416` — the `bytes=0-N` range was rejected; retry semantics
  differ per origin and are reported, not retried blindly.
- `error.stage: redirect-without-location | too-many-redirects |
  ssrf-gate | fetch-exception` — the failure hop, never the body.

Exit codes: `0` = media proved; `1` = classified non-media outcome;
`2` = input/SSRF-gate failure (nothing was fetched).

## Safety contract

- `https` only (mocked `http://127.0.0.1` requires explicit opt-in flags).
- Literal-IP/hostname blocklist mirrors the VPS relay; DNS-rebinding
  enforcement stays at the relay edge — DNS/TLS failures are reported as
  evidence (`fetch-exception`), not retried.
- Max 5 redirect hops, max 20 total requests, max 4 KiB body reads.
- Report redaction: full-URL `sha256/12` fingerprints, hosts, path length,
  query **names** only, header **names** only, magic-number labels.
