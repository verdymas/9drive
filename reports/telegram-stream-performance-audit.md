# 9Drive — Telegram Stream Performance Audit

Date: 2026-10-18
Status: measurement-backed audit on a live local deployment; remote/VPS and real-player numbers are explicitly `PENDING`
Author: performance audit session (code inspection + live measurement)
Companion documents: `plans/telegram-stream-optimization-roadmap.md`, `plans/telegram-stream-benchmark-runbook.md`

Privacy note: this report contains no filenames, message IDs, channel IDs, account IDs, session strings, or tokens.
All file references are size labels ("small", "mid", "large"). Telegram infrastructure details are limited to the data center region.

---

## 0. Scope, method, environment

### 0.1 What was audited

`telegram-stream` = the Python FastAPI service (`services/telegram-stream/`) plus the two backend proxy paths that feed it
(REST `TelegramStreamGateway` and the WebDAV readable path), for three goals: faster initial playback, higher sustained
throughput, lower seek latency — including Jellyfin/Plex-compatible HTTP Range playback.

No production code was modified. The only files this audit produced are this report and two plan documents.

### 0.2 Environment

| Item | Value |
|---|---|
| Date/time of measurement | 2026-10-18, ~05:47–05:59 UTC |
| Deployment | Local `docker compose` stack (MySQL, backend, redis, telegram-stream, frontend, workers) |
| Host | Windows dev machine, 20 CPUs, ~15.5 GiB RAM, Docker Desktop (WSL2) |
| Client | `curl 8.17.0` on the same host — only the backend→Telegram hop crosses the WAN |
| telegram-stream | `python:3.11-slim`, uvicorn **single worker** (`services/telegram-stream/Dockerfile:17-19`), Telethon **1.45.0**, cryptg 0.4.0, `mem_limit: 512m`, no CPU limit (`docker-compose.yml:196-223`) |
| Backend | Node/Express, no container memory or CPU limit |
| Telegram DC | DC5 (Singapore); account home DC and test-document DC both = 5. RPC RTT samples (6): 42.4, 42.1, 83.0, 80.2, 54.6, 143.4 ms → median **67 ms**, max sample 143 ms; TCP+handshake connect 237 ms |
| Test data | Authorized account: 1 connected Telegram account, 49 files. Buckets used: **small 10.77 MB**, **mid 270.9 MB**, **large 1.24 GB** (no ~2 GB file exists → `PENDING`) |

### 0.3 Safety and honesty rules applied

- Budget: ~800 MB total transferred, ≤4 concurrent readers, ≤3 repeats of any heavy range; never more than 4 in flight.
- Waited for idle (`active_streams == 0`) between blocks; stopped criteria: any FloodWait event. **Zero FloodWait observed across 32 stream bodies plus 1 pre-stream rejection** (`total_flood_waits: 0`).
- All numbers below come from actual command output captured during this session. Anything not measured is marked `PENDING` with the operator command in the runbook. No numbers are estimated unless explicitly labeled "derived".
- The one initially connected Telegram session was revoked at audit start (`TELEGRAM_REAUTH_REQUIRED`, HTTP 503). It was re-authenticated by the operator before measurement, which gave a bonus cold-start data point (§3.5).

### 0.4 Workloads exercised

Cold open, warm sequential stream, unaligned/aligned seeks, suffix range, last-byte range, unsatisfiable and malformed
ranges, repeated seek, 2/4 concurrent readers, cancellation mid-stream, plus a direct DC RTT probe and resource sampling.

---

## 1. Architecture (verified against current code)

### 1.1 Request path

```
Playback client (browser / Jellyfin+rclone / public share)
  │  GET /files/:id/download | /files/preview/:token | /public/files/:token/... | WebDAV GET
  ▼
Backend (Express; control plane or media plane)
  backend/src/modules/files/stream-file.ts:13-31          ← provider dispatch
  ├─ REST:  backend/src/modules/telegram/telegram-stream-gateway.ts:59-175
  └─ WebDAV: backend/src/modules/webdav/webdav-virtual-fs.ts:521-539
              → telegram-stream-readable.ts (fetch + Readable.fromWeb)
  │  HMAC-signed GET /v1/stream?providerId&channelId&messageId&knownSize, `Range` forwarded verbatim
  ▼
telegram-stream (FastAPI, single uvicorn worker)
  app/api/stream.py:129-196      ← parse single range, resolve BEFORE committing status
  app/api/stream.py:86-126       ← _body: metrics/cancel accounting
  app/telegram/engine.py:142-165 ← resolve_document (client cache + 60 s location cache)
  app/telegram/engine.py:168-233 ← iter_bytes: align → iter_download → emit exactly `length` bytes
  ▼
Telethon 1.45.0 (client cached per provider in-process)
  iter_download → one upload.getFile per 512 KiB (MAX_CHUNK_SIZE = 524288, MIN = 4096)
  ▼
Telegram MTProto (DC5 Singapore for this account)
```

### 1.2 Buffering / concurrency / range annotation

| Point | Behavior | Reference |
|---|---|---|
| Backend REST proxy | No buffering on success; `Readable.fromWeb` + `pipe`; abort-on-client-close; no timeouts/retries; only non-2xx bodies buffered | `telegram-stream-gateway.ts:102-105,109,121-139,168-174` |
| Backend WebDAV path | Same shape: fetch, whitelist `content-range/content-length/accept-ranges`, `Readable.fromWeb`, abort on close | `telegram-stream-readable.ts:67-95` |
| Backend Range posture | Telegram ranges are **opaque** — forwarded verbatim and HMAC-bound | `telegram-stream-gateway.ts:100`; `webdav.routes.ts:78-85` |
| Stream service Range | Single-range only; suffix + open-ended + 416 semantics | `stream.py:45-83` |
| Upstream alignment | HTTP start untouched; **upstream** start floored to `request_size` (default 512 KiB, clamped [4 KiB, 512 KiB]); prefix discarded | `engine.py:187-191,200-210` |
| In-flight upstream requests | **Exactly one per stream, no prefetch** (deliberate; documented upgrade path) | `engine.py:17-21,193-199` |
| Client reuse | One Telethon client per provider, cached in-process, reused across requests; lazy reconnect only when disconnected | `client_manager.py:81-108` |
| Metadata cache | Resolved document location cached 60 s per (provider, channel, message) | `file_resolver.py:37-55` |
| Cancellation | Starlette cancels generator on client close → `iter_bytes` finally closes the download iterator | `stream.py:102-126`; `engine.py:218-227` |
| Integrity guard | Never silently truncates: `SHORT_READ` tears the connection if fewer bytes arrive | `engine.py:228-233` |

### 1.3 Telethon semantics (verified in the running container, not assumed)

- `telethon.__version__ == 1.45.0`; `MAX_CHUNK_SIZE = 524288`, `MIN_CHUNK_SIZE = 4096`.
- `iter_download` selects `_DirectDownloadIter` only when `chunk_size == request_size && offset % 4096 == 0 && (limit is None || offset % limit == 0)`, where `limit = ceil(file_size / chunk_size)` because the engine passes `file_size`. **With the engine's 512 KiB alignment, all non-zero seek offsets on the large file select `_GenericDownloadIter`.**
- `_GenericDownloadIter` re-fetch analysis (installed source): `bad = offset % request_size`. Because the engine pre-aligns to 512 KiB, `bad == 0`, so the generic iterator issues the **same single 512 KiB request per chunk** as the direct iterator. Wire behavior is identical for this engine; only marginal Python-side bookkeeping differs. **The generic/direct split is not a performance factor for the current caller** (confirmed by measurement, §4.1).

---

## 2. Test matrix actually executed

| Block | Requests | Ranges/usage | Volume |
|---|---|---|---|
| 1. Sequential | 5 | cold full small (first stream after reconnect), 3× warm full small, full mid | ~314 MB |
| 2. Seeks | 11 | first 1 MiB; aligned 32 KiB at 1 MiB; unaligned 32 KiB at 1,000,000 (prefix 475,712 B); Jellyfin-style `bytes=41639936-75194367` (33.55 MiB) ×3; suffix last 256 KiB; last byte; out-of-range 416; malformed 416; open-ended tail of mid | ~104 MB |
| 3. Probes | 6 | 32 KiB at offset 0 (direct) vs 1 MiB (generic), alternating ×3 each | ~1.5 MB |
| 4. Concurrency | 6 | 2×16 MiB; 4×16 MiB (same large file, disjoint ranges) | ~96 MB |
| 5. Cancellation | 1 | 64 MiB range aborted after 1.5 s | partial |
| 6. Sampling | 1 | 64 MiB single stream, 1 s `docker stats` sampling | ~64 MB |
| 7. Concurrency RSS | 4 | 4×32 MiB, 1 s `docker stats` sampling | ~128 MB |
| Offline | — | pytest suite in isolated `python:3.11-slim` container | — |

---

## 3. Measured baselines

### 3.1 Time to first byte (service-side `ttfb_ms`, n=32 streams)

| Metric | Value |
|---|---|
| min | 99 ms |
| p50 | 169 ms |
| p90 | 392 ms |
| max | 3190 ms (single upstream stall; repeated probes of the same offset later gave 132–231 ms) |
| Cold first stream (post-reconnect; includes credentials HTTP fetch + MTProto connect + resolve) | 671 ms |
| Backend hop overhead (curl `time_starttransfer` − service `ttfb_ms`) | 8–17 ms |

Median warm TTFB ≈ 169 ms against a median DC RTT of ~67 ms: **first byte costs roughly one `upload.getFile` round trip
(RTT + transfer of the first 512 KiB)**. Cold start adds ~500 ms of setup (credentials fetch + connect + resolve).

### 3.2 Sustained goodput

| Workload | Duration | Service avg | Note |
|---|---|---|---|
| Full mid file, 258 MiB | 143.3 s | **15.1 Mbps (1.80 MiB/s)** | 517 chunks, zero errors |
| Full small file, warm bursts | 2.7–8.1 s | 10.7 – 31.5 Mbps | 3× variance between identical back-to-back runs |
| Jellyfin-style 33.55 MiB range | 7.6–15.8 s | 17.0, 17.0, 35.4 Mbps | 2× variance; same bytes each time |
| 64 MiB range | 29.4 s | 18.3 Mbps (2.18 MiB/s) | — |
| 2 concurrent × 16 MiB | 13.6 s wall | 9.9–10.2 Mbps per stream; **2.35 MiB/s aggregate** | TTFB 131/183 ms |
| 4 concurrent × 16 MiB | 15.7 s wall | 8.6–8.9 Mbps per stream; **4.09 MiB/s aggregate** | 2.27× the single-stream sustained rate |
| 4 concurrent × 32 MiB | 43.2 s wall | 6.2–6.3 Mbps per stream; 2.96 MiB/s aggregate | slower phase — upstream pacing variance |

`avg_mbps` is measured over the bytes actually emitted; chunk counts were exactly `ceil((prefix + length) / 512 KiB)` in
every run — i.e., every chunk is one 512 KiB `upload.getFile`.

### 3.3 Seek latency (206 responses, all byte-exact)

| Request | Service TTFB | Total | Bytes |
|---|---|---|---|
| `bytes=0-1048575` (aligned 1 MiB) | 347 ms | 518 ms | 1,048,576 (2 chunks) |
| 32 KiB at 1,000,000 (prefix 475,712 B discarded) | 159 ms | 159 ms | 32,704 |
| 32 KiB at 1048576 (aligned, generic iterator) | 143 / 136 / 231 ms | — | 32,768 |
| Jellyfin-style 33.55 MiB ×3 | 197 / 113 / 130 ms | 15.7 / 15.8 / 7.6 s | 33,554,432 |
| suffix last 256 KiB | 111 ms | 111 ms | 262,144 |
| last byte `bytes=1242834323-1242834323` | 99 ms | 99 ms | 1 |
| open-ended tail of mid (1.9 MB) | 209 ms | 613 ms | 1,906,418 |

Median seek TTFB (~120–200 ms) is one upstream round trip. The Jellyfin `LimitInvalidError` class of failure did **not**
recur at any tested boundary (0, 4096, 512 KiB, 1 MiB, arbitrary unaligned, suffix, last byte).

### 3.4 Range semantics and error handling

| Case | Observed |
|---|---|
| All 206 responses | Exact `Content-Length`, exact byte counts, `Content-Range` correct |
| Unsatisfiable (`start >= size`) | 416 in 10 ms, JSON error body |
| Malformed (`Range: bytes=foo`) | 416 in 18 ms, JSON error body |
| `SHORT_READ` / truncation / layer mismatch | 0 occurrences in 32 stream bodies |
| **Defect found:** 416 at the backend boundary | Upstream (`app/main.py:29-38`) sets `Content-Range: bytes */{total}`, but the gateway's non-2xx path (`telegram-stream-gateway.ts:122-139`) forwards only `Content-Type` + body — **the 416 the client sees has no `Content-Range` header** |

### 3.5 Cancellation

Aborted a 64 MiB range with `curl --max-time 1.5` after 4.47 MB (9 chunks). Service logged `cancelled=true`,
`total_cancellations` went to 1, and `active_streams` returned to 0 within ~3 s. No orphaned Telegram fetch observed.

### 3.6 Resources

| Sample point | telegram-stream | backend |
|---|---|---|
| Idle | 59.6 MiB RSS | 127 MiB RSS |
| Single 64 MiB stream | 104.7–106.5 MiB RSS; CPU bursts ≤ 15.5% | 164–179 MiB; CPU ≤ 13.9% |
| 4 concurrent 32 MiB streams | 104.1–104.7 MiB RSS (flat); CPU ≤ 12.4% sampled | — |

`mem_limit: 512m` was never approached; single-worker uvicorn was never saturated at 4 streams. **Peak RSS beyond 4
concurrent streams and on a VPS-sized host: `PENDING`.**

### 3.7 DC RTT and the throughput envelope

Direct in-container probe (reusing the production credential path, no code changes): connect 237 ms; home/document DC = 5
(Singapore); RPC RTT median 67 ms (max sample 143 ms).

Derived envelope (labeled as derived): one 512 KiB request per RTT ⇒ best-case single-stream `524288 / 0.067 ≈ 7.6 MiB/s`,
degrading to ~3.6 MiB/s at 143 ms RTT. Measured single-stream sustained is **1.80 MiB/s** — below the RTT-only envelope,
so Telegram applies additional per-connection/pacing effects, visible as the 2–3× run-to-run variance (10.7↔31.5 Mbps,
17.0↔35.4 Mbps). Independent concurrent streams still lift aggregate throughput to 4.09 MiB/s (4×16 MiB), i.e. the
upstream does grant parallelism — the current engine just never uses more than one in-flight request per stream.

### 3.8 Offline correctness suite

`pytest` in an isolated `python:3.11-slim` container against the shipped source: **55 passed, 1 warning in 1.68 s**
(stream contract, engine byte-math incl. Jellyfin offset, auth/HMAC parity, resolver, client manager, redaction).
These tests are the regression net for any optimization.

---

## 4. Hypothesis assessment (Phase 2 list + new leads)

| # | Hypothesis | Status | Evidence |
|---|---|---|---|
| 1 | MTProto connection setup repeated per request | **REJECTED** | Per-provider client cache (`client_manager.py:81-108`); only the first stream after reconnect paid setup (TTFB 671 ms vs 99–169 ms warm) |
| 2 | Offset/limit alignment problems, `LimitInvalidError`, 1 MiB boundaries | **REJECTED as defect; SUPPORTED as bounded cost** | 32 stream bodies, zero body errors; alignment math verified and unit-tested; cost = prefix discard ≤ 512 KiB per unaligned seek (measured 475,712 B for one probe) |
| 3 | Sequential vs bounded concurrent/prefetch chunk fetching | **SUPPORTED (parallelism helps); single-stream prefetch A/B `PENDING`** | One in-flight request per stream (`engine.py:17-21`); 4 independent concurrent streams → 4.09 MiB/s aggregate vs 1.80 MiB/s single-stream sustained (2.27×); no FloodWait |
| 4 | Inefficient block sizes across the chain | **REJECTED for throughput; minor waste for tiny probes** | 512 KiB buffered end-to-end (chunk counts prove it); a 32 KiB probe still consumes one 512 KiB upstream request by design — bounded, not a throughput issue |
| 5 | Backpressure / cancellation / stalled-client handling | **SUPPORTED as working** | Cancellation measured clean (§3.5); one natural 3.19 s upstream stall surfaced as high TTFB (not a hang); no orphan fetch (`active_streams` 0) |
| 6 | Backend double buffering / proxy overhead | **REJECTED** | Success path streams directly (`Readable.fromWeb` + pipe); measured hop overhead 8–17 ms; throughput matches service-side numbers |
| 7 | Metadata/session/decrypt overhead on the hot path | **PARTIALLY SUPPORTED (mechanism), magnitude `PENDING`** | Resolve cached 60 s (`file_resolver.py:38`); cache miss = 2 RPCs (`get_input_entity` + `get_messages`, `:60-77`); cold stream 671 ms vs warm ~150 ms; no isolated resolve-timing instrumentation yet |
| 8 | Python asyncio/worker contention | **REJECTED at tested load** | RSS flat 104–107 MiB; CPU ≤ ~15% per stream, ≤ 12.4% sampled at 4 streams; single worker sufficient for ≥4 streams locally |
| 9 | Docker CPU/memory quotas, host↔DC latency | **REJECTED locally; `PENDING` on VPS** | No CPU limit; memory far under 512 MiB; DC RTT 67 ms median — the dominant physical term |
| 10 | Media seek patterns (Jellyfin probes, speculative ranges) | **SUPPORTED** | Jellyfin-style unaligned 33.5 MiB range works (TTFB 113–197 ms); tiny probes pay a full 512 KiB fetch + one RTT; suffix/last-byte seeks are cheap (99–111 ms) |
| 11 | *New lead:* `_GenericDownloadIter` fallback for non-zero offsets | **REJECTED as a factor** | Installed 1.45.0 source: `bad = offset % request_size` = 0 after engine alignment ⇒ identical wire behavior; probes at offset 0 (direct) vs 1 MiB (generic): 210/137/132 ms vs 143/136/231 ms — indistinguishable |
| 12 | *New lead:* mid-stream `file_reference` expiry not self-healed (`msg_data` not passed) | **UNTESTED (design choice)** | `engine.py:193-199` passes no `msg_data`; Telethon's built-in refetch is therefore unavailable; recovery = resolver invalidation + player retry (`engine.py:218-225`). 0 occurrences measured |
| 13 | *New lead:* CDN redirect handling for large/popular media | **UNTESTED** | No CDN redirect observed for these documents (served from DC5); behavior for popular files is unknown |
| 14 | *New lead:* 416 `Content-Range` dropped by the backend proxy | **SUPPORTED (defect)** | §3.4; one-line-ish fix; must-fix correctness item |

---

## 5. Confidence and constraints

- **High confidence** (reproduced, code + measurement agree): client reuse; single in-flight 512 KiB requests; RTT-bound
  TTFB; no buffering in backend; cancellation cleanliness; concurrency lifting aggregate throughput; flat memory; zero
  FloodWait at ≤4 concurrency and ~800 MB total.
- **Medium confidence**: sustained-rate numbers under repeated long runs (upstream pacing variance is real, 2–3×);
  cold-start decomposition (single sample).
- **Not established**: WAN client behavior (all measurement hops except backend→DC were loopback), VPS resource profile,
  real Jellyfin playback, ~2 GB files, >4 concurrent streams, long-run rate-limit behavior, CDN-redirect workloads,
  4K/high-bitrate sufficiency judgment for the operator's actual library.
- **Constraints to respect in follow-ups**: ≤4 concurrent upstream requests until FloodWait behavior is characterized;
  no decrypted-content caching on disk; keep the "never fake a 206 / never truncate silently" invariants
  (`engine.py:228-233`) — prefetch work must preserve exact byte counts and ordering.

---

## 6. Conclusion

### 6.1 Top 3 highest-confidence bottlenecks

1. **One in-flight `upload.getFile` per stream (RTT-bound 512 KiB requests).** Mechanism is in code
   (`engine.py:17-21,193-199`); envelope math from measured DC RTT (67 ms median) gives ~7.6 MiB/s best case; measured
   sustained is 1.80 MiB/s single-stream, while 4 independent streams reach 4.09 MiB/s aggregate (2.27×). This is the
   dominant throughput limiter and the reason high-bitrate direct-play is marginal.
2. **Sustained single-stream pacing/variance.** The same request varies 2–3× run-to-run (10.7↔31.5 Mbps; 17.0↔35.4 Mbps)
   and one 512 KiB request stalled 3.19 s. Single-stream playback cannot rely on a stable floor near the RTT envelope.
3. **Cold-start serial chain (~500 ms over warm).** Credentials HTTP fetch + MTProto connect + entity/message resolve
   before the first GetFile (`engine.py:127-135`, `file_resolver.py:60-77`). Warm streams pay ~169 ms p50; the first
   playback after idle pays 671 ms (measured).

### 6.2 Top 3 proposed optimizations ranked by measured benefit / effort

1. **Bounded single-stream read-ahead (prefetch pipeline), flag-gated.** The concurrency experiment directly measures the
   mechanism's upside (2.27× aggregate; parallelism is granted upstream; zero FloodWait at 4). Expected to raise the
   single-stream floor and to absorb stalls inside the pipeline. Effort M. A/B protocol and go/no-go thresholds are in
   the roadmap (P2). *This is the only candidate measured to move the primary metric.*
2. **416 `Content-Range` passthrough in the backend gateway** (must-fix correctness; effort S). Measured defect; required
   for spec-correct range interop at the backend boundary (`telegram-stream-gateway.ts:122-139`). Near-zero risk.
3. **Cold-start trimming** (effort S–M): pre-warm the Telethon client for a provider when the account connects / first
   app activity, and optionally expose the resolver TTL as config. Mechanism measured (cold 671 ms vs warm ~150 ms p50).
   Benefit is per-session, not per-request.

Deferred until measured need: 4 KiB-granular alignment + dropping `file_size` from `iter_download` to cut unaligned-seek
waste (≤512 KiB/seek, bounded — low value), first-request-size shaping for ~50 ms TTFB (M risk vs ≤1 RTT gain), chunk
caching (security/design review required), CDN handling (no evidence it occurs).

### 6.3 Safe next session vs requires live Telegram

| Safe now (no Telegram dependency) | Requires live Telegram test |
|---|---|
| 416 `Content-Range` passthrough + tests | Prefetch go/no-go A/B (depth 2 vs 3 vs 0) |
| `X-Request-Id` end-to-end propagation; `resolve_ms`/`dc_id` fields in `stream_end`; prefetch flag scaffolding (default off) | FloodWait characterization under long parallel runs |
| Unit/regression suite run (55 tests) | Real Jellyfin/rclone playback and seeks; WAN client measurements |
| Runbook execution once a valid session exists | ~2 GB file tests; CDN-redirect workload |

### 6.4 Suggested next coding-agent prompt (Phase P0 only — do not implement during this audit)

> Phase P0 of `plans/telegram-stream-optimization-roadmap.md`: add observability/plumbing only — (1) forward
> `X-Request-Id` from the backend Telegram stream gateway and WebDAV readable path to `/v1/stream` and echo it back;
> (2) add `resolve_ms`, `dc_id` (from `ResolvedLocation`), and `prefetch_depth` (constant 0 for now) to the `stream_end`
> log in `app/observability.py` + call sites; (3) add a `TELEGRAM_STREAM_PREFETCH_DEPTH` setting that defaults to 0 and
> is not yet consumed by the data path; (4) fix the 416 `Content-Range` passthrough defect in
> `telegram-stream-gateway.ts` with a focused test. No behavior change to streaming bytes; run backend build + the
> telegram-stream pytest suite; do not enable prefetch.

### 6.5 Commands actually run (summary)

- Live matrix via the backend `/files/:id/download` with a short-lived locally minted access token
  (existing valid session; token never written to disk or docs), `curl -w` capture, `docker compose logs telegram-stream`
  extraction of `stream_start`/`stream_end`/`stream_resolve_failed`.
- In-container probes: `telethon.__version__`, `MAX_CHUNK_SIZE`/`MIN_CHUNK_SIZE`, `inspect.getsource` of the iterator
  selection and `_GenericDownloadIter._load_next_chunk`, DC RTT probe via `help.GetConfigRequest` on the document DC.
- `/health`, `/ready` counters before/after each block; `docker stats` sampling; `pytest` (55 passed) in an isolated
  container. Exact rerunnable commands: `plans/telegram-stream-benchmark-runbook.md`.

---

## 7. Addendum — optimization program outcomes (P0–P4) and go/no-go decisions

Recorded per the roadmap's common requirement: "same acceptance/perf-gate/rollback discipline as P2, plus a written
go/no-go decision recorded in the audit report's addendum." All figures below are live measurements from the local
Docker stack (DC5; large file ~1.24 GB; no account/channel/file identifiers recorded).

### 7.1 P0 + P1 (observability and config wins) — done, verified live

`X-Request-Id` now propagates backend → stream service → `stream_end`; `stream_end` carries `resolve_ms`, `dc_id`,
`iterator`, `prefetch_depth` (plus `prefix_bytes` added in P3); `/ready` exposes flood/CDN/refresh counters; the
must-fix 416 `Content-Range` passthrough defect (§3.4) is fixed with backend vitest coverage. P1 added the resolver
TTL config, startup logging of the effective request size, and the chunk-size clamp path. No behavioral change to
bytes on the wire.

### 7.2 P2 (prefetch read-ahead) — implemented behind flag; **no-go for depth 2**, flag stays 0

Live A/B, ~870 MiB, 6 runs per workload per depth, 0 FloodWait, 100% byte-exact:

| Workload | Depth 0 median | Depth 2 median | Delta | Gate (≥30%) |
|---|---|---|---|---|
| 33.55 MiB range | 40.9 Mbps | 61.6 Mbps | +51% | pass |
| 64 MiB range | 43.2 Mbps | 48.7 Mbps | +12.6% | **fail** |

Warm TTFB p95 169 → 181 ms (+7%, gate ≤20%); RSS 71.5 → 74–78 MiB. Depth-2 runs were bimodal (≈baseline or ≈1.5×),
consistent with per-connection server-side scheduling rather than merge behavior. Depth 3 was not tested per protocol
(gate already failed). Code remains behind `TELEGRAM_STREAM_PREFETCH_DEPTH=0` for retests on other DCs/time-of-day.

### 7.3 P3 (seek precision) — implemented and live-verified; corrects a premise in §6.2

§6.2 deferred "4 KiB-granular alignment + dropping `file_size`" as low-value; the roadmap's P3 task 1 further assumed
any 4 KiB-aligned offset works on the direct iterator. The first live matrix with that design produced
`LimitInvalidError` on real seeks, and a direct RPC probe pinned the actual server rules for `upload.getFile`:

1. `offset % 4096 == 0`;
2. **`limit` must be a power-of-two multiple of 4 KiB** (12/36/40/96/260/296 KiB rejected at a phase-0 offset;
   4/8/16/64/128/256/512 KiB accepted);
3. **no 1 MiB window crossing**: `(offset % 1 MiB) + limit ≤ 1 MiB` (ending exactly at the edge is allowed).

Final design (always on; no flag): `effective_request_size()` rounds down to a power of two dividing 1 MiB;
grid-aligned starts use one open direct iterator; other starts split the head to the window edge into power-of-two
pieces (binary decomposition — e.g. 296 KiB → 256 + 32 + 8 KiB, probe-validated) and resume an open iterator from the
window edge. Per-seek discarded prefix: ≤ 4 KiB (live `prefix_bytes` 0/576/1428/1427 vs. up to 512 KiB before;
worst-case Jellyfin prefix 221,184 B → 0). Verification: pytest 81 passed; full boundary matrix (0, 4 KiB, 512 KiB−1,
512 KiB, 1 MiB−1, 1 MiB, unaligned, suffix, last byte, 3× Jellyfin range) all 206 with exact byte counts, all
`_DirectDownloadIter`, zero `LimitInvalidError`, zero resolver invalidations, 0 FloodWait; byte-exactness
cross-checked by hashing identical slices fetched through independent plans (all matched). Jellyfin goodput
33.9–38.4 Mbps vs 40.9 Mbps pre-P3 baseline (within run-to-run spread; the fix removes hard failures rather than
adding throughput); warm TTFB 42–152 ms; RSS ~70 MiB. Live traffic for P3 ≈ 135 MiB.

### 7.4 P4 candidates — trigger check and decisions (all **no-go** today)

| Candidate | Trigger | Evidence today | Decision |
|---|---|---|---|
| Bounded chunk cache (RAM, LRU) | Repeated-seek data shows the same windows re-fetched often | No production seek telemetry; P3 cut per-seek waste to ≤4 KiB; no observed repeated-window pattern in ≥50 live streams | **No-go**; revisit if production `prefix_bytes`/range logs show material re-fetch share |
| CDN-redirect handling (MF-2) | `total_cdn_redirects > 0` | 0 across all P0–P3 live sessions (~40+ streams, ≈1 GiB) | **No-go**; counter + `_CdnRedirect` name-probe already in place; implement mapping + mocked test only when the counter moves |
| Second data plane / DC proximity | WAN shows host↔DC RTT dominant beyond tuning | RTT 67 ms median ≈ one request; warm TTFB p50 42–170 ms; P2 bimodality points at server-side per-connection scheduling, not RTT | **No-go** (ops decision; no code) |
| Telethon upgrade | Upstream release fixes a measured issue | None identified; 1.45.0 pinned for layer parity with backend `teleproto 1.229.0`; P3 shipped without library changes | **No-go**; revisit on upstream security/perf issue |
| HTTP/2 / header micro-tuning | Backend hop >50 ms | Backend hop 8–17 ms baseline | **No-go** |

### 7.5 Steady state and revisit conditions

- Steady state: `TELEGRAM_STREAM_PREFETCH_DEPTH=0`; `/ready` counters at 0 (flood, CDN, reference refreshes);
  P3 active. Rollback for P3 is a single revert of the engine plan change (no config flag by design — the old
  4 KiB-aligned single-request behavior is known-broken live, so there is nothing safer to fall back to).
- Revisit P4 when: `total_cdn_redirects > 0` (MF-2); production repeated-seek/re-fetch data appears (cache);
  sustained single-stream floor becomes a product requirement again (prefetch retest on another DC/time-of-day,
  then depth 3 per protocol); or dependency/ops triggers fire.
