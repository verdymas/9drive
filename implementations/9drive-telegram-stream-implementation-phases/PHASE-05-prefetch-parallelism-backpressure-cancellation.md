# Phase 05 — Bounded Prefetch, Parallelism, Backpressure, and Cancellation

## Goal

Improve stability/throughput without turning `telegram-stream` into an uncontrolled downloader.

## Reference

Use `references/telegram-stremio` as the main architectural reference. Do not copy code.

## Conservative Defaults

Start approximately with:

```text
chunk size = 1 MiB
prefetch = 3
parallelism = 2
```

Change only after measurement.

## Bounded Prefetch

Use a bounded queue. Never prefetch the entire remaining file.

## Parallel Chunk Fetch

Where safe, fetch a small number of future chunks concurrently, but emit in exact byte order.

## Backpressure

Respect downstream consumption. Avoid greedily fetching while the internal HTTP consumer is slow.

## Cancellation

On client disconnect / seek:

```text
cancel pending chunk tasks
stop prefetch
stop old range work
release request-scoped resources
```

A superseded Jellyfin range must not continue consuming Telegram bandwidth.

## FloodWait / Retry

Use bounded retries and existing provider strategy. Do not retry forever.

## Tests

Verify ordered output, bounded queue, cancellation, no background download after abort, retry caps, FloodWait mapping, and backpressure behavior.

## Performance Report

Compare baseline vs prefetch with TTFB and average Mbps. Do not declare success from unit tests alone.
