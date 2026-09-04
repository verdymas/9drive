# Phase 11 — End-to-End Jellyfin and rclone Validation

## Goal

Validate the real user scenario through the existing 9Drive WebDAV endpoint.

## Jellyfin Validation

With Telegram-backed media:

1. scan library
2. verify file visible
3. start playback
4. measure startup behavior
5. seek forward
6. seek backward
7. resume
8. repeated seeks
9. test a larger file where practical

Capture safe backend + `telegram-stream` diagnostics.

Verify:

```text
PROPFIND works
HEAD works
full GET works
Range GET works
seek causes a new range
old range cancels
throughput remains stable enough for playback
```

## rclone

Verify listing and copying a Telegram-backed file. Compare checksum when practical.

## Google Regression

Play a Google Drive-backed file through the same WebDAV endpoint and verify the old path still works.

## If Buffering Remains

Do NOT blindly increase parallelism.

Classify the bottleneck using metrics:

```text
TTFB
Telegram throughput
session reconnect
range mismatch
proxy backpressure
client cancellation
rate limits
```

Report the proven bottleneck.

## Deliverable

Update `docs/audits/telegram-stream-benchmark.md` with real validation results.
