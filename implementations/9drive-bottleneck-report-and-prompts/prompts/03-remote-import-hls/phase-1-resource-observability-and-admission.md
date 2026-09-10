# Phase 1 — Remote Import Resource Observability and Admission Control

**Bottleneck:** B3 — Remote Import/HLS temp-disk and FFmpeg pressure  
**Phase:** 1 of 4

## Objective

Prevent Remote Import jobs from starting when local temp-disk capacity is unsafe. Add resource measurements and a recoverable waiting/admission state without removing current retry, cancel, or temp-file behavior.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/remote-imports/worker.ts`
- `backend/src/modules/remote-imports/processor.ts`
- `backend/src/modules/remote-imports/temp-storage.ts`
- `backend/src/modules/remote-imports/queue.ts`
- `backend/src/modules/remote-imports/remote-import.service.ts`
- `backend/src/config/env.ts`
- `backend/prisma/schema.prisma`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

Current Remote Import materializes temporary data under `REMOTE_IMPORT_TEMP_DIR`. HLS may require segment storage and FFmpeg output in addition to final payload size.

The queue currently controls job concurrency, but concurrency is not the same as disk availability. A job should wait/requeue safely when starting it would violate a configured free-space reserve.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Add a temp-storage resource inspection helper using filesystem statistics supported by the target Node runtime/platform.
2. Add configurable minimum free-space/safety-reserve settings with conservative defaults and documentation.
3. Estimate a job reservation requirement using known `contentLength`/expected size where available. For unknown-size or HLS jobs, use conservative configurable policy rather than pretending the size is known.
4. Before entering a disk-heavy stage, perform admission checking. Resource shortage must be represented as recoverable waiting/requeue behavior, not a terminal import failure.
5. Make admission race-resistant enough for multiple worker jobs. If exact reservation accounting is added, ensure reservations are released on every terminal/requeue path.
6. Expose structured resource diagnostics: free bytes, reserved/required estimate, stage, import id, and reason for deferral.
7. Preserve existing temp sweeper, retry, cancel, heartbeat, stale-job reconciliation, and SSRF protections.

## Tests and Verification

- Unit-test free-space threshold decisions.
- Test reservation release on success, failure, cancel, and requeue.
- Test unknown-size policy.
- Test that a resource-starved job is recoverable and does not become falsely completed/failed.
- Run Remote Import queue/service/processor tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/REMOTE_IMPORTS.md`
- `docs/WORKERS.md`
- `docs/application/features/*remote*`
- `docs/runbooks/*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Remote Import cannot intentionally consume the configured safety reserve.
- [ ] Resource shortage defers work instead of destroying job intent.
- [ ] No reservation leaks remain after terminal paths.
- [ ] Existing retry/cancel/temp cleanup semantics remain intact.
- [ ] No provider or HLS feature is removed.

## Do Not

- Do not solve this only by lowering concurrency.
- Do not delete temp files that are required for resumable retry stages.
- Do not mark resource deferral as an ordinary download/provider failure.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
