# Centralized Data Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep proxy delivery fully compatible while allowing opt-in, secure S3 direct downloads/uploads and an optional media-plane process.

**Architecture:** `files` routes retain authorization and choose a provider-neutral delivery decision. Proxy delivery is the complete compatibility path; an eligible attachment download may instead return a short-lived signed S3 redirect. Direct uploads retain server-controlled placement through a durable `UploadSession`, while browser bytes go only to bounded, signed multipart part URLs. Shared app composition mounts control and media routers in either one process or two processes.

**Tech Stack:** Express 5, TypeScript, Node streams, AWS SDK v3, Prisma/MySQL, React 19, Vite, Vitest, Docker Compose.

**Spec:** `implementations/9drive-bottleneck-report-and-prompts/prompts/02-centralized-data-plane/{README.md,phase-1-proxy-hardening.md,phase-2-s3-direct-download.md,phase-3-s3-direct-upload.md,phase-4-media-process-isolation.md}`

## Global Constraints

- Preserve existing public URLs, Google, S3, Telegram, WebDAV, SMB, sync, routing, resumable upload, Remote Import/HLS, and virtual filesystem behavior.
- Keep proxy delivery and server-side uploads as complete fallbacks; direct S3 traffic is opt-in and disabled by default.
- Never expose S3 credentials, encrypted configuration, permanent object access, OAuth credentials, or other secrets to clients or logs.
- Use Prisma migrations for schema changes and regenerate Prisma only through its commands.
- Write a focused failing test before each production behavior change, verify it fails, then implement the minimal behavior and verify it passes.
- Update `implementations/9drive-bottleneck-report-and-prompts/prompts/02-centralized-data-plane/TODO.md` only after the corresponding tested phase is complete.

---

## File Structure

- `backend/src/modules/files/file-delivery.ts` — delivery decision types, standardized proxy headers/errors, and response execution.
- `backend/src/modules/files/stream-file.ts` — provider stream opening delegated through the delivery abstraction.
- `backend/src/modules/files/stream-google-file.ts` — abortable, backpressure-aware Google fetch stream opening.
- `backend/src/modules/s3/s3.service.ts` — proxy streams plus signed GET and multipart S3 operations.
- `backend/src/modules/files/file.routes.ts` — authorization-first ordinary download decision; previews remain proxy-only.
- `backend/src/modules/uploads/direct-s3-upload.service.ts` — owned session init/sign/complete/abort/sweeper logic.
- `backend/src/modules/uploads/upload.routes.ts` — authenticated direct multipart endpoints alongside unchanged existing upload endpoints.
- `backend/prisma/schema.prisma` and a Prisma migration — direct multipart session provider state/expiration fields.
- `frontend/src/context/UploadContext.tsx` — advertised direct S3 path with existing resumable fallback.
- `backend/src/app.ts`, `backend/src/server.ts`, `backend/src/media-server.ts`, and `backend/src/app-composition.ts` — reusable router composition and optional media process lifecycle.
- `docker-compose.yml`, backend scripts, and existing S3/files/upload/WebDAV/environment/runbook docs — opt-in flags and same-path reverse proxy deployment.

### Task 1: Establish the Phase 1 delivery contract

**Files:**
- Create: `backend/src/modules/files/file-delivery.ts`
- Modify: `backend/src/modules/files/stream-file.ts`, `backend/src/modules/files/file.routes.ts`, `backend/src/modules/s3/s3.service.ts`, `backend/src/modules/files/stream-google-file.ts`
- Test: `backend/src/modules/files/file-delivery.test.ts`, `backend/src/modules/files/stream-google-file.test.ts`

**Interfaces:**
- Produces `DeliveryDecision = { kind: 'proxy' } | { kind: 'redirect'; url: string }` and `proxyFileDelivery(file, request, response, options): Promise<void>`.
- Produces `openGoogleFileStream(file, range, signal, options): Promise<ProviderResponse>` where `ProviderResponse` contains Node `Readable`, status, and normalized safe headers.

- [ ] **Step 1: Write failing focused tests for an S3 proxy range response, a Google range response, normalized attachment headers, an upstream pre-header error, and client-close abort propagation.**
- [ ] **Step 2: Run `cd backend && npm test -- src/modules/files/file-delivery.test.ts src/modules/files/stream-google-file.test.ts` and confirm the new cases fail because the delivery contract does not exist.**
- [ ] **Step 3: Implement the small delivery contract, use `Readable.fromWeb` and `pipeline`/`finished` rather than recursive `res.write`, attach downstream close to an `AbortController`, and preserve structured errors before headers.**
- [ ] **Step 4: Run the focused tests; confirm S3/Google status, range, content length/range/type/disposition, upstream errors, and aborts pass.**
- [ ] **Step 5: Update `docs/application/features/files-and-folders.md`, `docs/application/features/webdav-and-smb.md`, and the applicable download workflow to state that WebDAV and previews use proxy delivery.**
- [ ] **Step 6: Run `cd backend && npm test && npm run build`; update Phase 1 in `TODO.md` only when both commands pass.**

### Task 2: Add opt-in signed S3 download decisions

**Files:**
- Modify: `backend/package.json`, `backend/src/config/env.ts`, `backend/src/modules/s3/s3.service.ts`, `backend/src/modules/files/file-delivery.ts`, `backend/src/modules/files/file.routes.ts`
- Test: `backend/src/modules/s3/s3.service.test.ts`, `backend/src/modules/files/file-delivery.test.ts`

**Interfaces:**
- Consumes `DeliveryDecision` from Task 1.
- Produces `getS3DownloadDecision(file, { disposition, range }): Promise<DeliveryDecision>` and `S3_DIRECT_DOWNLOAD_ENABLED`, `S3_DIRECT_DOWNLOAD_TTL_SECONDS` defaults.

- [ ] **Step 1: Write failing tests that prove disabled/ineligible/WebDAV/preview/range requests proxy, an owned active S3 attachment redirects, expired/invalid config falls back, and custom endpoint/path-style signing uses only that file key.**
- [ ] **Step 2: Run `cd backend && npm test -- src/modules/s3/s3.service.test.ts src/modules/files/file-delivery.test.ts` and confirm failures identify missing signing/eligibility logic.**
- [ ] **Step 3: Add the AWS SDK presigner dependency; validate opt-in environment defaults and generate an object-scoped GET URL with conservative TTL and `ResponseContentDisposition` when supported.**
- [ ] **Step 4: Make only authenticated `GET /files/:id/download` select the redirect decision after `userId` and `status: 'active'` lookup; all public preview, WebDAV, archive, range, and signing failures stay proxy.**
- [ ] **Step 5: Run focused tests, `cd backend && npm test && npm run build`, then update S3/environment/file/runbook docs and the Phase 2 checklist.**

### Task 3: Persist and control direct S3 multipart sessions

**Files:**
- Modify: `backend/prisma/schema.prisma`, `backend/src/modules/s3/s3.service.ts`, `backend/src/modules/uploads/upload.routes.ts`, `backend/src/modules/uploads/storage-routing.service.ts`
- Create: `backend/src/modules/uploads/direct-s3-upload.service.ts`, `backend/src/modules/uploads/direct-s3-upload.service.test.ts`
- Migration: `backend/prisma/migrations/<generated_timestamp>_add_direct_s3_multipart_session/migration.sql`

**Interfaces:**
- Produces `initDirectS3Upload(userId, request)`, `signDirectS3Part(userId, sessionId, partNumber)`, `completeDirectS3Upload(userId, sessionId, parts)`, `abortDirectS3Upload(userId, sessionId)`, and `sweepExpiredDirectS3Uploads(now)`.
- Routes: `POST /uploads/direct-s3/init`, `POST /uploads/direct-s3/:sessionId/parts/:partNumber`, `POST /uploads/direct-s3/:sessionId/complete`, `POST /uploads/direct-s3/:sessionId/abort`.

- [ ] **Step 1: Write failing service tests for authorization, authoritative placement, session ownership, object-key creation, part lower/upper bounds, short expiry, completion ETag validation, inactive File state, abort cleanup, and stale-session sweeper cleanup.**
- [ ] **Step 2: Run `cd backend && npm test -- src/modules/uploads/direct-s3-upload.service.test.ts` and confirm the expected missing-flow failure.**
- [ ] **Step 3: Add minimal schema fields for S3 multipart upload ID, controlled object key, direct-session expiration, provider part metadata, and an index supporting active/expired session cleanup; run `npm run prisma:migrate` and `npm run prisma:generate`.**
- [ ] **Step 4: Implement the service with `CreateMultipartUpload`, `UploadPart` signing, `CompleteMultipartUpload`, and `AbortMultipartUpload`; create a File at `uploading` only inside server control and set it active only after provider completion.**
- [ ] **Step 5: Expose guarded Zod-validated routes without modifying existing multipart/resumable behavior; return only session ID, constrained part URLs, expiry, part size, and advertised mode.**
- [ ] **Step 6: Run the focused service/route/upload/storage/S3 suites and `cd backend && npm run build`.**

### Task 4: Use direct S3 from the browser only when advertised

**Files:**
- Modify: `frontend/src/context/UploadContext.tsx`
- Test: `frontend/src/context/UploadContext.test.tsx`
- Modify docs: `docs/application/features/uploads.md`, `docs/application/workflows/direct-upload.md`, `docs/application/integrations/s3.md`, `docs/reference/environment.md`, applicable runbook

**Interfaces:**
- Consumes direct-init response `{ mode: 'direct-s3'; sessionId; partSizeBytes; expiresAt } | { mode: 'server' }`.
- Produces `uploadSingleFileDirectS3` with XHR/fetch progress and abort behavior, otherwise calls existing `uploadSingleFileResumable`.

- [ ] **Step 1: Write failing frontend tests showing an advertised S3 direct session uploads ordered parts, reports aggregate progress, completes with ETags, aborts on cancellation, and falls back to the existing resumable flow when mode is absent.**
- [ ] **Step 2: Run `cd frontend && npm test -- src/context/UploadContext.test.tsx` (or the project’s configured Vitest equivalent) and confirm failures concern the absent direct path.**
- [ ] **Step 3: Implement the direct branch without exposing credentials, preserving existing batch preflight, manual account selection, retry/error status, events, and Google/Telegram semantics.**
- [ ] **Step 4: Run focused frontend tests and `cd frontend && npm run build`; run backend upload/storage/S3 tests and `npm run build`.**
- [ ] **Step 5: Document the opt-in flag, direct multipart lifecycle, cancellation/recovery and server fallback; update Phase 3 checklist only after the backend, frontend, migration, and docs gates pass.**

### Task 5: Extract shared control/media server composition

**Files:**
- Create: `backend/src/app-composition.ts`, `backend/src/media-server.ts`, `backend/src/server-lifecycle.ts`
- Modify: `backend/src/app.ts`, `backend/src/server.ts`, `backend/src/config/env.ts`, `backend/package.json`
- Test: `backend/src/app-composition.test.ts`, `backend/src/server-lifecycle.test.ts`

**Interfaces:**
- Produces `createControlPlaneApp()`, `createMediaPlaneApp()`, and `startHttpServer(app, port, options)`.
- Media plane mounts only authenticated/public file stream routes and WebDAV at their existing path prefixes; control plane keeps all application APIs.

- [ ] **Step 1: Write failing integration tests showing all-in-one preserves `/files/:id/download`, `/files/preview/:token`, public file streams, and `/webdav`; media-plane composition mounts those same paths with identical auth failures and range headers.**
- [ ] **Step 2: Run `cd backend && npm test -- src/app-composition.test.ts src/server-lifecycle.test.ts` and confirm the split composition is absent.**
- [ ] **Step 3: Extract reusable routing factories instead of copying handlers, add `MEDIA_SERVER_ENABLED`/`MEDIA_SERVER_PORT` opt-in environment validation, and keep `server.ts` as the legacy all-in-one entrypoint.**
- [ ] **Step 4: Add a media entrypoint and lifecycle tracking that stops accepting traffic, waits boundedly for active stream connections, then destroys remaining connections and closes process dependencies without changing application state.**
- [ ] **Step 5: Run focused integration tests, `cd backend && npm test && npm run build`, and verify both entrypoints expose appropriate `/health` readiness responses.**

### Task 6: Deploy and verify the optional media plane

**Files:**
- Modify: `docker-compose.yml`, `docs/README.md`, `docs/runbooks/docker.md`, `docs/runbooks/webdav-smb.md`, applicable application workflow/reference docs
- Test: `backend/src/app-composition.test.ts`

**Interfaces:**
- Consumes the control/media entrypoints from Task 5.
- Produces a documented reverse-proxy rule that routes public file and WebDAV stream paths to the media process without changing external URLs.

- [ ] **Step 1: Write or extend an integration test for same external route semantics through the control/media routing boundary and graceful close while a readable is active.**
- [ ] **Step 2: Run the test to confirm the deployment composition gap before configuration changes.**
- [ ] **Step 3: Add an optional compose media service with the same required environment and route it only through documented reverse-proxy configuration; leave the default one-process compose service unchanged.**
- [ ] **Step 4: Document route classification, health/readiness, connection-drain behavior, WebDAV authentication/range invariants, and rollback to all-in-one mode.**
- [ ] **Step 5: Run `cd backend && npm test && npm run build` and `cd frontend && npm run build`; perform the documented all-in-one and split-plane smoke tests; then update Phase 4 and final audit checklist entries.**

## Plan Self-Review

- Every phase requirement maps to Tasks 1–6: proxy correctness (1), signed download (2), server-controlled direct multipart plus browser fallback/recovery (3–4), and optional shared media process plus deployment docs (5–6).
- The plan preserves proxy and server upload fallbacks, keeps authorization before direct delivery, and scopes direct behavior to S3 only.
- No production implementation has begun; the checklist is intentionally unchecked until each test/documentation gate passes.
