# Phase 3 — Add Optional Direct S3 Multipart Upload Fast Path

**Bottleneck:** B2 — backend as centralized file data plane  
**Phase:** 3 of 4

## Objective

Add a direct-to-S3 multipart upload mode for eligible browser/API uploads so payload bytes can bypass the backend, while keeping the current multipart and resumable upload APIs fully supported.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/modules/s3/s3.service.ts`
- `backend/src/modules/storage/upload-placement.service.ts`
- `backend/src/modules/uploads/storage-routing.service.ts`
- `frontend/src/context/UploadContext.ts`
- `backend/prisma/schema.prisma`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

After B1, server-side upload should already be bounded-memory. This phase is a throughput optimization, not a safety prerequisite.

Automatic storage routing must still decide the destination account. The backend must create/track an upload session and control the exact S3 key. The client must never receive S3 credentials.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Design an eligibility check: direct upload is available only when automatic/manual placement resolves to an S3 account that supports signing.
2. Add authenticated init/sign/complete/abort endpoints or an equivalent secure flow for S3 Multipart Upload.
3. Keep the server authoritative over bucket, key, object metadata, expected size, target account, folder placement, and final DB registration.
4. Use short-lived presigned part URLs. Validate part numbers, session ownership, expected size, and final completion state.
5. Update the frontend upload context to use direct S3 upload only when the init response advertises it; keep existing resumable/server upload as fallback for every provider.
6. Preserve progress reporting, cancellation, automatic routing, and upload-session status.
7. Clean up incomplete S3 multipart uploads on explicit cancel and provide a recovery/sweeper strategy for abandoned sessions.
8. Do not mark a `File` active until S3 completion is confirmed.

## Tests and Verification

- Test init authorization and routing.
- Test part signing ownership and bounds.
- Test complete/abort flows.
- Test frontend fallback when direct S3 is disabled or unavailable.
- Test that Google/Telegram behavior is unchanged.
- Run upload/storage/S3 tests and frontend UploadContext tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*upload*`
- `docs/application/integrations/*s3*`
- `docs/application/workflows/*upload*`
- `docs/reference/*environment*`
- `docs/runbooks/*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Existing upload APIs continue to work.
- [ ] Eligible S3 browser uploads can transfer parts directly to S3.
- [ ] No storage credential reaches the browser.
- [ ] Automatic storage routing remains authoritative.
- [ ] Failed/abandoned multipart uploads do not create active logical files.
- [ ] Feature can be disabled without migration.

## Do Not

- Do not require all S3-compatible vendors to support the fast path.
- Do not remove server-side S3 upload.
- Do not alter Google/Telegram upload semantics.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
