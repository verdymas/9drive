# Phase 1 — Decompose Upload Orchestration Without Changing Contracts

**Bottleneck:** B7 — oversized modules / engineering throughput  
**Phase:** 1 of 4

## Objective

Reduce responsibilities in the upload route module after B1/B2 upload work is stable. Keep route URLs, response contracts, provider behavior, and exported entry points unchanged.

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
- `backend/src/modules/telegram/telegram.service.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

The upload route has historically combined multipart parsing, resumable sessions, placement, temp files, provider-specific upload/finalization, quotas, and HTTP responses. Earlier bottleneck phases may already have extracted some pieces.

This phase is structural. Do not alter runtime behavior intentionally.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Map responsibilities and current call graph after all previous upload optimizations.
2. Extract multipart orchestration, resumable session logic, provider upload adapters, and upload-session lifecycle into focused modules where boundaries are clear.
3. Keep route handlers thin: parse/authenticate -> call service -> translate result to HTTP.
4. Keep shared placement/routing logic centralized rather than copied into each flow.
5. Preserve existing exported functions used by tests/callers, or add temporary thin compatibility wrappers.
6. Move tests with implementation only where imports remain clear; do not reduce coverage.
7. Keep errors/codes/response JSON identical.

## Tests and Verification

- Run all upload/storage-routing tests.
- Run backend tests.
- Compare endpoint contract snapshots/fixtures if available.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*upload*`
- `docs/application/workflows/*upload*`
- `docs/reference/*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] `upload.routes.ts` is primarily HTTP composition.
- [ ] Provider-specific behavior is not duplicated.
- [ ] Public upload behavior is unchanged.
- [ ] Earlier B1/B2 performance fixes remain intact.

## Do Not

- Do not combine this structural refactor with a new upload feature.
- Do not rename public endpoints.
- Do not undo streaming/direct-upload optimizations.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
