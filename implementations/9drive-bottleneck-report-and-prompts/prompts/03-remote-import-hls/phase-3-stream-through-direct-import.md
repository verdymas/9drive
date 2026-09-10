# Phase 3 — Add Resumable Stream-Through Direct Import

**Bottleneck:** B3 — Remote Import/HLS temp-disk and FFmpeg pressure  
**Phase:** 3 of 4

## Objective

Add an eligibility-based fast path that transfers ordinary remote files to stream-capable providers without fully materializing the source on temp disk, while keeping the existing temp-spool flow as the universal fallback.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/remote-imports/processor.ts`
- `backend/src/modules/remote-imports/url-downloader.ts`
- `backend/src/modules/remote-imports/google-resumable-uploader.ts`
- `backend/src/modules/s3/s3.service.ts`
- `backend/src/modules/remote-imports/temp-storage.ts`
- `backend/src/modules/remote-imports/remote-import.service.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

This phase must not weaken retry safety. A stream-through transfer is only useful when it can recover from interruption or cleanly fall back.

Google already has a dedicated resumable uploader in the Remote Import module. S3 supports multipart upload. Remote HTTP sources may or may not support byte ranges.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Define explicit stream-through eligibility based on source properties and destination provider capability. HLS is not eligible in this phase.
2. Probe or verify source range/resume support without weakening existing SSRF/redirect/request-context protections.
3. For Google Drive, connect source ranged reads to the existing resumable uploader in bounded chunks and persist enough progress to restart safely.
4. For S3, use multipart upload with bounded parts and persist/reconstruct required completion state safely. If persistence would require a schema change, document and migrate it explicitly.
5. On source/provider combinations that cannot safely resume, continue using the existing temp-spool implementation.
6. Preserve progress updates, expected-size enforcement, cancellation, retry stage semantics, filename detection, placement, and final File registration.
7. Abort upstream source requests when the job is cancelled or provider transfer fails.
8. Never use stream-through for Telegram unless the current Telegram API and retry model can prove equivalent safety; default Telegram to spool.

## Tests and Verification

- Test eligibility/fallback decisions.
- Test mid-transfer retry/resume for Google.
- Test S3 multipart interruption and cleanup/recovery.
- Test source without Range support falls back to temp spool.
- Test cancel propagation.
- Run Remote Import direct-download and provider tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/REMOTE_IMPORTS.md`
- `docs/application/workflows/*remote*`
- `docs/application/integrations/*`
- `docs/runbooks/*remote*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Eligible direct imports can avoid a full-size temp file.
- [ ] Every ineligible case retains the existing functional fallback.
- [ ] Retry after interruption cannot silently duplicate or corrupt the destination object.
- [ ] Progress and final DB state remain correct.
- [ ] HLS and Telegram behavior remain unchanged.

## Do Not

- Do not remove temp-spool import.
- Do not stream-through HLS in this phase.
- Do not assume HTTP Range support based only on one header without validating behavior.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
