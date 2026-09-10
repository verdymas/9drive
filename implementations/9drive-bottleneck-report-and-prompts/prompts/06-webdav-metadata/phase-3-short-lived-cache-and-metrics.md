# Phase 3 — Add Short-Lived WebDAV Metadata Cache and Measurements

**Bottleneck:** B6 — WebDAV metadata and path-resolution cost  
**Phase:** 3 of 3

## Objective

Add a small, user-isolated short-lived cache for repeated WebDAV path/metadata lookups after exact query behavior is correct. Measure hit/miss behavior and keep stale-data windows explicit.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/webdav/webdav-virtual-fs.ts`
- `backend/src/modules/webdav/webdav.routes.ts`
- `backend/src/config/env.ts`
- `backend/src/modules/files/file.routes.ts`
- `backend/src/modules/folders/folder.routes.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

The current cache is request-scoped and is cleared at the start of every WebDAV request. Jellyfin/rclone may immediately repeat PROPFIND/HEAD/GET for the same paths across separate requests.

A cross-request cache can reduce DB load, but it must never leak data across users and must not make rename/move/delete behavior confusing.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Measure/identify repeated lookup patterns first; add counters/timing using the project's existing logging approach.
2. Add a bounded LRU/TTL cache keyed by user namespace plus normalized request path or immutable row identity.
3. Use a short configurable TTL. Default conservatively.
4. Cache metadata only, not provider byte streams or decrypted credentials.
5. Invalidate or bypass relevant entries on known local mutations where practical; otherwise document the maximum stale window.
6. Do not cache authorization decisions independently of user identity.
7. Provide a clean path to Redis-backed shared caching later, but do not require Redis for WebDAV metadata in this phase unless architecture already mandates it.

## Tests and Verification

- Test cache key user isolation.
- Test TTL expiry.
- Test rename/delete visibility within invalidation/TTL contract.
- Test hit/miss behavior.
- Run WebDAV/file/folder mutation tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*webdav*`
- `docs/reference/*environment*`
- `docs/runbooks/*webdav*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Repeated metadata requests can avoid repeated DB queries.
- [ ] Cache is bounded in entries/memory.
- [ ] No cross-user path collision can expose metadata.
- [ ] Staleness behavior is documented and tested.
- [ ] WebDAV remains correct with caching disabled.

## Do Not

- Do not cache file bodies.
- Do not cache decrypted provider credentials.
- Do not use an unbounded Map.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
