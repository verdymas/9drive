# Prompt Index

Use one phase at a time. Recommended order is in `../IMPLEMENTATION_ROADMAP.md`.

## 01-multipart-upload-memory
- [`phase-1-boundaries-and-tests.md`](01-multipart-upload-memory/phase-1-boundaries-and-tests.md) — Phase 1 — Establish Multipart Upload Boundaries and Regression Tests
- [`phase-2-remove-full-file-buffering.md`](01-multipart-upload-memory/phase-2-remove-full-file-buffering.md) — Phase 2 — Remove Full-File Buffering from Multipart Upload
- [`phase-3-provider-streaming-and-abort.md`](01-multipart-upload-memory/phase-3-provider-streaming-and-abort.md) — Phase 3 — Provider-Native Streaming, Backpressure, and Abort Handling

## 02-centralized-data-plane
- [`phase-1-proxy-hardening.md`](02-centralized-data-plane/phase-1-proxy-hardening.md) — Phase 1 — Harden Proxy Streaming and Introduce Delivery Decisions
- [`phase-2-s3-direct-download.md`](02-centralized-data-plane/phase-2-s3-direct-download.md) — Phase 2 — Add Secure Direct S3 Download Fast Path
- [`phase-3-s3-direct-upload.md`](02-centralized-data-plane/phase-3-s3-direct-upload.md) — Phase 3 — Add Optional Direct S3 Multipart Upload Fast Path
- [`phase-4-media-process-isolation.md`](02-centralized-data-plane/phase-4-media-process-isolation.md) — Phase 4 — Isolate Media-Heavy Proxy Traffic

## 03-remote-import-hls
- [`phase-1-resource-observability-and-admission.md`](03-remote-import-hls/phase-1-resource-observability-and-admission.md) — Phase 1 — Remote Import Resource Observability and Admission Control
- [`phase-2-separate-resource-concurrency.md`](03-remote-import-hls/phase-2-separate-resource-concurrency.md) — Phase 2 — Separate Direct-Import and HLS Concurrency Budgets
- [`phase-3-stream-through-direct-import.md`](03-remote-import-hls/phase-3-stream-through-direct-import.md) — Phase 3 — Add Resumable Stream-Through Direct Import
- [`phase-4-hls-global-resource-control.md`](03-remote-import-hls/phase-4-hls-global-resource-control.md) — Phase 4 — Global HLS Segment and FFmpeg Resource Control

## 04-sync-db-write-amplification
- [`phase-1-instrument-and-classify.md`](04-sync-db-write-amplification/phase-1-instrument-and-classify.md) — Phase 1 — Instrument and Classify Sync Reconciliation
- [`phase-2-batch-safe-writes.md`](04-sync-db-write-amplification/phase-2-batch-safe-writes.md) — Phase 2 — Batch Safe Sync Writes
- [`phase-3-physical-identity-constraint.md`](04-sync-db-write-amplification/phase-3-physical-identity-constraint.md) — Phase 3 — Validate and Enforce Provider Physical Identity

## 05-telegram-sync
- [`phase-1-account-level-concurrency.md`](05-telegram-sync/phase-1-account-level-concurrency.md) — Phase 1 — Telegram Account-Level Concurrency with Single-Flight Safety
- [`phase-2-page-scoped-db-state.md`](05-telegram-sync/phase-2-page-scoped-db-state.md) — Phase 2 — Replace Account-Wide Telegram File Preload with Page-Scoped Lookups
- [`phase-3-bounded-caption-and-batching.md`](05-telegram-sync/phase-3-bounded-caption-and-batching.md) — Phase 3 — Bound Telegram Caption Resolution and Batch Safe Persistence

## 06-webdav-metadata
- [`phase-1-exact-path-lookup-and-indexes.md`](06-webdav-metadata/phase-1-exact-path-lookup-and-indexes.md) — Phase 1 — Replace WebDAV Sibling Scans with Exact Indexed Path Lookups
- [`phase-2-slim-directory-projections.md`](06-webdav-metadata/phase-2-slim-directory-projections.md) — Phase 2 — Slim WebDAV Directory Projections and Lazy-Load Provider Accounts
- [`phase-3-short-lived-cache-and-metrics.md`](06-webdav-metadata/phase-3-short-lived-cache-and-metrics.md) — Phase 3 — Add Short-Lived WebDAV Metadata Cache and Measurements

## 07-god-files
- [`phase-1-decompose-upload-module.md`](07-god-files/phase-1-decompose-upload-module.md) — Phase 1 — Decompose Upload Orchestration Without Changing Contracts
- [`phase-2-decompose-remote-import-processor.md`](07-god-files/phase-2-decompose-remote-import-processor.md) — Phase 2 — Decompose Remote Import Processor into Explicit Phases
- [`phase-3-decompose-telegram-sync-service.md`](07-god-files/phase-3-decompose-telegram-sync-service.md) — Phase 3 — Decompose Telegram Sync Service by Responsibility
- [`phase-4-decompose-frontend.md`](07-god-files/phase-4-decompose-frontend.md) — Phase 4 — Decompose Large Frontend Pages and Drive Components
