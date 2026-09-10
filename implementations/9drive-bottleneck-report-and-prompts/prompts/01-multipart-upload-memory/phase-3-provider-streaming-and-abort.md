# Phase 3 — Provider-Native Streaming, Backpressure, and Abort Handling

**Bottleneck:** B1 — Multipart upload memory amplification  
**Phase:** 3 of 3

## Objective

Optimize the bounded multipart pipeline so S3 and Google can consume incoming/staged streams efficiently, while Telegram retains a safe spool fallback. Harden cancellation, backpressure, provider partial-failure cleanup, and upload-session state transitions.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/modules/s3/s3.service.ts`
- `backend/src/modules/google/google.service.ts`
- `backend/src/modules/telegram/telegram.service.ts`
- `backend/src/modules/storage/folder-materialization.service.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

Phase 2 should have removed full-file buffering. This phase improves data flow and cancellation without changing external upload contracts.

S3's `uploadS3Object(...)` already accepts a Node readable stream through `@aws-sdk/lib-storage`. Google supports stream bodies/resumable upload patterns. Telegram currently has a path-oriented upload flow and may continue to use staged disk.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Prefer direct bounded stream piping from multipart/staged source into `uploadS3Object(...)` when placement is resolved safely.
2. For Google uploads, use a provider-supported streaming/resumable body without materializing the entire payload. Preserve current parent-folder placement and post-upload behavior.
3. Keep Telegram on a staged file path unless the current Telegram library has a proven safe streaming API. Do not force a speculative abstraction.
4. Propagate request abort/cancellation to provider upload operations where supported.
5. Stop reading or resume/drain request streams safely after terminal failures so Express/Busboy does not hang.
6. Handle provider partial success carefully: do not leave active DB rows for failed uploads; clean provisional S3/Telegram rows according to current semantics.
7. Ensure quota refresh remains asynchronous/best-effort as currently intended.
8. Add upload-duration and streamed-byte diagnostic fields using the existing logging approach.

## Tests and Verification

- Test abort during provider upload.
- Test provider error after partial stream consumption.
- Test size mismatch after provider transfer and verify DB/session failure state remains consistent.
- Run all upload/storage provider unit tests.
- Perform a local large-file smoke test using generated data if the environment supports it; report observed RSS rather than claiming a fixed memory target.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*upload*`
- `docs/application/integrations/*`
- `docs/application/workflows/*upload*`
- `docs/runbooks/*upload*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] S3/Google multipart transfer uses bounded streams rather than file-size memory.
- [ ] Telegram remains fully functional through safe temp spooling.
- [ ] Client abort does not leave indefinitely running provider transfers.
- [ ] UploadSession and File states remain coherent after provider failures.
- [ ] All existing upload API behaviors remain supported.

## Do Not

- Do not introduce S3 presigned client upload in this phase; that belongs to B2.
- Do not change automatic storage-routing semantics.
- Do not remove the disk-spool fallback.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
