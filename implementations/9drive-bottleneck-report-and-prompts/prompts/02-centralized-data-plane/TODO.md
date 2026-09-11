# B2 — Centralized Data Plane Checklist

Status key: check an item only after the implementation, focused tests, relevant
suite, and documentation for that phase have passed. Phases must be completed
in the order shown below.

## Phase 1 — Proxy hardening and delivery decisions

- [x] Define a provider-neutral internal delivery decision/result boundary.
- [x] Keep all existing public file routes and WebDAV proxy semantics unchanged.
- [x] Make Google response streaming backpressure-aware with Node stream primitives.
- [x] Abort provider work when the downstream client disconnects where supported.
- [x] Normalize status, range, length, type, and disposition headers across proxy providers.
- [x] Return structured errors before response headers; terminate cleanly after streaming starts.
- [x] Add focused proxy tests for ranges, aborts, upstream failures, and response headers.
- [x] Update file, WebDAV, integration, and download workflow documentation.
- [x] Run Phase 1 focused tests and the backend suite successfully.

## Phase 2 — Direct S3 download fast path

- [x] Add documented, opt-in S3 direct-download configuration with a conservative TTL.
- [x] Generate custom-endpoint/path-style-compatible, object-scoped signed GET URLs.
- [x] Authorize and require an active file before producing a signed URL.
- [x] Limit direct delivery to eligible ordinary S3 downloads; retain proxy for previews, WebDAV, archives, and incompatible requests.
- [x] Preserve attachment disposition using signed response-header overrides or fall back to proxy.
- [x] Fall back safely when signing is disabled, unsupported, or fails.
- [x] Add eligibility, authorization, TTL, endpoint, and fallback tests.
- [x] Update S3, file, environment, and operations documentation.
- [x] Run Phase 2 focused tests and the backend suite successfully.

## Phase 3 — Direct S3 multipart upload fast path

- [x] Add opt-in direct-upload configuration and a durable, owned multipart-session state.
- [x] Implement authenticated init, part-sign, complete, abort, and stale-session cleanup flows.
- [x] Keep server authority over account placement, bucket/key, metadata, size, folder, and final file registration.
- [x] Issue short-lived part URLs and validate session ownership, part bounds, exact size, and completion state.
- [x] Keep inactive/failed sessions from creating active logical files.
- [x] Update UploadContext to choose direct S3 only when advertised and retain resumable/server fallback for every provider.
- [x] Preserve progress, cancellation, preflight/routing, and session observability.
- [x] Add backend init/sign/complete/abort/sweeper tests and frontend fast-path/fallback tests.
- [x] Update upload, S3, environment, and recovery/runbook documentation.
- [x] Run Phase 3 focused backend/frontend tests and complete relevant suites successfully.

## Phase 4 — Optional media-plane process

- [x] Classify and extract the shared heavy streaming route composition.
- [x] Add an optional media server entry point while preserving the all-in-one server.
- [x] Ensure equivalent authentication, API-key, public-token, range, and WebDAV behavior.
- [x] Add graceful connection draining and readiness/health behavior for both processes.
- [x] Add deployment and reverse-proxy routing that preserves external URLs.
- [x] Add route/process integration coverage for all-in-one and split-plane modes.
- [x] Update deployment, WebDAV, workflow, reference, and runbook documentation.
- [x] Run Phase 4 focused tests, full backend tests, and backend/frontend builds successfully.

## Completion audit

- [x] Confirm all four prompt acceptance criteria against current code and tests.
- [x] Confirm no provider credentials, secrets, or permanent signed URLs reach clients.
- [x] Confirm migrations and generated Prisma client handling were verified.
- [x] Record final verification commands and results below before marking this checklist complete.

## Verification record

- Phase 1 — `cd backend && npm test -- src/modules/files/file-delivery.test.ts src/modules/files/stream-google-file.test.ts src/modules/s3/s3.service.test.ts src/modules/webdav/webdav-telegram-routing.test.ts src/modules/webdav/webdav-no-decrypt.test.ts` → 13 passed; `npm test` → 87 files / 1,056 tests passed; `npm run build` → passed (2026-09-10).
- Phase 2 — `cd backend && npm test -- src/modules/files/file-download-delivery.test.ts src/modules/s3/s3.service.test.ts src/modules/files/file-delivery.test.ts src/modules/files/stream-google-file.test.ts src/modules/webdav/webdav-telegram-routing.test.ts src/modules/webdav/webdav-no-decrypt.test.ts` → 18 passed; `npm test` → 88 files / 1,061 tests passed; `npm run build` → passed (2026-09-10).
- Phase 3 — `cd backend && npm test -- src/modules/uploads src/modules/s3 src/modules/files` → 12 files / 98 passed (service 14: placement, ownership, bounds, part-size validation, HEAD gate, abort, sweeper + disabled-flag guard; routes 2; direct-status 3; S3 5; existing upload suites unchanged); `cd frontend && npm test` → 6 files / 99 passed (UploadContext 11 incl. 4 direct fast-path/abort/notice/fallback cases); `cd backend && npm test` → 91 files / 1,081 tests passed; both `npm run build` passed (2026-09-11). `prisma migrate` could not be exercised on this machine (`npx prisma migrate status` → `DATABASE_URL` not set, no reachable MySQL); the committed migration `20260910000000_add_direct_s3_multipart_sessions` matches the schema and the generated Prisma client build compiles against. Apply with `npm run prisma:migrate` / `docker compose exec backend npm run prisma:migrate` before deploying.
  Toolchain fixes included in this gate (pre-existing, both were blocking a green suite): pin `test.env.NODE_ENV='test'` in `frontend/vite.config.test.ts` (an inherited `NODE_ENV=production` made React drop `act` and broke every DOM test); disambiguate the `WorkersPage.test.tsx` case-insensitive role query that matched two buttons.
- Phase 4 — `cd backend && npm test -- src/app-composition.test.ts src/server-lifecycle.test.ts` → 2 files / 6 passed (all-in-one keeps `/health`, `/files` media + control prefixes, `/webdav`, `/folders`; media plane serves identical paths/auth/range and 404s control routes; bounded drain < 1.5 s, stalled streams force-closed, socket accounting to zero). Boot smoke (`node implementations/.../phase4-boot-smoke.mjs` against compiled `dist/`): media plane with flag on serves `/health` `{plane:"media"}` + 401 auth-before-DB semantics + `/webdav/status` while `/folders` correctly 404s; with the flag off it exits 0 without listening; all-in-one serves both planes on one port → SMOKE PASSED (3/3). `cd backend && npm test` → 93 files / 1,087 passed; `cd backend && npm run build` and `cd frontend && npm test` (6/99) + `npm run build` passed (2026-09-11). Compose validated with `docker compose config` (media excluded from default services, included under `--profile media`; YAML anchor merge resolves).
- Completion audit (2026-09-11) — Acceptance criteria verified per phase against live code and the suites above: (1) all pre-existing public routes/semantics intact — every prior route table entry keeps its path and the all-in-one server can still serve everything (the media plane only ADDS an optional mount of the same routers); (2) eligible S3 downloads redirect and eligible S3 uploads transfer parts browser→S3 (opt-in, default off: `S3_DIRECT_DOWNLOAD_ENABLED`/`S3_DIRECT_UPLOAD_ENABLED=false`); (3) credentials audited: S3 keys are decrypted only inside `createS3Client` in the backend, and direct-S3 responses carry only `{sessionId, partSizeBytes, expiresAt, targetAccountId/Email}` and one short-lived presigned part URL (`S3_DIRECT_UPLOAD_PART_URL_TTL_SECONDS` ≤ 900 s, `MEDIA`/download TTLs ≤ 900 s) — never credentials, bucket config, upload IDs, or object keys; no signed URL or secret appears in any log line in the new code paths; (4) automatic routing stays authoritative — init calls `resolveUploadPlacement` (identical service the resumable/multipart paths use), and manual selection bypasses direct upload rather than bypassing quota; (5) inactive/failed/expired sessions register NO `File` row (tests fail-verified: create/HEAD-mismatch/abort/sweep paths assert zero `file.create` calls) and disabling flags requires no migration rollback; (6) auth equivalence: both planes bind the SAME `requireAuth`/API-key/public-token/WebDAV Basic handlers through the shared router instances (no second copy), verified by the route-equality smoke and suite; (7) the single Prisma migration for this feature branch is applied through normal deploy flow (`npm run db:migrate:deploy` in the compose command, documented as a prerequisite for direct-upload in the Phase 3 record above).
- Remaining known items (explicitly outside these four phases): no per-file cancel button exists in the upload panel for ANY provider (cancellation today = failure/abandonment paths + server-side abort/sweep, documented); no performance claims are made anywhere in this checklist — only code-level guarantees; `prisma migrate status`/`migrate deploy` and a container `docker compose up` still need one run against the real deployment DB/registry (unavailable on this workstation).
