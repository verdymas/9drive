# Multipart Upload Memory — TODO

Status: all three implementation phases are complete and verified.

## Phase 1 — Boundaries and regression tests

- [x] Capture the existing `POST /api/v1/uploads` single-file, batch, validation, `filesMeta`, routing, and folder-placement contract in tests.
- [x] Extract small multipart metadata/temporary-file helpers while retaining the route’s public contract.
- [x] Add deterministic mocked-provider coverage for single uploads, batches, mixed outcomes, provider failure, missing placement, required declared size, maximum size, and actual-size mismatch.
- [x] Assert staged temporary-file cleanup behavior.
- [x] Keep the dashboard resumable-upload path and its public behavior unchanged.
- [x] Document the multipart API contract and upload workflow.

## Phase 2 — Remove full-file buffering

- [x] Remove multipart chunk-array accumulation and `Buffer.concat()`.
- [x] Add a collision-safe multipart spool primitive under `UPLOAD_TEMP_DIR`.
- [x] Count streamed bytes and reject declared-size mismatches before provider handoff.
- [x] Preserve Busboy and `MAX_UPLOAD_BYTES` limits.
- [x] Stage safely while metadata and automatic placement are being resolved.
- [x] Pass file streams to Google Drive and S3; retain a safe staged file path for Telegram.
- [x] Clean temporary files on success, validation errors, provider errors, parser errors, aborted requests, and mixed batches.
- [x] Cover lazy large-stream spooling, exact/mismatched sizes, abort cleanup, and all provider branches with tests.

## Phase 3 — Provider streaming, aborts, and state consistency

- [x] Stream the staged source into S3 and Google without materializing the file in memory.
- [x] Preserve Telegram’s path-based staged upload flow.
- [x] Propagate request cancellation to Google and S3 provider operations where supported.
- [x] Drain/destroy multipart streams safely after terminal failures or client aborts.
- [x] Compensate provider partial successes and ensure failed uploads do not leave active File records or completed upload sessions.
- [x] Retry and log failed Telegram remote cleanup attempts.
- [x] Keep quota refresh asynchronous and best-effort.
- [x] Add streamed-byte and duration diagnostics to upload logs.
- [x] Add regressions for provider aborts, partial failures, cleanup compensation, and completion-session ordering.

## Verification

- [x] Focused upload/storage suite: 81 tests passed.
- [x] Full backend suite: 84 files and 1,049 tests passed.
- [x] Backend TypeScript build passed.
- [x] `git diff --check` passed.

## Follow-up consideration

- [ ] Optionally add a scheduled reconciliation job for remote Telegram objects whose cleanup still fails after the immediate retry.
