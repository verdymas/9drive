# Multipart Upload Phases 2–3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace multipart full-file RAM buffering with a bounded disk spool and make staged provider transfer cancellation-safe.

**Architecture:** Each multipart file is copied once from Busboy into a session-scoped `UPLOAD_TEMP_DIR` file through a counting transform. Exact size and Busboy-limit checks complete before provider handoff. Google and S3 consume a `createReadStream` of that spool; Telegram retains its established file-path upload. The route owns request-abort coordination and always removes the spool in its terminal path.

**Tech Stack:** Express, Busboy, Node streams/promises, Google Drive API, AWS SDK multipart Upload, Prisma, Vitest.

**Spec:** `implementations/9drive-bottleneck-report-and-prompts/prompts/01-multipart-upload-memory/phase-2-remove-full-file-buffering.md` and `phase-3-provider-streaming-and-abort.md`

## Global Constraints

- Preserve `POST /uploads` and `/api/v1/uploads` payloads, responses, automatic routing, folder materialization, providers, and resumable endpoints.
- Use only `UPLOAD_TEMP_DIR`; session IDs, never client filenames, identify spool files.
- Do not introduce direct/presigned S3 uploads or a second storage root.
- Keep Telegram file-path uploads; do not invent an unproven streaming API.
- Do not create an active File row after a provider failure; quota refresh remains best-effort.

---

### Task 1: Bounded multipart spool primitive

**Files:**
- Modify: `backend/src/modules/uploads/upload-temp-files.ts`
- Test: `backend/src/modules/uploads/upload-temp-files.test.ts`

**Interfaces:**
- Produces `spoolMultipartFile(tempDir, sessionId, stream, signal?): Promise<{ path: string; sizeBytes: bigint; limited: boolean }>`.
- Consumes a Node readable and writes to `multipartTempUploadPath(tempDir, sessionId)`.

- [x] **Step 1: Write failing tests** for a lazily generated multi-chunk stream, byte counting, Busboy `limit`, and AbortSignal cleanup.
- [x] **Step 2: Run the focused temp helper test** and confirm the new import/test fails before implementation.
- [x] **Step 3: Implement the primitive** with `stream/promises` `pipeline`, a counting `Transform`, and the existing session-scoped path; leave no `Buffer.concat` path.
- [x] **Step 4: Run the focused helper tests** and confirm all cases pass.

### Task 2: Multipart route uses staged streams

**Files:**
- Modify: `backend/src/modules/uploads/upload.routes.ts`
- Test: `backend/src/modules/uploads/upload.routes.multipart.test.ts`

**Interfaces:**
- Consumes `spoolMultipartFile` and `removeMultipartTemp`.
- S3 and Google receive `createReadStream(spool.path)`; Telegram receives `spool.path`.

- [x] **Step 1: Write failing route tests** proving an S3/Google provider receives a readable spool rather than a complete Buffer, and proving declared mismatch prevents all provider calls.
- [x] **Step 2: Run the route suite** and verify the tests fail against the buffered implementation.
- [x] **Step 3: Replace `chunks`/`Buffer.concat`** with the spool result, reject `limited` and size mismatch before provider execution, and remove the spool in a `finally` block for every terminal outcome.
- [x] **Step 4: Reuse `finalizeNonGoogleUpload` for S3/Telegram** so provisional non-Google rows are soft-deleted on provider failures.
- [x] **Step 5: Run the route suite** and confirm compatibility response tests remain green.

### Task 3: Cancellation and provider streaming boundaries

**Files:**
- Modify: `backend/src/modules/s3/s3.service.ts`
- Modify: `backend/src/modules/uploads/upload.routes.ts`
- Test: `backend/src/modules/uploads/upload.routes.multipart.test.ts`

**Interfaces:**
- Extends `UploadS3ObjectOptions` with optional `signal?: AbortSignal` and aborts the AWS managed upload on signal.
- The route creates one request AbortController, passes it into spool/Google/S3 work, marks the session failed when cancellation wins, and records duration/streamed bytes in existing upload logs.

- [x] **Step 1: Write failing tests** for client abort during provider transfer and provider error after partial readable consumption.
- [x] **Step 2: Run the affected tests** and confirm the abort/cancellation expectations fail.
- [x] **Step 3: Implement cancellation propagation** to the S3 managed upload and Google request options; keep Telegram as documented staged fallback.
- [x] **Step 4: Add structured `durationMs` and `streamedBytes` fields** to multipart completion/failure logs without introducing a metrics service.
- [x] **Step 5: Run upload/provider tests** and verify no failed operation leaves an active File or uploading session.

### Task 4: Documentation and verification

**Files:**
- Modify: `docs/application/features/uploads.md`
- Modify: `docs/application/workflows/direct-upload.md`
- Modify: relevant upload runbook if one exists

- [x] **Step 1: Document spool location, bounded-memory guarantee, provider stream behavior, cancellation semantics, and Telegram fallback.**
- [x] **Step 2: Run focused upload tests, full backend tests, `npm run build`, and `git diff --check`.**
- [x] **Step 3: Perform a local generated-stream smoke test when practical; report observed facts only, not a fixed RSS target.**
