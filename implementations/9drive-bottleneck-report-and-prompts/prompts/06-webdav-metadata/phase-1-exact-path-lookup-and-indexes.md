# Phase 1 — Replace WebDAV Sibling Scans with Exact Indexed Path Lookups

**Bottleneck:** B6 — WebDAV metadata and path-resolution cost  
**Phase:** 1 of 3

## Objective

Change WebDAV path resolution so resolving one path segment performs an exact DB lookup rather than loading all sibling folders/files and scanning with JavaScript. Preserve directory listing behavior separately.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/webdav/webdav-virtual-fs.ts`
- `backend/src/modules/webdav/webdav.routes.ts`
- `backend/prisma/schema.prisma`
- `backend/src/modules/sync/normalize-folder-name.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

`VirtualFsCache.foldersUnder()` and `filesUnder()` cache full child collections. `resolvePath()` uses those collections and `.find(candidate => candidate.name === segment)`. This is useful for directory listing but inefficient for exact path lookup in large directories.

Be careful with folder `normalizedName`: sync-created folders have normalized names, while user-created rows may have `normalizedName = null`. Exact WebDAV display-name matching must preserve current case/name semantics rather than assuming normalizedName is universally populated.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Add distinct cache/query methods for exact child-folder lookup and exact child-file lookup.
2. Scope every query by the same user/root namespace semantics currently enforced by the WebDAV mount. If user scoping is currently implicit elsewhere, preserve and make it explicit where needed.
3. For path resolution, query by parent/folder + active/deleted state + exact display name using Prisma/MySQL semantics that match current behavior.
4. Do not use `foldersUnder()`/`filesUnder()` for exact segment resolution unless a directory listing is already present in the request cache and can be reused without an extra query.
5. Keep list methods for PROPFIND directory enumeration.
6. Inspect query shapes and add appropriate composite indexes in Prisma. Avoid an index based on `normalizedName` alone unless all path-visible folders can safely use it.
7. Add path-resolution tests for root, nested folders, file-vs-folder name cases allowed by current model, deleted entries, Unicode names, and large sibling fixtures.

## Tests and Verification

- Run WebDAV tests.
- Use Prisma query logging or targeted test instrumentation to verify resolving a deep path does not load every sibling collection.
- Run migration validation if indexes change.
- Verify Telegram WebDAV streaming test still passes.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*webdav*`
- `docs/application/domain/*filesystem*`
- `docs/reference/*database*`
- `docs/runbooks/*webdav*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Exact path resolution uses exact DB lookups.
- [ ] Directory listing behavior remains unchanged.
- [ ] Deep path cost scales primarily with path depth, not sibling count.
- [ ] User isolation and deleted/status filters remain correct.
- [ ] Indexes match the actual predicates used.

## Do Not

- Do not globally populate/change `normalizedName` semantics without a separate migration plan.
- Do not remove request-scoped directory caching needed by PROPFIND.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
