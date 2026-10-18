# 9Drive — Telegram Stream Performance Optimization Plan (Investigation & Planning Only)

## Role and mission
You are a senior performance engineer auditing the existing 9Drive repository. Produce an **evidence-driven, implementation-ready optimization plan** for `telegram-stream`, with the primary goals of **faster initial playback, higher sustained streaming throughput, and lower seek latency** for large Telegram-hosted files (including Jellyfin/Plex-compatible HTTP Range playback).

**This task is PLANNING ONLY.** Do not implement optimizations, refactor production code, change dependencies, deploy infrastructure, or claim speedups without measurements. You may add narrowly scoped, non-invasive benchmark/test scripts **only if needed and safe**, but prefer using existing tooling. If an environment is unavailable, provide exact operator-run commands and mark those measurements `PENDING` rather than inventing results.

## Project context — verify against the current repository
- 9Drive includes a Python `telegram-stream` service and a backend that proxies or coordinates streaming from Telegram storage.
- Prior investigations involved Telethon, Telegram MTProto media reads, HTTP Range requests, Jellyfin seeking, unaligned offsets, 512 KiB request limits, and Telegram 1 MiB chunk-boundary issues. Treat these as **hypotheses and historical leads**, not statements about the current code.
- The user prefers **free/open-source libraries**, no paid APIs, and no extra mandatory external services. Reuse existing Docker/Redis components only if demonstrably helpful.
- Preserve authentication/authorization, file encryption/decryption semantics (if applicable), data integrity, and existing provider APIs. No changes to Remote Import Worker routing (Direct/Cloudflare/Deno/VPS).

## Phase 0 — Bounded architecture reconstruction
1. Read `AGENTS.md` and relevant code/docs indexes if they exist.
2. Identify the current `telegram-stream` entrypoint, Telegram client creation and lifecycle, MTProto layer/library versions, media download method, chunk/range logic, HTTP server implementation, backend stream proxy, storage metadata lookup, encryption/decryption, and Docker resource settings.
3. Inspect relevant code only. Likely starting points (verify paths first):
   - `services/telegram-stream/app/telegram/engine.py`
   - `services/telegram-stream/` HTTP routes, startup/client/session/config modules
   - `backend/` Telegram streaming integration and HTTP response proxy
   - Relevant compose files, Dockerfiles, existing tests/benchmarks
4. Diagram the **actual** request path: playback client -> backend -> telegram-stream -> Telegram MTProto -> response body. Annotate buffer sizes, buffering points, concurrency limits, and Range alignment.
5. Enumerate distinct workloads: cold start/open, warm sequential stream, random seeks, repeated seeks, concurrent clients, encrypted vs unencrypted assets if applicable, and cancellation mid-stream.

## Phase 1 — Define measurable baselines
Create a small reproducible benchmarking protocol. Measure **separately** the local/backend overhead and Telegram upstream behavior; do not aggregate away the bottleneck.

Mandatory metrics:
- Time to first byte (TTFB): median/p95 from client and from service ingress.
- Sustained goodput MiB/s: median/p95, single stream and 2–4 concurrent streams.
- Seek response time: median/p95 for cold and warm `Range` requests, especially unaligned starts and requests that cross Telegram chunk boundaries.
- Successful HTTP `200/206/416` semantics; response `Content-Range`, `Content-Length`, exact bytes, integrity checksum against a trusted baseline.
- MTProto request rate, payload bytes vs wire/request bytes where observable, retries, FloodWait/rate-limit events, connection handshakes and reconnect counts.
- CPU%, RSS memory, queue/wait time, event-loop blocking, network RX/TX, backpressure, transfer cancellations, and error rate.

Test matrix, where feasible:
- File sizes: ~10 MiB, ~200 MiB, ~2 GiB (or nearest representative available).
- Requests: full sequential download, `bytes=0-`, middle seek, last-chunk seek, deliberately unaligned ranges, 1 MiB-boundary-crossing range, multi-range handling if implemented, aborted request.
- Client types: direct service endpoint, through backend, real Jellyfin seek/playback if available.
- Concurrency: 1, 2, 4 concurrent readers; one cold run and >=3 repeat runs for warm path.
- Network location: same Docker host vs remote client; indicate where TLS/network overhead enters.

Record hardware, deployment profile, client/DC location if known, Telethon and other dependency versions, number of runs, variance, and reproducible commands. Avoid testing against third-party content you do not have authorization to access. Keep benchmark load conservative to avoid Telegram rate limits.

## Phase 2 — Profile and isolate bottlenecks
Assess each hypothesis and state **SUPPORTED / REJECTED / UNTESTED** with code references and metric evidence:
1. MTProto connection setup repeated for every request vs connection reuse/session pooling.
2. Offset and limit calculation: alignment, skip/discard overhead, Telegram 1 MiB boundary crossing, correctness across random ranges. Do not reintroduce `LimitInvalidError`.
3. Sequential vs carefully bounded concurrent chunk fetching/prefetch; whether Telegram and the current client implementation actually benefit (consider rate limits and memory).
4. Block size across Telegram -> Python -> backend -> HTTP client; avoid inefficient tiny writes and oversized buffering.
5. Backpressure, cancellation propagation, and stalled client handling; no orphaned Telegram fetches.
6. Backend double buffering / proxying overhead; HTTP headers, chunked transfer, compression, sync blocking and data copies.
7. Metadata lookups, session load, message/file resolution, decrypt/auth overhead, caching opportunities.
8. Python async scheduling, locks, contention, blocking work, and process/worker count on target VPS/container.
9. Docker CPU/memory/network quotas; TCP/TLS latency between services vs Telegram DC.
10. Media-specific seek patterns (e.g., Jellyfin speculative small ranges and readahead), and whether caching/readahead help or waste bandwidth.

**Do not** assume increasing worker count, adding threads, parallelizing Telegram requests, switching libraries, or adding caching will improve performance. Require an expected mechanism plus an experiment for each candidate.

## Phase 3 — Compare optimization options and tradeoffs
For each candidate, provide:
- Evidence of bottleneck and expected latency/throughput impact (qualitative estimate unless measured).
- Exact affected modules and API contracts.
- Dependency/licensing costs; prefer zero new services and free/open-source solutions.
- RAM, CPU, outbound bandwidth, Telegram rate-limit, session safety, and operating cost impact.
- Impact on `Range`, arbitrary offsets, content integrity, encryption, cancellation and concurrent requests.
- Rollback switch/feature flag, test plan, risk level, effort estimate (S/M/L).
- A **minimal benchmark / A-B experiment** with explicit go/no-go threshold.

Evaluate possibilities in sensible order, based on evidence, such as connection reuse; bounded read-ahead; correct aligned offset slicing; tuning per-read limits; prefetch on sequential playback only; caching metadata or bounded content chunks; eliminating proxy copies; handling seeks without wasted prefetched data; guarded concurrency; and library upgrade only if compatibility/benefit is demonstrated.

**Library upgrades:** inspect the current dependency lockfiles and compatibility before recommending Telethon upgrades or replacements. Do not casually migrate MTProto implementations. Include an escape hatch if an upstream limitation prevents optimization.

## Phase 4 — Build an executable phased roadmap (still no code changes)
Prepare ordered phases, ideally:
- **P0: Baseline/observability & reproducibility** (minimal metrics without leaking user data).
- **P1: Low-risk latency and memory wins** (only evidence-backed).
- **P2: Sequential throughput improvements** (read-ahead/chunk/pipelining if proven).
- **P3: Random seeks, Jellyfin and concurrency** (correctness + predictable tail latency).
- **P4: Optional advanced changes** (larger cache, dependency changes) only if justified.

Every phase must contain: objective; exact files/modules; detailed tasks; acceptance tests; performance gates; regression tests; operational monitoring; rollback; prerequisites; deployment considerations. Separate **must-fix correctness bugs** from performance improvements.

Acceptance examples (replace with evidence-based targets once baseline exists):
- No HTTP Range byte mismatches or `LimitInvalidError` at any tested boundary.
- No missing/duplicate data during seek or chunk transitions.
- Streaming remains stable under client cancellation and concurrent reads.
- p95 TTFB and p95 seek latency are no worse than baseline; meaningful improvement must exceed benchmark noise.
- Peak RSS stays inside documented Docker limits; Telegram rate limits do not regress.

## Deliverables
Write these files (create `reports/` or `plans/` only if appropriate to existing conventions):
1. `reports/telegram-stream-performance-audit.md` — current architecture, exact code references, known bugs, baseline measurements or `PENDING` with commands, bottleneck evidence table, confidence and constraints.
2. `plans/telegram-stream-optimization-roadmap.md` — prioritized implementation-ready phases, impact/effort/risk, validation and rollback instructions, measurable success gates.
3. `plans/telegram-stream-benchmark-runbook.md` — copy-paste commands and sample expected output fields for Docker/host, reproducibility and a privacy-safe measurement format.
4. Optional: scoped benchmarks only when necessary, with offline mocked tests and clear run instructions.

## Reporting instructions
Conclude with:
- Top 3 highest-confidence bottlenecks, or explicitly say evidence is insufficient.
- Top 3 proposed optimizations ranked by **measured** benefit/effort, or `PENDING MEASUREMENTS` when benchmark data is absent.
- What can be implemented safely in the next session vs what requires a live Telegram test.
- A short suggested **next coding-agent prompt for Phase P0 only**, but **do not execute implementation**.
- Tests/commands actually run and their real outputs.

## Non-negotiable restrictions
- **Plan only**: no production code modifications, DB migrations, new services, deployments, or dependency upgrades.
- No paid dependencies, API subscriptions, or extra mandatory microservices.
- Do not introduce generic caching of decrypted private data on disk without explicit security design and approval.
- No guessing at MTProto protocol constants; inspect code and Telegram/Telethon behavior.
- Never leak bot/session keys, Telegram session strings, auth tokens, filenames, message IDs or full private media URLs in logs/reports.
- Do not bypass authorization, flood controls, or Telegram limits.
- Do not optimize only for full-file download at the expense of seeks and partial content.
- If you cannot measure against a running instance, **do not invent performance numbers**: document the limitation and request operator-run benchmarks.
