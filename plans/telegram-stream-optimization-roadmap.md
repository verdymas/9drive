# 9Drive — Telegram Stream Optimization Roadmap

Date: 2026-10-18
Status: implementation-ready plan; all perf gates reference the measured baseline in `reports/telegram-stream-performance-audit.md`
Scope: `services/telegram-stream/` (Python) + `backend/` Telegram proxy paths. No database changes required in any phase.

Baseline the gates refer to (from the audit):

| Metric | Baseline |
|---|---|
| Single-stream sustained (258 MiB full read) | 1.80 MiB/s (15.1 Mbps) |
| Single-stream burst range (33.55 MiB) | 2.02–4.22 MiB/s (variance) |
| 4 concurrent streams aggregate | 4.09 MiB/s |
| Warm TTFB (service-side, p50 / p90) | 169 ms / 392 ms |
| Cold first stream TTFB | 671 ms |
| DC RPC RTT (median) | 67 ms |
| FloodWait events in baseline run | 0 (32 stream bodies + 1 pre-stream rejection, ~800 MB) |
| telegram-stream RSS | 104–107 MiB under load (512 MiB limit) |

Global guardrails for every phase: never fake a 206, never silently truncate (`SHORT_READ` invariant in
`engine.py:228-233`), never cache decrypted content on disk, keep ≤4 concurrent upstream requests until FloodWait
behavior at higher depth is characterized, keep the single-worker uvicorn design.

---

## Must-fix correctness defects (independent of performance)

| ID | Defect | Evidence | Fix location |
|---|---|---|---|
| MF-1 | 416 responses at the backend boundary lose `Content-Range: bytes */{total}` (upstream sets it; gateway's non-2xx path forwards only `Content-Type` + body) | Audit §3.4; upstream handler `app/main.py:29-38`; gateway `telegram-stream-gateway.ts:122-139` | `backend/src/modules/telegram/telegram-stream-gateway.ts` + test |
| MF-2 | A CDN redirect during `iter_download` surfaces as a generic exception → resolver invalidation + torn stream, with no dedicated counter/error code (untested, latent) | `engine.py:72-91` has no `_CdnRedirect` mapping; Telethon 1.45.0 `_DirectDownloadIter._request` raises it | `engine.py` (`_classify`/`iter_bytes`) — observe first (P0 counter), map in P4 if triggered |
| MF-3 | (Operational) A revoked Telegram session produces 503 `TELEGRAM_REAUTH_REQUIRED` and flips account status — works, but the audit start showed operators cannot stream until re-auth; document in runbook | Audit §0.3 | runbook only |

---

## P0 — Baseline, observability, reproducibility

**Status (2026-10-18): implemented and verified locally.** Backend build + vitest (135 files / 1424 tests) and
pytest (57 passed) green. Live smoke (local Docker, DC5): warm TTFB p50 125 ms vs 169 ms baseline gate (±10%);
`X-Request-Id` matched end-to-end (backend response header ↔ `stream_end.request_id`); 416 returned
`Content-Range: bytes */1242834324` at the backend boundary (must-fix MF-1 verified live); `/ready` shows
`prefetch_depth_configured: 0`, `total_cdn_redirects: 0`; `stream_end` carried `resolve_ms` (605 cold / 0 warm),
`dc_id: 5`, `iterator: _DirectDownloadIter`, `prefetch_depth: 0`.

**Objective:** make every future optimization measurable end-to-end without leaking user data.

**Files/modules**
- `backend/src/modules/telegram/telegram-stream-gateway.ts` (send/forward `X-Request-Id`)
- `backend/src/modules/webdav/telegram-stream-readable.ts` (same)
- `services/telegram-stream/app/observability.py` (`StreamMetrics.finish` fields)
- `services/telegram-stream/app/api/stream.py` (pass resolve timing + dc info into metrics)
- `services/telegram-stream/app/telegram/engine.py` (expose `resolve_ms`, `dc_id`, iterator class)
- `services/telegram-stream/app/core/config.py` + `docker-compose.yml` + `.env.docker.example` (prefetch flag scaffolding, default 0)
- Tests: `backend/src/modules/telegram/telegram-stream-gateway.test.ts`, `services/telegram-stream/tests/test_observability.py`, `test_stream_contract.py`

**Detailed tasks**
1. Backend generates/forwards `X-Request-Id` (reuse inbound header if present) to `/v1/stream` and WebDAV readable; `stream.py:138` already honors it.
2. Add to `stream_end`: `resolve_ms` (measured around `resolve_document`), `dc_id` (from `ResolvedLocation.dc_id`; infrastructure-only value), `iterator` (from Telethon debug log or inferred), `prefetch_depth` (constant 0 until P2).
3. Add `TELEGRAM_STREAM_PREFETCH_DEPTH` setting (parse + clamp 0–4) that is **not consumed** by the data path yet; surface it in `/ready` for operator visibility.
4. Add a counter for `_CdnRedirect` observations (MF-2 observation only; no behavior change).
5. Document the operator benchmark flow from `plans/telegram-stream-benchmark-runbook.md`.

**Acceptance tests**
- `stream_end` contains the new fields for a normal stream; `request_id` matches the backend-supplied id end-to-end.
- No secret/identity fields added; redaction tests still pass.
- Gateway tests updated to assert `X-Request-Id` forwarding.

**Performance gates**
- p50 TTFB within ±10% of baseline (169 ms) on a 5-request smoke.

**Regression tests**
- `cd backend && npm run build` + `npm test`; telegram-stream `pytest` (55 tests) green.

**Monitoring:** the new `stream_end` fields become the measurement substrate for P2/P3.
**Rollback:** revert commit; fields are additive.
**Prerequisites:** none. **Deployment:** rebuild backend + telegram-stream images; no migration.
**Must-fix in this phase:** MF-1 (416 `Content-Range` passthrough — copy `content-range` header on the non-2xx path when upstream provides it; add a gateway test with a mocked 416).

---

## P1 — Low-risk latency and memory wins

**Status (2026-10-18): implemented and verified locally.** Resolver TTL is env-driven
(`TELEGRAM_STREAM_RESOLVER_TTL_SECONDS`, clamped 15–600, engine resolver wired to it); startup logs the effective
request size and fired the new `CHUNK_SIZE_CLAMPED` warning on the live host (env set 1 MiB → effective 512 KiB —
the silent misconfiguration now surfaces at boot). Live smoke: warm TTFB p50 108 ms (gate 169 ±10%); idle RSS
69.6 MiB (gate: no >5 MiB increase). pytest 63 passed; backend build green.

**Objective:** cheap, evidence-backed improvements; no streaming-path redesign.

**Files/modules:** `services/telegram-stream/app/core/config.py`, `engine.py` (`FileResolver` construction at `:139`), `.env.docker.example`, `docker-compose.yml`.

**Detailed tasks**
1. Make the resolver TTL configurable: `TELEGRAM_STREAM_RESOLVER_TTL_SECONDS` (default 60, clamp 15–600). Rationale: each cache miss costs two RPCs before first byte (`file_resolver.py:60-77`); operators on high-latency links may want a longer TTL. Keep invalidate-on-failure behavior unchanged.
2. Confirm/leave Telethon's built-in keep-alive ping enabled (no code change); add a note + long-idle check to the runbook so cold-start (671 ms) is attributable if it recurs.
3. (Optional) Validate `TELEGRAM_STREAM_CHUNK_SIZE_BYTES` at startup (multiple of 4096, ≤ 512 KiB) and log the effective request size once at boot — prevents silent misconfiguration.

**Acceptance tests**
- Resolver TTL is read from env; existing resolver tests pass; invalidate-on-stale-`file_reference` test still green.
- Startup logs the effective chunk size without secrets.

**Performance gates**
- No change to p50 TTFB beyond ±10% in smoke; no memory change >5 MiB RSS at idle.

**Regression tests:** full pytest suite; backend build.
**Monitoring:** none new. **Rollback:** restore constants. **Prerequisites:** P0 (measures the effect). **Deployment:** telegram-stream image only.

---

## P2 — Sequential throughput: bounded read-ahead (prefetch)

**Status (2026-10-18): implemented behind the flag; live A/B run — flag stays 0 (gate not met on the 64 MiB
workload).** pytest 78 passed (incl. new `tests/test_prefetch.py`: in-order byte-exact merge, staggered workers,
wire params/limits, cancellation, worker-error propagation, short-read). Live A/B (local Docker, DC5, large file
1.24 GB, 6 runs per workload per depth ≈ one extra block beyond the ≥3 minimum, 60 s gaps, 0 FloodWait,
100% byte-exact, all `stream_end` rows `prefetch(k=2)`, ~870 MiB A/B traffic, within the 1 GiB session budget):

| Workload | Depth 0 median | Depth 2 median | Delta | Gate (≥30%) |
|---|---|---|---|---|
| 33.55 MiB range | 40.9 Mbps | 61.6 Mbps | +51% | pass |
| 64 MiB range | 43.2 Mbps | 48.7 Mbps | +12.6% | **fail** |

Warm TTFB p95 ≈ 169 → 181 ms (+7%, gate ≤ +20%); RSS 71.5 → 74–78 MiB (+3–7 MiB). Depth-2 runs are bimodal
(≈baseline rate or ≈1.5×), consistent with DC-side per-connection scheduling rather than merge behavior (chunk
counts exact, no errors, iterator and byte accounting verified). Per protocol, depth 3 was not tested and
`TELEGRAM_STREAM_PREFETCH_DEPTH` remains 0 (code retained behind the flag for retests on other DCs/time-of-day
and as the P4 substrate). Two fixes landed with the implementation: outer-generator `aclose()` now cascades to
the worker tasks, and `stream_end.prefetch_depth` reports the effective depth actually used.

**Objective:** raise the single-stream sustained floor and absorb upstream stalls, using the concurrency mechanism the audit measured (4 concurrent streams → 2.27× aggregate; 0 FloodWait).

**Files/modules:** `services/telegram-stream/app/telegram/engine.py` (`iter_bytes`), `app/core/config.py`, `app/observability.py`, `docker-compose.yml` / `.env.docker.example`, tests (`tests/test_engine.py`, new `tests/test_prefetch.py`).

**Design (Telethon public API only)**
- `k = TELEGRAM_STREAM_PREFETCH_DEPTH` (0 = current behavior; enable 2 first, then 3).
- Launch `k` workers; worker `i` runs `client.raw.iter_download(location, offset=aligned_start + i*request_size, stride=k*request_size, chunk_size=request_size, request_size=request_size)`; each worker yields chunks `i, i+k, i+2k, …`.
  - Verified in installed 1.45.0 source: `stride ≥ chunk_size`, offset multiple of 4096, and after the engine's 512 KiB alignment `bad = offset % request_size == 0`, so workers keep the same one-request-per-chunk wire behavior with in-order payloads.
- Merge in byte order with one bounded `asyncio.Queue(maxsize=2)` per worker; emit strictly in order; stop exactly at `length`; preserve prefix discard on worker 0 and tail trimming on the final chunk.
- Errors: any worker exception cancels the others (TaskGroup/`gather` with cancellation), invalidates the resolver entry once, and re-raises the existing classified error; cancellation closes every worker in `finally`.
- Memory bound: `k × ~512 KiB` buffers plus queue slack — ≤ ~4 MiB at k=3.

**A/B experiment (live Telegram; runbook §"Prefetch A/B")**
- Workload: 33.55 MiB Jellyfin-style range and 64 MiB range on the large file; full mid read once; ≥3 runs per depth.
- Order: depth 0 → 2 → 3, 60 s gap, flood counter checked between steps.
- **Go for depth 2:** ≥30% improvement in median `avg_mbps` on both range workloads AND p95 TTFB ≤ +20% vs baseline AND 0 FloodWait AND all runs byte-exact.
- **Go for depth 3:** additional ≥15% median improvement, else stop at 2. Abort entire phase on the first FloodWait; keep flag at 0.

**Acceptance tests (unit, offline)**
- In-order exact output with synthetic workers of different delays; exact byte counts for aligned/unaligned/prefix/tail cases; cancellation mid-merge closes all workers; worker error propagates and invalidates resolver; `k=0` reproduces today's byte-for-byte behavior.

**Performance gates:** as A/B above. **Regression tests:** full pytest; WebDAV + preview + public-share smoke via runbook; Jellyfin seek smoke.
**Monitoring:** `prefetch_depth` in `stream_end`; `total_flood_waits` must stay 0; RSS watch during first week (expect +≤4 MiB).
**Rollback:** set `TELEGRAM_STREAM_PREFETCH_DEPTH=0` (no redeploy of code semantics; config env).
**Prerequisites:** P0 metrics live; valid Telegram session; low-traffic window. **Deployment:** telegram-stream image; default remains 0 until A/B passes in production-like conditions.

---

## P3 — Random seeks, Jellyfin, tail latency

**Status (2026-10-18): implemented and verified live; always on (no flag).** The audit's task-1 premise ("drop
`file_size` and any 4 KiB-aligned offset stays on the direct iterator") turned out to be incomplete — the first
live matrix with 4 KiB alignment produced `LimitInvalidError` on real seeks, and a direct RPC probe pinned the
actual server rules (both apply to `upload.getFile`): (1) **the limit must be a power-of-two multiple of 4 KiB**
(12/36/40/96/260/296 KiB all rejected at a phase-0 offset; 4/8/16/64/128/256/512 KiB accepted); (2) **a request
must not cross a 1 MiB window**, `(offset % 1 MiB) + limit ≤ 1 MiB` (512 KiB from offset 41,639,936 or 999,424
rejected; requests ending exactly at the edge accepted). Consequently the final design is a power-of-two plan:
`effective_request_size()` rounds down to a power of two that divides 1 MiB; request-grid starts use one plain
open direct iterator; any other start splits the head up to the window edge into power-of-two pieces via binary
decomposition (296 KiB → 256 + 32 + 8 KiB, validated live) and then resumes one open direct iterator from the
window edge. The prefix discard stays ≤ 4 KiB, and Telethon keeps `limit=None`/no `file_size` via
`InputDocumentFileLocation`. The prefetch path (P2, disabled) keeps its request-grid alignment and is unaffected.

Verification (pytest **81 passed**, incl. a fake that enforces 4 KiB alignment + power-of-two limit + the 1 MiB
window): full boundary matrix (0, 1 MiB, 1 MiB−1, arbitrary unaligned 32 KiB, suffix 256 KiB, last byte,
grid-crossing Jellyfin range 33.55 MiB ×3) — every row 206 with exact byte counts; all `stream_end` rows
`iterator=_DirectDownloadIter`, `error=null`, `prefix_bytes` 576/1428/1427 as predicted (was ≤512 KiB); zero
`LimitInvalidError`; zero resolver invalidations; 0 FloodWait. Byte-exactness cross-checked by hashing identical
slices fetched through independent plans (decomposition path vs plain grid path; prefix-discard path vs grid
slice; suffix last byte vs single-byte range) — all matched. Jellyfin throughput 33.9–38.4 Mbps vs 40.9 Mbps
pre-P3 baseline median (within run-to-run spread; the fix removes hard failures rather than adding speed), warm
TTFB 42–152 ms unchanged, RSS ~70 MiB. P3 task 3 (tail-latency with P2 workers) is moot while the prefetch flag
stays 0 (P2 no-go). Total live traffic for P3 ≈ 140 MiB (probe + 2 matrices + byte-verify), within budget.

**Objective:** reduce wasteful upstream bytes on unaligned seeks and keep the seek path predictable.

**Files/modules:** `services/telegram-stream/app/telegram/engine.py`, tests (`tests/test_engine.py`, `test_stream_contract.py`).

**Detailed tasks**
1. **4 KiB-granular first alignment.** Change `aligned_start` from `start - start % request_size` to `start - start % _TELETHON_MIN_CHUNK` and drop `file_size` from the `iter_download` call so `limit is None` ⇒ Telethon selects `_DirectDownloadIter` for any 4 KiB-aligned offset (verified condition; Generic would otherwise re-fetch the unaligned head). Prefix waste drops from ≤512 KiB to ≤4 KiB per seek (measured worst case: 475,712 B → ≤4,092 B; Jellyfin case 221,184 B → ≤4,092 B).
   - Interaction check: Direct iterator stops on a short server chunk; the engine already stops at `remaining <= 0`, and `SHORT_READ` still guards under-delivery.
2. **Re-run the full boundary matrix** (0, 4096, 512 KiB−1, 512 KiB, 1 MiB−1, 1 MiB, arbitrary unaligned, suffix, last byte) and confirm zero `LimitInvalidError` and byte-exactness.
3. **Tail-latency observation:** with P2 enabled, quantify whether worker redundancy absorbs a single stalled chunk (simulated in unit tests; live stalls documented if they recur).
4. **First-request-size shaping (conditional):** only if P0's `resolve_ms` shows TTFB is materially above one RTT (i.e., > RTT+100 ms warm). Expected ceiling gain is ≤1 RTT (~67 ms); implement a small first request (e.g. 128 KiB) only with a written go decision, because it reintroduces partial-request edge cases.

**Acceptance tests**
- Exact bytes for every boundary above; exactly `ceil((prefix+length)/512 KiB)` chunks; no 416-misclassification regressions.
- Unit test proving `iter_download` is called without `file_size` and with 4 KiB alignment.

**Performance gates**
- Unaligned 32 KiB probe: upstream bytes reduced ≥99% (structural); p50 TTFB within ±10% of 169 ms; no change to sustained goodput beyond noise.
- Zero `LimitInvalidError` across the matrix.

**Regression tests:** full pytest; Jellyfin-style range replay from the audit; WebDAV seek smoke.
**Monitoring:** `prefix_bytes` optionally added to `stream_end` (safe integer). **Rollback:** revert alignment/drop-file_size change (single commit). **Prerequisites:** P0. **Deployment:** telegram-stream image only.

---

## P4 — Optional advanced (only with measured justification)

**Status (2026-10-18): trigger check performed — all candidates no-go today; the optimization program is complete
(P0–P3 shipped/decided, steady state verified).** Evidence per candidate (`cdn_redirect` counter 0 across all live
sessions; no repeated-seek re-fetch data; RTT/backend hop below thresholds; no measured Telethon issue) and the
revisit conditions are recorded as the written go/no-go addendum in
`reports/telegram-stream-performance-audit.md` §7.4–7.5, per this phase's common requirement.

**Objective:** candidate work that must not start without data.

| Candidate | Trigger to start | Notes / constraints |
|---|---|---|
| Bounded chunk cache (RAM only, LRU, e.g. 128–256 MiB cap) | Repeated-seek data shows the same 512 KiB windows re-fetched often (P0/P3 metrics) | Never on disk; process-isolated; security design review; flag-gated; eviction must be memory-hard-capped |
| CDN-redirect handling (MF-2) | `cdn_redirect` counter > 0 in production logs | Map `_CdnRedirect` to a clear code; add an integration test with a mocked redirect; do not strip Telethon's CDN path if it engages |
| Second data plane / DC proximity | WAN measurements show host↔DC RTT dominant beyond tuning | Deployment/ops decision, not code |
| Telethon upgrade | Upstream release fixes a measured issue | Currently pinned 1.45.0 for layer parity with backend `teleproto 1.229.0` (`requirements.txt` comment); do not bump casually |
| HTTP/2 or header micro-tuning in the backend proxy | Measured backend hop >50 ms or header overhead | Baseline shows 8–17 ms — not justified today |

Common requirements if started: same acceptance/perf-gate/rollback discipline as P2, plus a written go/no-go decision
recorded in the audit report's addendum.

---

## Sequencing summary

```
P0 (observability + MF-1)  ──►  P1 (config wins)  ──►  P2 (prefetch A/B)  ──►  P3 (seek precision)  ──►  P4 (if justified)
         │                                                      │
         └────────── measurement substrate ─────────────────────┘
```

Safe to implement without a live Telegram session: P0, MF-1, P1 tasks, P2 unit scaffolding (flag default 0), P3 unit
tests. Requires live Telegram: P2 A/B, P3 boundary revalidation, any P4 trigger check.
