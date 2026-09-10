# Phase 2 — Slim WebDAV Directory Projections and Lazy-Load Provider Accounts

**Bottleneck:** B6 — WebDAV metadata and path-resolution cost  
**Phase:** 2 of 3

## Objective

Reduce row size and object hydration for PROPFIND/directory listing by selecting only WebDAV metadata, and load provider account credentials only when a file stream actually starts.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/webdav/webdav-virtual-fs.ts`
- `backend/src/modules/files/stream-file.ts`
- `backend/src/modules/s3/s3.service.ts`
- `backend/src/modules/google/google.service.ts`
- `backend/src/modules/telegram/telegram.service.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

`VirtualFsCache.filesUnder()` currently returns `File & { connectedAccount: ConnectedAccount }` for every file in a directory. Directory metadata operations generally do not need encrypted provider/account credential fields.

Only streaming needs enough account information to authenticate to the provider.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Define minimal WebDAV metadata select types for folder and file listing/path resolution.
2. Change directory queries to select only fields required by WebDAV resource type, size, mime, timestamps, provider, IDs, and names.
3. Do not include full `connectedAccount` on directory listing rows.
4. Refactor `getFileForStreaming()` or the stream boundary to load the active file plus the provider account only for the selected file being streamed.
5. Keep cache typing strict; avoid falling back to `any`.
6. Preserve ETag/content-length/range/provider dispatch behavior.
7. Add tests proving listing works without hydrated account secrets and streaming still obtains required account data.

## Tests and Verification

- Run WebDAV tests and provider stream tests.
- Inspect Prisma query selection in tests/logs where feasible.
- Verify large directory listing returns the same resource names/metadata.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*webdav*`
- `docs/application/integrations/*`
- `docs/reference/*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] PROPFIND does not hydrate every file's connected account.
- [ ] Only an actually streamed file loads provider-account data.
- [ ] Visible WebDAV metadata remains equivalent.
- [ ] Google/S3/Telegram range streaming remains functional.

## Do Not

- Do not weaken provider-account status/ownership validation.
- Do not cache decrypted credentials in directory metadata.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
