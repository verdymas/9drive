# Phase 08 — Streaming Observability, Health, and Metrics

## Goal

Make Telegram buffering diagnosable.

## Health

Extend `/health` with safe readiness information only.

## Metrics / Structured Logs

Track at least:

```text
active streams
TTFB
first Telegram chunk latency
bytes emitted
average Mbps
instant Mbps
peak Mbps
range start/end
chunk fetch latency
prefetch queue depth
parallel chunk count
client abort count
FILE_REFERENCE refresh count
FloodWait count
Telegram client cache hit
media session cache hit
```

Use existing OpenTelemetry/Prometheus conventions if present; otherwise keep it lightweight.

## Backend Correlation

Add safe request correlation in 9Drive gateway:

```text
requestId
fileId
providerId
range
status
upstream TTFB
```

Never log WebDAV password, Telegram session, API hash, OTP, auth token, or crypto secrets.

## Diagnostics

Make it possible to distinguish:

```text
slow Telegram
slow internal proxy
wrong range
low throughput
reconnect per seek
client abort issues
FloodWait/rate limits
```

## Tests

Verify metrics update, cancelled/failed stream counters, correlation, and secret redaction.
