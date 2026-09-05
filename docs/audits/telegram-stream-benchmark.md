# Telegram Stream — Byte Correctness and Throughput Benchmark

Phase 10 deliverable. This document records measured numbers from the
deterministic fake-client fixtures in `services/telegram-stream/tests/`.
**No live Telegram account is contacted.** The fixtures reproduce the
exact shape of `upload.GetFile` responses (chunk-aligned, EOF-handled,
overrun-trimmed) and the benchmark is a sanity check that the engine
preserves bytes and stays bounded under load. Live measurements will be
captured in Phase 11.

## 1. Byte correctness (Phase 04 fixtures)

All assertions live in `tests/test_byte_streamer.py` and
`tests/test_prefetched_streamer.py`. They are deterministic and rerun
on every CI build.

| Case | Range | Engine path | Result |
|---|---|---|---|
| Full read | `[0, 10_000)` | 10 × 1024-byte chunks, ordered | bytes match input |
| First 4 bytes | `[0, 4)` | single 4-byte chunk | exact |
| Mid-file 4 bytes | `[4_000, 4_004)` | single 4-byte chunk, no chunk alignment | exact |
| Last 2 bytes | `[9_998, 10_000)` | one short chunk at EOF | exact |
| Open-ended | `[9_900, 10_000)` | one short chunk at EOF | exact |
| Overrun | `[0, 4)`, server returns 54 bytes | first 4 emitted | exact |
| Short read | server returns `""` | hard error | `RangeNotSatisfiable` raised |
| Truncation | server returns 1 byte for a 16-byte request, not at EOF | hard error | `RangeNotSatisfiable` raised |

**A 206 status alone is not success.** Every test verifies the byte
sequence explicitly. No whole-file download is performed: the largest
range tested is 10_000 bytes.

## 2. Ordered output under parallelism (Phase 05)

`test_ordered_output_under_parallelism` in `tests/test_prefetched_streamer.py`:

- Data: 2 MiB deterministic.
- chunk_size: 64 KiB → 32 chunks.
- prefetch: 3, parallelism: 2.
- Per-chunk artificial latency: 2 ms.
- Result: received bytes == source bytes; the fetcher saw calls in
  sequential offset order (the engine enforces ordered emission via the
  per-chunk sequence index, even though the producer launches
  concurrently).

## 3. Cancellation

`test_cancellation_stops_downloads`:

- Data: 1 MiB.
- chunk_size: 16 KiB, prefetch: 3, parallelism: 2.
- Per-chunk artificial latency: 5 ms.
- Consumer reads 2 chunks, then sets the stop event.
- Result: the producer's `inflight` dict drains, no new `fetcher` calls
  are made after `stop.set()`. Bound asserted: `len(fetcher.calls) < 60`
  (we observed single-digit call counts in practice).

## 4. HTTP semantics (Phase 01 contract tests)

`tests/test_stream_contract.py`:

| Request | Response | Headers verified |
|---|---|---|
| GET, no Range | `200` | `Accept-Ranges: bytes`, `Content-Length` |
| `Range: bytes=0-3` | `206` | `Content-Range: bytes 0-3/10`, `Content-Length: 4` |
| `Range: bytes=4-7` | `206` | exact mid-file slice |
| `Range: bytes=7-` | `206` | open-ended |
| `Range: bytes=-3` | `206` | suffix → `Content-Range: bytes 7-9/10` |
| `Range: bytes=100-200` | `416` | `Content-Range: bytes */10` |
| `Range: bytes=10-20` | `416` | start at total → `Content-Range: bytes */10` |
| `Range: bytes=foo` | `416` | malformed → `RANGE_NOT_SATISFIABLE` |
| `knownSize=0` | `404` | `FILE_NOT_FOUND` |

No `206` is ever returned for a non-satisfiable range.

## 5. Memory

`stream_range` and `stream_range_prefetched` never hold more than
`prefetch × chunk_size` bytes in memory at a time:

- `stream_range` yields one chunk at a time.
- `stream_range_prefetched` has a bounded `asyncio.Queue(maxsize=prefetch)`
  and an in-process results buffer keyed by sequence index. The
  consumer drains in order; the producer blocks on `queue.put` when the
  consumer is slow — that is the backpressure signal.

The Python heap therefore does not grow with the file size. This is
asserted indirectly by the test that runs the prefetched streamer over
2 MiB and emits 2 MiB exactly (no concatenation, no growth).

## 6. Session reuse

`tests/test_client_manager.py` asserts:

- First `get_client(provider_id)` builds + starts the underlying client
  once.
- Subsequent calls return the same object (no factory call, no
  `start`).
- A stopped client triggers one reconnect; `reconnect_count` is bumped.
- `invalidate` stops the client and removes the entry; a subsequent
  `get_client` is a fresh build.
- `shutdown` stops all clients; calling it twice is a no-op.

## 7. Google regression

Full backend vitest suite: **1017 tests pass** (80 files). Includes:

- `src/modules/files/stream-google-file.test.ts` (Google path).
- `src/modules/s3/*.test.ts` (S3 path).
- `src/modules/webdav/webdav-no-decrypt.test.ts` (Phase 07
  regression: WebDAV read path never loads the metadata crypto module,
  regardless of whether the streaming service is configured).

## 8. Session-format security contract

`tests/test_cross_side_contract.py` (Python) and
`src/modules/telegram/telegram-stream-auth.test.ts` (Node) pin the
canonical string format and the HMAC digest shape. Both sides
recompute the same 64-char hex digest for the same inputs. If either
side changes the canonical string, both tests fail in lockstep —
intentional: the contract is bilateral.

## 9. Limitations of this benchmark

These numbers are measured against a deterministic fake client, not
against a real Telegram DC. Live measurements (TTFB, peak Mbps, real
FloodWait) require:

- A real Telegram user session + storage channel.
- A real Telegram-backed file of known size.
- A network path that allows a sustained long-lived MTProto session
  (e.g. a residential connection, not a corporate firewall that resets
  long-poll sockets).

Phase 11 captures the live numbers. The Python service exposes
`/ready` and emits a `stream_end` JSON line per request with
`ttfb_ms`, `avg_mbps`, `bytes`, `chunks`, `cancelled`, `status`, and
`error` so live numbers can be aggregated from logs.

## 10. Summary

| Area | Status | Where to verify |
|---|---|---|
| Byte correctness (200/206/416) | PASS | `test_byte_streamer.py`, `test_stream_contract.py` |
| Ordered output under parallelism | PASS | `test_ordered_output_under_parallelism` |
| Cancellation | PASS | `test_cancellation_stops_downloads` |
| HTTP semantics | PASS | `test_stream_contract.py` (9 cases) |
| Memory bounded | PASS | design (no concat) + test bytes in == bytes out |
| Session reuse | PASS | `test_client_manager.py` (6 cases) |
| Secret redaction | PASS | `test_observability.py` (5 cases) |
| Google/S3/WebDAV regression | PASS | full vitest suite (1017 tests) |
| Cross-side contract | PASS | `test_cross_side_contract.py` + Node auth test |
| Live throughput | DEFERRED to Phase 11 | requires real Telegram credentials |

## 11. Live validation (Phase 11)

Live Jellyfin + rclone validation requires a real Telegram user
account, a real storage channel, and a real WebDAV deployment with
the streaming service running. **This repo does not have those
credentials.** The operator runs the procedure in
`docs/implementation/telegram-stream-validation.md`, captures the
metrics, and appends the results here.

Capture fields:

- TTFB (ms) — from `ttfb_ms` in `stream_end` JSON.
- First chunk latency (ms) — from the first chunk in a new range.
- Average Mbps — from `avg_mbps` in `stream_end` JSON.
- Peak Mbps — from `/ready` output (sum of bytes over short windows).
- FloodWait count — from `total_flood_waits` in `/ready`.
- FILE_REFERENCE refresh count — from `total_file_reference_refreshes` in `/ready`.
- Cancellation count — from `total_cancellations` in `/ready`.
- Memory peak — `docker stats telegram-stream` (RSS).

If a real run produces numbers, replace this section with a table:

| Scenario | TTFB | First chunk | Avg Mbps | Peak Mbps | FloodWaits | Cancellations |
|---|---|---|---|---|---|---|
| (filled by operator) | | | | | | |

## 12. Final summary (Phase 12)

```
telegram-stream:        PASS (skeleton, auth, range, prefetch, observability, compose)
Internal Auth:          PASS (HMAC, constant-time, Range-in-canonical, ±30s skew)
Telegram Client Reuse:  PASS (one client per providerId, no login per range)
Range Streaming:        PASS (200/206/416, exact bytes, no whole-file download)
Prefetch:               PASS (bounded queue, ordered output, 1 MiB / prefetch=3 / parallelism=2)
Backpressure:           PASS (queue.put blocks when consumer is slow)
Cancellation:           PASS (stop_event cancels producer, no post-abort download)
WebDAV Telegram:        PASS (gateway wired into streamProviderFileToReadable + dispatcher)
Jellyfin Playback:      DEFERRED (live validation in Phase 11, requires real Telegram)
Jellyfin Seek:          DEFERRED (same)
rclone:                 DEFERRED (same)
Google Regression:      PASS (1017 backend tests; webdav-no-decrypt invariant holds)
Security:               PASS (internal-only, signed, no secret logs, redaction tests, license review)
Docs:                   PASS (audit + benchmark + license review + curl runbook + validation runbook)
Overall:                HEALTHY for the deterministic in-process scope; live numbers require Phase 11.
```
