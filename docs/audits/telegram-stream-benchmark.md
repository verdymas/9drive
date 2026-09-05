# Telegram Stream — Byte Correctness and Throughput Benchmark

Phase 10 deliverable. This document records what the deterministic
test suite in `services/telegram-stream/tests/` proves. **No live
Telegram account is contacted.** Live measurements are Phase 11 and
require an operator run.

## 1. Byte correctness

The range math that silently corrupts playback when it is wrong lives in
`engine.iter_bytes`. `tests/test_engine.py` pins it against a fake
Telethon download iterator:

| Case | Assertion |
|---|---|
| Trim + early stop | chunks `[AAAA, BBBB, CCCC]`, `length=6` → exactly `AAAABB`, and the iterator is closed (sender released, not leaked) |
| Short read | fewer bytes than the recorded size → `SHORT_READ` / `502`, **never** a truncated body under a 200/206 |
| Offset is bytes | `start=17` reaches Telethon as `offset=17`, not a chunk index |
| request_size clamp | a 4 MiB configured chunk reaches Telethon as `512 * 1024` (its own cap) |
| Peer marker | `_peer("4458806678") == -1004458806678`, idempotent on the already-marked form |

`tests/test_stream_contract.py` covers the HTTP layer with the same
determinism: a conftest fixture replaces `resolve_document` and
`iter_bytes` with a generator where `byte i == i % 256`, so the handler's
real range math, real pre-commit resolution and real header/status logic
are all under test while MTProto is stubbed.

**A 206 status alone is not success.** Every contract test asserts the
exact byte sequence.

## 2. HTTP semantics

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

## 3. Cancellation

Cancellation is structural rather than flag-driven, so it is asserted by
construction rather than by a timing test: Starlette throws
`CancelledError` into the streaming generator on client disconnect, the
generator's `except` marks `cancelled` and increments the counter, and
its `finally` closes the Telethon download iterator — which releases the
sender and stops the in-flight request.

The bookkeeping deliberately does **not** live in a Starlette background
task: those are skipped on client disconnect, which is the common case
here (every Jellyfin seek abandons the previous range), and the
active-stream gauge would climb forever with no `stream_end` line for the
abandoned range. `test_engine.py::test_trims_to_exact_length_and_stops_early`
asserts the close in the normal-completion path.

## 4. Memory

`iter_bytes` yields one Telethon chunk at a time and never concatenates,
so the Python heap does not grow with the file size — at most one
`request_size` (≤ 512 KiB) buffer per active stream. There is no queue
and no prefetch buffer to bound: reads are sequential.

## 5. Session reuse

`tests/test_client_manager.py` asserts:

- First `get_client(provider_id)` builds + starts the underlying client
  once.
- Subsequent calls return the same object (no factory call, no
  `start`) — **no login per range, so a seek does not re-authenticate**.
- A stopped client triggers one reconnect; `reconnect_count` is bumped.
- `invalidate` stops the client and removes the entry; a subsequent
  `get_client` is a fresh build. `engine.resolve_document` calls this on
  a `TELEGRAM_REAUTH_REQUIRED` classification so a rejected auth key is
  not reused.
- `shutdown` stops all clients; calling it twice is a no-op.

## 6. Google regression

Full backend vitest suite: **1020 tests pass** (81 files). Includes:

- `src/modules/files/stream-google-file.test.ts` (Google path).
- `src/modules/s3/*.test.ts` (S3 path).
- `src/modules/webdav/webdav-no-decrypt.test.ts` (Phase 07
  regression: WebDAV read path never loads the metadata crypto module,
  regardless of whether the streaming service is configured).

## 7. Session-format security contract

`tests/test_cross_side_contract.py` (Python) and
`src/modules/telegram/telegram-stream-auth.test.ts` (Node) pin the
canonical string format and the HMAC digest shape. Both sides
recompute the same 64-char hex digest for the same inputs. If either
side changes the canonical string, both tests fail in lockstep —
intentional: the contract is bilateral.

`src/modules/telegram/telethon-session.test.ts` pins the GramJS →
Telethon session repack field by field, including the 352-byte payload
length that Telethon's parser uses to decide IPv4 vs IPv6.

## 8. Limitations of this benchmark

Every number here comes from a deterministic fake, not a real Telegram
DC. There are **no measured throughput numbers in this document.** Live
measurement requires:

- A real Telegram user session + storage channel.
- A real Telegram-backed file of known size.
- A network path that allows a sustained long-lived MTProto session
  (e.g. a residential connection, not a corporate firewall that resets
  long-poll sockets).

Phase 11 captures the live numbers. The service exposes `/ready` and
emits a `stream_end` JSON line per request with `ttfb_ms`, `avg_mbps`,
`bytes`, `chunks`, `cancelled`, `status` and `error` so live numbers can
be aggregated from logs.

## 9. Summary

| Area | Status | Where to verify |
|---|---|---|
| Byte correctness (trim, offset, clamp) | PASS | `test_engine.py` (4 cases) |
| Short read is an error, not a truncated body | PASS | `test_engine.py` |
| HTTP semantics (200/206/416) | PASS | `test_stream_contract.py` (9 cases) |
| Cancellation releases the sender | PASS | structural (generator `finally`) + `test_engine.py` |
| Memory bounded | PASS | design: one chunk at a time, no concat |
| Session reuse, no login per range | PASS | `test_client_manager.py` (6 cases) |
| Secret redaction | PASS | `test_observability.py` (7 cases) |
| Google/S3/WebDAV regression | PASS | full vitest suite (1020 tests) |
| Cross-side HMAC contract | PASS | `test_cross_side_contract.py` + Node auth test |
| Session repack | PASS | `telethon-session.test.ts` |
| Reauth mirrored into the account | PASS | live WebDAV probe + `telegram-stream-gateway.test.ts` |
| Suffix range / 416 reach the service intact | PASS | live WebDAV probe (§12) + `webdav-telegram-routing.test.ts` |
| Client disconnect cancels the Telegram read | PASS | live WebDAV probe (§12) + `webdav-telegram-routing.test.ts` |
| Live throughput | MEASURED | §12: 32 Mbps sequential, TTFB 67–695 ms |

Service suite total: **42 pytest tests**. Backend: **1020 vitest tests**.

## 10. Live validation (Phase 11)

Live Jellyfin + rclone validation requires a real Telegram user
account, a real storage channel, and a real WebDAV deployment with
the streaming service running. **This repo does not have those
credentials.** The operator runs the procedure in
`docs/implementation/telegram-stream-validation.md`, captures the
metrics, and appends the results here.

Capture fields:

- TTFB (ms) — from `ttfb_ms` in `stream_end` JSON.
- Average Mbps — from `avg_mbps` in `stream_end` JSON.
- FloodWait count — from `total_flood_waits` in `/ready`.
- FILE_REFERENCE refresh count — from `total_file_reference_refreshes` in `/ready`.
- Cancellation count — from `total_cancellations` in `/ready`.
- Memory peak — `docker stats telegram-stream` (RSS).

If a real run produces numbers, replace this section with a table:

| Scenario | TTFB | Avg Mbps | FloodWaits | Cancellations | RSS peak |
|---|---|---|---|---|---|
| (filled by operator) | | | | | |

## 11. Final summary (Phase 12)

```
telegram-stream:        PASS (skeleton, auth, range, observability, compose)
Internal Auth:          PASS (HMAC, constant-time, Range-in-canonical, ±30s skew)
Telegram Client Reuse:  PASS (one client per providerId, no login per range)
Range Streaming:        PASS (200/206/416, exact bytes, no whole-file download)
Prefetch:               N/A  (sequential reads; prototype deleted unused — see §4)
Backpressure:           PASS (one chunk at a time; the generator yields at consumer pace)
Cancellation:           PASS (CancelledError → generator finally → download iterator closed)
WebDAV Telegram:        PASS (gateway wired into streamProviderFileToReadable + dispatcher)
Jellyfin Playback:      NOT VERIFIED (needs a live rclone mount + Jellyfin scan; byte path proven in §12)
Jellyfin Seek:          NOT VERIFIED (same; abort/cancellation proven in §12)
rclone:                 NOT VERIFIED (same)
Google Regression:      PASS (1020 backend tests; webdav-no-decrypt invariant holds)
Security:               PASS (internal-only, signed, no secret logs, redaction tests, license review)
Docs:                   PASS (audit + benchmark + license review + curl runbook + validation runbook)
Overall:                HEALTHY. Real byte-range playback verified live (§12): exact Matroska bytes,
                        206/416 selection, suffix ranges, cancellation. Jellyfin/rclone E2E still
                        pending an operator run against the mount.
```

## 12. Live end-to-end probe (this repo, valid session)

The full WebDAV→gateway→telegram-stream→Telegram path was exercised against
the real deployment. File: `/webdav/NS/id/<name>.mkv`, 321050482 bytes,
`telegram://4458806678/41`, account `fbc151a0-…`.

| Request | Result | What it proves |
|---|---|---|
| `HEAD` | `200`, `Content-Length: 321050482`, `Content-Type: video/matroska` | PROPFIND/HEAD stay DB-only; no Telegram call, no crypto load |
| `GET` no Range | `200`, `Content-Length: 321050482`, 321050482 bytes, magic `1a45dfa3` | full read is byte-exact; `ttfb_ms: 695`, `avg_mbps: 32.2` over 613 chunks |
| `Range: bytes=0-1023` | `206`, `Content-Range: bytes 0-1023/321050482`, 1024 bytes, magic `1a45dfa3` | head range is byte-exact Matroska; `ttfb_ms: 157` |
| `Range: bytes=-1024` | `206`, `Content-Range: bytes 321049458-321050481/321050482`, 1024 bytes | **suffix range** reaches Telegram intact; `ttfb_ms: 67`. Before the fix this was a `200` + 321 MB |
| `Range: bytes=321050482-` | `416`, `Content-Range: bytes */321050482`, `Content-Type: application/json` | past-EOF is a real 416 (RFC 7233), not a 200 full-file |
| `Range: bytes=foo` | `416`, `Content-Type: application/json` | malformed range rejected, error envelope not mislabelled as video |
| ranged GET aborted after 655360 B | `stream_end` `cancelled: true`, `/ready` `total_cancellations: 1`, `active_streams: 0` | client disconnect propagates through pipe → fetch abort → Telethon iterator close; no leaked MTProto download |

TTFB is 67–695 ms and throughput 32 Mbps on a full sequential read, so the
sequential single-request design (§4, `engine.py` `ponytail:`) is not the
bottleneck for typical playback bitrates. No prefetch added.

**Client parity.** `telegram-stream` is Telethon 1.44.0 (layer 227,
`message#7600b9d3`); the backend upload/sync stack is teleproto 1.229.0
(layer 229, same `message` constructor). The auth key is shared, so Telegram
serves the newer constructor to both. Earlier Telethon releases (≤ 1.43) did
not know `7600b9d3` and would crash a `messages.getMessages` response with an
unhandled `TypeNotFoundError`; the fix is the bump plus a `_classify` clause
mapping that error to `TELEGRAM_LAYER_MISMATCH` / 502 so any future drift
degrades to a logged, enveloped failure rather than a bare 500.

**Still not proven here:** Jellyfin/rclone behaviour end to end (§10 runbook)
and sustained multi-GB playback.
