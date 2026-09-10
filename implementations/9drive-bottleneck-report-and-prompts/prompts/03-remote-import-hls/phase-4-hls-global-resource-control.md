# Phase 4 — Global HLS Segment and FFmpeg Resource Control

**Bottleneck:** B3 — Remote Import/HLS temp-disk and FFmpeg pressure  
**Phase:** 4 of 4

## Objective

Bound aggregate HLS segment downloads and FFmpeg activity across all jobs so multiple imports cannot multiply per-job concurrency into unsafe global load.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/remote-imports/processor.ts`
- `backend/src/modules/remote-imports/hls/segments.ts`
- `backend/src/modules/remote-imports/hls/ffmpeg.ts`
- `backend/src/modules/remote-imports/hls/output.ts`
- `backend/src/modules/remote-imports/worker.ts`
- `backend/src/config/env.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

`REMOTE_IMPORT_HLS_SEGMENT_CONCURRENCY` controls segment concurrency inside a job. With multiple HLS jobs, aggregate segment requests can become `jobs × per-job concurrency`. FFmpeg processes similarly need an aggregate bound.

Phase 2 should already have an active HLS job budget. This phase adds finer global resource control.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Add a process-wide/global semaphore for active HLS segment fetches in addition to existing per-job limits.
2. Add a bounded FFmpeg execution slot mechanism so the number of simultaneous FFmpeg processes is explicit and configurable.
3. Ensure cancellation while waiting on a semaphore releases/does not leak permits.
4. Keep per-job fairness reasonable so one large HLS import does not permanently starve others.
5. Integrate resource counters with Phase 1 diagnostics.
6. Preserve current HLS validation, key/manifest/segment limits, remux/re-encode/repair fallback, retry stages, and timeout behavior.
7. Make limits configuration-driven with safe defaults.

## Tests and Verification

- Test aggregate segment concurrency using deterministic mocked segment fetches.
- Test FFmpeg slot limit with mocked/spawn-controlled processes.
- Test cancellation while queued for resources.
- Run HLS unit tests and the FFmpeg-backed integration test when FFmpeg is available.
- Verify temp cleanup and retry behavior.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/REMOTE_IMPORTS.md`
- `docs/WORKERS.md`
- `docs/reference/*environment*`
- `docs/runbooks/*hls*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Aggregate segment activity is bounded independently of HLS job count.
- [ ] Concurrent FFmpeg process count is bounded.
- [ ] No semaphore permit leaks occur.
- [ ] HLS recovery and quality-selection behavior remains unchanged.

## Do Not

- Do not remove HLS re-encode/repair fallbacks.
- Do not replace current safety limits with only a global concurrency limit.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
