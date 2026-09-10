# Phase 1 — Establish Multipart Upload Boundaries and Regression Tests

**Bottleneck:** B1 — Multipart upload memory amplification  
**Phase:** 1 of 3

## Objective

Prepare the multipart upload path for a safe streaming refactor without changing its external behavior yet. Extract responsibilities just enough to make the current contract testable and add regression coverage that protects routing, response shape, size validation, and cleanup semantics.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/modules/uploads/storage-routing.service.ts`
- `backend/src/modules/storage/upload-placement.service.ts`
- `backend/src/modules/s3/s3.service.ts`
- `frontend/src/context/UploadContext.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

The multipart handler in `upload.routes.ts` currently mixes Busboy parsing, placement, upload-session state, provider execution, quota refresh, response aggregation, and full-file buffering. The dashboard uses the resumable flow, while the multipart endpoint remains important for API compatibility and external clients.

This phase is intentionally preparatory. It should reduce refactor risk without yet introducing a large provider behavior change.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Identify and document the exact current contract of `POST /api/v1/uploads`, including single-file response, batch response, validation failures, `filesMeta`, declared size handling, folder placement, and provider routing.
2. Extract small testable helpers/services only where needed to separate multipart metadata/response orchestration from provider-specific upload code. Keep `handleUpload` and the route contract stable.
3. Add deterministic tests for single-file and batch multipart behavior. Mock provider boundaries; do not require live Google/S3/Telegram credentials.
4. Add tests for declared size required, maximum size, actual streamed byte mismatch, provider failure, no eligible account, and mixed batch success/failure.
5. Add cleanup assertions for any existing staged/temp paths used by multipart/resumable flows.
6. Add lightweight structured diagnostic counters/log fields if the project already has an established logging pattern; do not introduce a new observability platform in this phase.

## Tests and Verification

- Run the focused upload/storage-routing tests.
- Run the backend test suite if practical.
- Verify the dashboard resumable flow is untouched and its existing tests still pass.
- Verify the multipart tests do not construct multi-gigabyte in-memory fixtures.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*upload*`
- `docs/application/workflows/*upload*`
- `docs/reference/*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Multipart route contract is captured by tests.
- [ ] Provider calls are mockable behind clear boundaries.
- [ ] No endpoint, provider, response shape, routing rule, or resumable behavior is removed.
- [ ] Current full-buffer behavior may still exist at the end of this phase, but it is isolated enough to replace in Phase 2.

## Do Not

- Do not change the public upload API in this phase.
- Do not add presigned/direct S3 upload yet.
- Do not attempt a full rewrite of `upload.routes.ts`.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
