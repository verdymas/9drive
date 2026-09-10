# Phase 4 — Isolate Media-Heavy Proxy Traffic

**Bottleneck:** B2 — backend as centralized file data plane  
**Phase:** 4 of 4

## Objective

Create an optional deployment/runtime boundary so long-lived file/WebDAV/media streams can be isolated from normal API traffic while preserving the same external URLs, authentication semantics, and proxy fallback behavior.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/server.ts`
- `backend/src/modules/files/file.routes.ts`
- `backend/src/modules/webdav/webdav.routes.ts`
- `backend/src/modules/webdav/webdav-virtual-fs.ts`
- `backend/src/config/env.ts`
- `package.json`
- `docker-compose.yml`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

Even after S3 direct delivery, Google and Telegram still require proxy paths and WebDAV remains metadata/stream heavy. The objective is fault/resource isolation: media connections should not starve short API requests.

The repository may use Docker or a single-process deployment. Implement this as an optional mode and preserve the existing all-in-one mode.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Identify which routes are genuinely media/data-plane heavy versus control-plane API routes.
2. Introduce an optional media server entry point/process that mounts only the required file/WebDAV streaming routes and dependencies.
3. Keep the current single-process server mode fully supported.
4. Ensure auth/session/API-key behavior required by media endpoints is exactly equivalent.
5. Document reverse-proxy routing so the public paths do not change.
6. Add graceful shutdown and connection draining for long-lived streams.
7. Add readiness/health behavior appropriate to both processes.
8. Do not duplicate business logic: extract reusable router/service composition instead of copying implementations.

## Tests and Verification

- Start the legacy all-in-one server and verify existing behavior.
- Start control-plane + media-plane mode and verify the same public route semantics through a local reverse proxy or route-level integration test.
- Verify WebDAV auth and range streaming.
- Verify shutdown does not corrupt active application state.
- Run backend tests.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/workflows/*`
- `docs/reference/*`
- `docs/runbooks/*deployment*`
- `docs/runbooks/*webdav*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] 9Drive can still run as one process.
- [ ] An optional media process can handle heavy streams behind the same public paths.
- [ ] Business logic is shared, not duplicated.
- [ ] Auth/user isolation is identical in both modes.
- [ ] Deployment/runbook documentation is complete.

## Do Not

- Do not force a microservices deployment.
- Do not change public URLs.
- Do not duplicate router logic into a second implementation.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
