# Phase 2 — Add Secure Direct S3 Download Fast Path

**Bottleneck:** B2 — backend as centralized file data plane  
**Phase:** 2 of 4

## Objective

Add a short-lived presigned S3 download path for eligible ordinary HTTP downloads so S3 bytes can bypass the backend, while retaining proxy delivery as a complete fallback and preserving WebDAV/Jellyfin behavior.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/files/stream-file.ts`
- `backend/src/modules/files/file.routes.ts`
- `backend/src/modules/s3/s3.service.ts`
- `backend/src/config/env.ts`
- `backend/prisma/schema.prisma`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

S3 downloads currently use `GetObjectCommand` and pipe the full response through 9Drive. S3-compatible providers can often generate signed GET URLs, but compatibility varies and server-proxy behavior is still required for WebDAV and some custom endpoints.

This phase must introduce direct delivery as an eligibility-based optimization, never as the only route.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Add configuration for enabling direct S3 delivery and a conservative signed-URL TTL. Default behavior must be safe and documented.
2. Implement signed GET URL generation for the existing S3 account configuration using AWS SDK signing utilities compatible with custom endpoints/path style.
3. Generate a signed URL only after normal 9Drive authorization and active-file checks succeed.
4. Route only eligible ordinary download flows to direct S3. Keep preview, WebDAV, archive/batch streaming, or other semantics on proxy unless explicitly proven compatible.
5. Preserve content-disposition intent where the S3 signing mechanism supports response header overrides; otherwise keep proxy fallback for that request.
6. Fall back to proxy on unsupported S3 configuration or signed-URL generation failure where safe.
7. Do not expose S3 credentials, bucket secrets, or long-lived object access.

## Tests and Verification

- Test signed URL eligibility and ineligibility.
- Test TTL/config handling.
- Test custom endpoint/path-style account behavior with mocks.
- Test that unauthorized users can never obtain a signed URL.
- Test proxy fallback.
- Run file/S3/WebDAV tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*files*`
- `docs/application/integrations/*s3*`
- `docs/reference/*environment*`
- `docs/runbooks/*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Eligible S3 downloads can bypass backend byte transfer.
- [ ] Authorization remains server-side.
- [ ] Signed URLs are short-lived and single-object scoped.
- [ ] WebDAV/Jellyfin proxy behavior remains intact.
- [ ] Disabling the feature restores pure proxy behavior without data migration.

## Do Not

- Do not redirect Google Drive or Telegram downloads.
- Do not make signed URLs permanent.
- Do not expose provider credentials to the client.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
