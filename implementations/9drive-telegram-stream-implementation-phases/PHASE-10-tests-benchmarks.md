# Phase 10 — Automated Tests, Byte Correctness, and Streaming Benchmarks

## Goal

Build a serious regression suite and measured benchmark before declaring Jellyfin fixed.

## Byte Correctness

Use a deterministic fixture or safe Telegram test file with known bytes.

Verify exact bytes for:

```text
full GET
0-1023
middle range
last range
open-ended range
```

A 206 response alone is not success.

## HTTP Semantics

Verify 200/206/416, Content-Length, Content-Range, Accept-Ranges, and MIME behavior.

## Benchmarks

Measure:

```text
TTFB
first chunk latency
average Mbps
peak Mbps
```

for sequential read, mid-file read, and repeated seeks.

Do not hardcode a universal Mbps threshold; report actual results and stability.

## Session Reuse

Compare first request vs subsequent requests and seeks. Confirm no re-login/full client initialization on every range.

## Memory

Verify memory usage does not scale with full file size.

## Cancellation

Verify an old range stops after client abort.

## Concurrency

Use a small bounded concurrency test; do not aggressively stress Telegram.

## Google Regression

Run all existing Google WebDAV tests.

## Deliverable

Create:

```text
docs/audits/telegram-stream-benchmark.md
```

with measured results.

No Playwright.
