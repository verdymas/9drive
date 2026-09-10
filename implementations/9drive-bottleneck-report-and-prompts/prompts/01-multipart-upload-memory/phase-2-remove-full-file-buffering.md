# Phase 2 — Remove Full-File Buffering from Multipart Upload

**Bottleneck:** B1 — Multipart upload memory amplification  
**Phase:** 2 of 3

## Objective

Eliminate the `Buffer[]` + `Buffer.concat()` multipart implementation so memory usage no longer scales with file size, while preserving the same multipart endpoint, routing, upload-session state, and provider support.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/config/env.ts`
- `backend/src/modules/s3/s3.service.ts`
- `backend/src/modules/google/google.service.ts`
- `backend/src/modules/telegram/telegram.service.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

The audited implementation receives the Busboy file stream, stores every chunk in an array, then calls `Buffer.concat(chunks)`. S3 and Google are then fed `Readable.from(fileBuffer)`, while Telegram writes the same buffer to a temp file.

The safer compatibility-first design is a bounded spool/stream pipeline. Because multipart metadata ordering may prevent immediate placement/provider selection, a temp spool is an acceptable fallback. The key invariant is: never hold the complete file in RAM.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Remove all full-file chunk accumulation and `Buffer.concat()` from the multipart path.
2. Introduce a bounded stream/spool primitive under the uploads module. Use `UPLOAD_TEMP_DIR`; do not invent a second unrelated temp root.
3. Count bytes while streaming and preserve the existing declared-size mismatch validation.
4. Ensure multipart files can be safely staged even if metadata/placement cannot be fully resolved before file data arrives.
5. After placement is known, feed a `Readable`/file stream into S3 and Google upload boundaries. For Telegram, retain a file-path based spool if the Telegram API requires it.
6. Guarantee temp cleanup for success, provider error, validation failure, request abort, parser error, and mixed batch outcomes.
7. Keep batch semantics and `pendingUploads` safe: concurrency must not permit unbounded memory or temp-file leakage.
8. Keep `MAX_UPLOAD_BYTES` enforcement and Busboy limits intact.
9. Make temporary file names collision-safe and user/request/session-safe; never use unsanitized client filenames as filesystem paths.

## Tests and Verification

- Add a test that generates a large stream lazily and proves no complete-file Buffer is constructed by the application path.
- Test exact declared-size match and mismatch.
- Test client/request abort cleanup.
- Test S3, Google, and Telegram provider branches with mocks.
- Run focused upload tests and the backend suite.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*upload*`
- `docs/application/workflows/*upload*`
- `docs/runbooks/*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] No multipart code path builds a Buffer proportional to complete file size.
- [ ] `POST /api/v1/uploads` remains backward compatible.
- [ ] Automatic placement and folder materialization behavior is preserved.
- [ ] Temporary files are removed on every terminal path.
- [ ] Actual streamed byte count remains validated.
- [ ] Resumable upload endpoints remain unchanged.

## Do Not

- Do not lower `MAX_UPLOAD_BYTES` as the primary fix.
- Do not remove multipart batch upload.
- Do not require clients to switch to resumable upload.
- Do not implement Phase 3 provider fast paths unless required for correctness.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
