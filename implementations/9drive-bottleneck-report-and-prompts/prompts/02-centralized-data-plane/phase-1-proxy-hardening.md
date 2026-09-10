# Phase 1 — Harden Proxy Streaming and Introduce Delivery Decisions

**Bottleneck:** B2 — backend as centralized file data plane  
**Phase:** 1 of 4

## Objective

Make the existing proxy path robust under long-lived media transfers and introduce an internal delivery abstraction that can later choose between proxy and direct provider delivery without changing public routes.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/files/stream-file.ts`
- `backend/src/modules/files/stream-google-file.ts`
- `backend/src/modules/files/file.routes.ts`
- `backend/src/modules/s3/s3.service.ts`
- `backend/src/modules/telegram/telegram.service.ts`
- `backend/src/modules/webdav/webdav-virtual-fs.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

Current provider download paths stream bytes through the backend. S3 uses a Node stream pipe; Google manually pumps Fetch response chunks to Express; Telegram has its own streaming path.

Before adding direct delivery, the proxy path must remain a first-class fallback and must correctly handle backpressure, range headers, client disconnects, and provider cancellation.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Define a small internal file-delivery interface/result that separates authorization/file lookup from the actual transport mechanism. Keep existing route URLs unchanged.
2. Harden Google streaming to respect Node/WHATWG backpressure rather than recursively calling `res.write()` without waiting for drain when necessary. Prefer standard pipeline/Readable conversion where supported by the runtime.
3. Propagate client disconnect/abort to upstream fetch/provider operations where supported.
4. Normalize range/status/content-length/content-range/content-type/content-disposition behavior across provider proxy implementations without changing valid current semantics.
5. Ensure errors that occur before headers are sent produce structured API errors; errors after streaming starts must terminate the stream cleanly.
6. Add focused tests for range requests, aborts, upstream failure, and header behavior.

## Tests and Verification

- Test S3 range proxy behavior.
- Test Google normal and range stream behavior; Google Workspace export paths must remain handled.
- Test Telegram/WebDAV playback paths that already have coverage.
- Run backend tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*files*`
- `docs/application/features/*webdav*`
- `docs/application/integrations/*`
- `docs/application/workflows/*download*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Existing proxy downloads remain backward compatible.
- [ ] Client disconnects release upstream work where the provider API permits it.
- [ ] Backpressure is handled using standard stream primitives or equivalent.
- [ ] An internal delivery decision boundary exists for Phase 2.
- [ ] WebDAV still uses proxy streaming by default.

## Do Not

- Do not add public S3 signed URLs yet.
- Do not make WebDAV redirect to S3.
- Do not split deployment processes in this phase.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
