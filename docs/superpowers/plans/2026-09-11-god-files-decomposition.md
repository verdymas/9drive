# B7 God-Files Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the largest 9Drive upload, Remote Import, Telegram Sync, and frontend modules in the prompt order without changing public behavior.

**Architecture:** Keep existing route, worker, service, and context entry points as compatibility façades. Move one responsibility at a time into typed focused modules, with shared placement and provider services remaining the only source of routing/provider policy.

**Tech Stack:** TypeScript, Express 5, Prisma 6, BullMQ, Vitest, React 19, Vite 8, Testing Library, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-09-11-god-files-decomposition-design.md`

## Global Constraints

- Preserve route URLs, JSON response shapes, stable error codes, worker-facing exports, and existing test imports.
- Preserve provider placement, streaming/direct-upload optimizations, HLS resource controls, Telegram page-scoped concurrency, cancellation, retry, and cleanup semantics.
- Do not add migrations, environment variables, dependencies, state-management libraries, or visual redesign.
- Use `resolveUploadPlacement` for upload and Remote Import placement; do not duplicate routing policy.
- Run the focused tests and package build after each phase, then run complete backend/frontend verification before completion.

---

### Task 1: Establish B7 progress tracking and baseline

**Files:**
- Create: `implementations/9drive-bottleneck-report-and-prompts/prompts/07-god-files/TODO.md`
- Create: `docs/superpowers/specs/2026-09-11-god-files-decomposition-design.md`
- Create: `docs/superpowers/plans/2026-09-11-god-files-decomposition.md`

**Interfaces:**
- Produces the phase checklist used for all later tasks.

- [ ] **Step 1: Record the current target sizes and exports**

Run:

```powershell
Get-Content backend/src/modules/uploads/upload.routes.ts | Measure-Object -Line
Get-Content backend/src/modules/remote-imports/processor.ts | Measure-Object -Line
Get-Content backend/src/modules/telegram/telegram-sync.service.ts | Measure-Object -Line
Get-Content frontend/src/pages/AllFilesPage.tsx | Measure-Object -Line
Get-Content frontend/src/pages/SettingsPage.tsx | Measure-Object -Line
```

Confirm the current public symbols include `uploadRouter`, `handleUpload`, `processRemoteImportJob`, `runTelegramSync`, `AllFilesPage`, `SettingsPage`, `RemoteImportModal`, `DriveLayout`, `UploadProvider`, and `useUpload`.

- [ ] **Step 2: Keep the tracker synchronized**

Update `TODO.md` after every verified phase. A phase may be checked only when its focused tests and package build have passed.

### Task 2: Phase 1 — Extract upload provider finalization

**Files:**
- Create: `backend/src/modules/uploads/upload-provider.service.ts`
- Modify: `backend/src/modules/uploads/upload.routes.ts`
- Test: `backend/src/modules/uploads/upload-provider.service.test.ts`

**Interfaces:**
- Consumes: current `resolveUploadPlacement` result, account/provider identifiers, staged path, file metadata, logical path, and abort signal.
- Produces: `finalizeStagedUpload(input): Promise<ProviderUploadResult>` where `ProviderUploadResult` contains `fileId`, `providerFileId`, and provider cleanup information; `upload.routes.ts` keeps `finalizeNonGoogleUpload` as a compatibility wrapper if existing tests require it.

- [ ] **Step 1: Write the failing provider-result tests**

Cover the existing S3 and Telegram success paths, provisional-row rollback on provider failure, post-commit cleanup after cancellation, Telegram stable-id/caption metadata, and unsupported-provider rejection. Assert returned IDs and persisted status rather than mock call counts alone.

- [ ] **Step 2: Run the focused tests and verify the missing boundary fails**

Run:

```powershell
cd backend
npx vitest run src/modules/uploads/upload-provider.service.test.ts
```

Expected: the new module/export is absent or the contract assertions fail for the unextracted boundary.

- [ ] **Step 3: Move provider-specific finalization with minimal behavior change**

Move `finalizeNonGoogleUpload`, Telegram remote cleanup, and provider-specific cleanup closures into the provider service. Keep the exact provisional `File` lifecycle, `pending` identity, Telegram metadata cache, S3 key construction, abort checks, and error propagation.

- [ ] **Step 4: Run focused and existing upload tests**

Run:

```powershell
cd backend
npx vitest run src/modules/uploads/upload-provider.service.test.ts src/modules/uploads/upload.routes.multipart.test.ts src/modules/uploads/upload.routes.direct-status.test.ts src/modules/uploads/storage-routing.test.ts
```

Expected: all selected tests pass with unchanged response assertions.

### Task 3: Phase 1 — Extract multipart orchestration

**Files:**
- Create: `backend/src/modules/uploads/multipart-upload.service.ts`
- Modify: `backend/src/modules/uploads/upload.routes.ts`
- Test: existing `backend/src/modules/uploads/upload.routes.multipart.test.ts`; add focused tests beside the service only when a behavior is not already covered.

**Interfaces:**
- Consumes: authenticated request stream, user ID, upload temp directory/config, placement service, provider finalizer.
- Produces: `processMultipartUpload(req, userId): Promise<MultipartUploadHttpResult>` with the existing single-file and batch response bodies; `handleUpload` validates auth/content type and translates this result.

- [ ] **Step 1: Capture current multipart contract assertions**

Run the existing multipart test file and record its assertions for metadata ordering, size mismatch, max size, parser errors, client abort, single-file response, batch `{ files, failed }`, and provider cleanup.

- [ ] **Step 2: Write one failing service-level contract test**

Invoke the desired service boundary with a multipart request stream and assert that declared bytes are staged, routed, finalized, and returned in the existing response shape. The test must fail because `processMultipartUpload` is not yet exported.

- [ ] **Step 3: Move Busboy, per-file lifecycle, and aggregation**

Move request event handling, batch reservation map, staging, declared-size validation, provider invocation, database session updates, cleanup, logging, and response aggregation. The service must keep `AbortController` shared across the request and remove temp data in success, parser failure, provider failure, and disconnect paths.

- [ ] **Step 4: Keep `handleUpload` as a thin compatibility façade**

Leave `handleUpload(req, res, next)` exported. It performs the current content-type check, calls the service, writes the same status/body, and passes unexpected errors to `next`.

- [ ] **Step 5: Run the upload suite**

Run:

```powershell
cd backend
npx vitest run src/modules/uploads
```

Expected: all upload tests pass.

### Task 4: Phase 1 — Extract resumable route services and verify Phase 1

**Files:**
- Create: `backend/src/modules/uploads/resumable-upload.service.ts`
- Modify: `backend/src/modules/uploads/upload.routes.ts`
- Test: existing resumable/direct S3/upload tests.

**Interfaces:**
- Consumes: authenticated user/session IDs, JSON init/preflight input, request body stream, and provider services.
- Produces: typed results for init, preflight, status, and chunk completion; route handlers retain endpoint paths and translate results to current HTTP responses.

- [ ] **Step 1: Write boundary tests for init, status, chunk, and provider completion**

Assert Google session creation and offset reporting, non-Google staged-chunk completion, size mismatch failure, ownership/not-found behavior, direct S3 status delegation, and existing response bodies.

- [ ] **Step 2: Run tests to verify the boundary is missing**

Run the focused resumable tests before implementation and confirm the new service contract fails for the expected missing export.

- [ ] **Step 3: Move resumable logic without changing route registration**

Move the code currently mounted at `/resumable/init`, `/resumable/preflight`, `/resumable/status/:id`, and `/resumable/chunk/:id` into the service. Keep `uploadRouter`, `directS3UploadRouter`, authentication middleware, and all status/error JSON unchanged.

- [ ] **Step 4: Verify Phase 1**

Run:

```powershell
cd backend
npx vitest run src/modules/uploads
npm run build
```

Check `public-api.routes.ts` still imports `handleUpload`, and update `TODO.md` only after both commands exit successfully.

### Task 5: Phase 2 — Add typed Remote Import context and progress/failure boundaries

**Files:**
- Create: `backend/src/modules/remote-imports/processor-context.ts`
- Create: `backend/src/modules/remote-imports/processor-progress.ts`
- Create: `backend/src/modules/remote-imports/processor-failure.ts`
- Modify: `backend/src/modules/remote-imports/processor.ts`
- Test: `backend/src/modules/remote-imports/processor-context.test.ts`, existing processor/resource-control tests.

**Interfaces:**
- Consumes: persisted RemoteImport record, decrypted source/request context, BullMQ job, and existing resource-control functions.
- Produces: `RemoteImportProcessorContext` with `importId`, `record`, `userId`, `folderId`, sanitized `fileName`, `mimeType`, `sourceUrl`, `requestContext`, `maxBytes`, `assertWithinTimeout`, `updateStage`, `heartbeat`, `assertNotCancelled`, and `markFailed`.

- [ ] **Step 1: Write failing context/progress tests**

Test that context methods preserve stage updates, heartbeat writes, cancellation errors, timeout errors, safe diagnostic serialization, and failure persistence codes/messages. The tests must exercise real helper behavior and only isolate Prisma/network boundaries where unavoidable.

- [ ] **Step 2: Run the tests and verify the missing context boundary fails**

Run:

```powershell
cd backend
npx vitest run src/modules/remote-imports/processor-context.test.ts
```

- [ ] **Step 3: Implement the context and move shared helpers**

Move `updateStage`, `writeHeartbeat`, `assertImportNotCancelled`, progress throttling/logging, `assertWithinTimeout`, and `markFailed` behind the context. Preserve persisted stage names, progress keys, safe diagnostics, and the existing error metadata.

- [ ] **Step 4: Run all current Remote Import tests**

Run:

```powershell
cd backend
npx vitest run src/modules/remote-imports
```

Expected: the current suite remains green before moving to phase functions.

### Task 6: Phase 2 — Extract direct probe/download/stream phases

**Files:**
- Create: `backend/src/modules/remote-imports/processor-direct.ts`
- Create: `backend/src/modules/remote-imports/processor-download.ts`
- Modify: `backend/src/modules/remote-imports/processor.ts`
- Test: existing `probe*.test.ts`, `stream-through.test.ts`, `processor-placement.test.ts`, and new direct phase tests where needed.

**Interfaces:**
- Consumes: `RemoteImportProcessorContext`, `SecureRemoteFetcher`, `followRemoteUrl`/stream-through helpers, and temp-storage functions.
- Produces: `probeSource(ctx): Promise<ProbeResult>`, `tryDirectStreamThrough(ctx, probe): Promise<boolean>`, and `downloadSourceToTemp(ctx, url): Promise<DownloadedSource>`.

- [ ] **Step 1: Write failing tests for the phase results**

Cover exact range validation, known/unknown lengths, max-size rejection, final URL propagation, cancellation, temp reservation release, and stream-through fallback. Assert persisted bytes/stages and typed results.

- [ ] **Step 2: Run focused tests and observe expected boundary failures**

Run the affected focused tests before moving code; confirm failures are due to the absent phase exports or desired contract.

- [ ] **Step 3: Move probe, Google/S3 stream-through, reservation, and temp download code**

Move `tryGoogleStreamThrough`, `tryS3StreamThrough`, `downloadToTemp`, and their state decoders into focused modules. Keep the existing encrypted provider state format, exact byte checks, cancellation, and cleanup behavior.

- [ ] **Step 4: Verify direct-path regressions**

Run:

```powershell
cd backend
npx vitest run src/modules/remote-imports/probe*.test.ts src/modules/remote-imports/stream-through.test.ts src/modules/remote-imports/processor-placement.test.ts src/modules/remote-imports/resource-control.test.ts
```

### Task 7: Phase 2 — Extract HLS, upload, registration, and orchestration tail

**Files:**
- Create: `backend/src/modules/remote-imports/processor-hls.ts`
- Create: `backend/src/modules/remote-imports/processor-upload.ts`
- Modify: `backend/src/modules/remote-imports/processor.ts`
- Test: existing HLS integration and Telegram metadata processor tests, plus stage-retry tests for persisted `retryFromStage` values.

**Interfaces:**
- Consumes: `RemoteImportProcessorContext`, HLS pipeline/job-dir helpers, placement service, and provider upload functions.
- Produces: `processHlsImport(ctx, job): Promise<'deferred' | 'completed' | null>`, `continueFromPart(ctx, source): Promise<void>`, and `registerImportedFile(ctx, upload): Promise<File>`.

- [ ] **Step 1: Write retry-from-stage tests before extraction**

Exercise persisted probing, downloading, remuxing, verifying, uploading, Google reauth, Telegram session invalidation, cancellation, and resource-waiting states. Confirm only the intended reusable temp part/job directory survives each failure.

- [ ] **Step 2: Run the retry tests to establish the red boundary**

Run the affected processor tests and confirm the new phase contracts are not present yet.

- [ ] **Step 3: Move HLS and provider upload/finalization details**

Move `processHlsImport`, `uploadTempFile`, `registerFile`, and `continueFromPart` while preserving the one authoritative transition path, HLS-vs-direct resource semantics, resume markers, provider-specific reauth behavior, quota refresh, and final encrypted URL registration.

- [ ] **Step 4: Keep the worker export stable**

Leave `export async function processRemoteImportJob(job: Job<RemoteImportJobData>)` in `processor.ts`; it constructs context, invokes phases in the current order, maps terminal errors once, and performs final temp cleanup once.

- [ ] **Step 5: Verify Phase 2**

Run:

```powershell
cd backend
npx vitest run src/modules/remote-imports
npm run build
```

Tick Phase 2 in `TODO.md` only after both pass.

### Task 8: Phase 3 — Extract Telegram classification and explicit sync types

**Files:**
- Create: `backend/src/modules/telegram/telegram-sync-types.ts`
- Create: `backend/src/modules/telegram/telegram-sync-classification.ts`
- Modify: `backend/src/modules/telegram/telegram-sync.service.ts`
- Test: `backend/src/modules/telegram/telegram-sync-classification.test.ts`

**Interfaces:**
- Consumes: `TelegramDocument`, optional existing `TelegramFileRow`, caption metadata, and stable identity fields.
- Produces: `classifyTelegramDocument(input): DocumentOutcome` with explicit `matched`, `imported`, `missing`, `conflict`, and `error` outcome data; `applyOutcomeStats` remains pure.

- [ ] **Step 1: Document and test matching precedence first**

Write tests for stable Telegram ID, provider file ID, caption ID/path metadata, metadata mismatch, missing caption, orphan recovery, user-owned MIME type, and encrypted-caption failure. Assert outcome kind and identifiers, not implementation calls.

- [ ] **Step 2: Run classification tests and verify the expected red state**

Run:

```powershell
cd backend
npx vitest run src/modules/telegram/telegram-sync-classification.test.ts
```

- [ ] **Step 3: Move pure classification/matching code**

Move `DocumentOutcome`, document/file row types, `classifyOne` decision logic, `applyOutcomeStats`, and related parsing inputs into the classification/types modules. Inject persistence/ingest callbacks rather than importing network clients into pure classification.

- [ ] **Step 4: Run the full Telegram suite**

Run:

```powershell
cd backend
npx vitest run src/modules/telegram
```

### Task 9: Phase 3 — Extract Telegram network, page persistence, and missing reconciliation

**Files:**
- Create: `backend/src/modules/telegram/telegram-sync-telegram.ts`
- Create: `backend/src/modules/telegram/telegram-sync-persistence.ts`
- Create: `backend/src/modules/telegram/telegram-sync-reconciliation.ts`
- Modify: `backend/src/modules/telegram/telegram-sync.service.ts`
- Test: existing Telegram sync/worker/trash tests and focused boundary tests.

**Interfaces:**
- Consumes: typed sync context, `withTelegramClient`, configured channel, page cursor, and Prisma.
- Produces: `fetchTelegramPageWithRetries`, `fetchMissingCaptions`, `persistPageOutcomes`, and `reconcileMissingTelegramFiles` with typed results and no shared page-wide mutable classification map.

- [ ] **Step 1: Write failing boundary tests**

Cover FloodWait delay/retry, page cursor progression, bounded caption concurrency, page-local `providerFileId IN (...)` queries, batch `lastSeenSyncRunId` stamping, issue deduplication, soft-delete opt-in, and generation-based missing detection.

- [ ] **Step 2: Run tests and verify the missing boundary**

Run the focused sync tests before extraction and confirm the new boundary assertions fail for the expected absent exports.

- [ ] **Step 3: Move network and persistence code**

Move `fetchPageWithRetries`, `fetchMissingPageCaptions`, `fetchCaptionForRemoteId`, `recordOutcome`, `createIssueIfOpenNotExists`, and missing-file handling. Keep FloodWait waits account-local and preserve exact issue/status/audit semantics.

- [ ] **Step 4: Keep `runTelegramSync` as the top-level lifecycle**

Leave lock acquisition/release, run creation, page loop, heartbeat/cancel, final state, audit, and usage refresh in `runTelegramSync`. Keep `telegram-sync.worker.ts` and routes unchanged.

- [ ] **Step 5: Verify Phase 3**

Run:

```powershell
cd backend
npx vitest run src/modules/telegram
npm run build
```

Tick Phase 3 in `TODO.md` only after both pass.

### Task 10: Phase 4 — Extract frontend data/action hooks and typed sections

**Files:**
- Create: `frontend/src/hooks/useAllFiles.ts`
- Create: `frontend/src/hooks/useSettings.ts`
- Create: `frontend/src/hooks/useRemoteImportForm.ts`
- Create: `frontend/src/hooks/useDriveLayout.ts`
- Create: `frontend/src/lib/upload-client.ts`
- Modify: `frontend/src/pages/AllFilesPage.tsx`
- Modify: `frontend/src/pages/SettingsPage.tsx`
- Modify: `frontend/src/components/drive/RemoteImportModal.tsx`
- Modify: `frontend/src/layouts/DriveLayout.tsx`
- Modify: `frontend/src/context/UploadContext.tsx`
- Test: existing frontend tests plus focused hook/component tests.

**Interfaces:**
- Hooks consume existing `apiFetch`, auth/session helpers, route query params, and callback props; they produce typed state/action objects owned by one page or context.
- `UploadProvider` continues to expose the current `useUpload` value and progress types; extracted upload helpers do not change direct/resumable transport behavior.

- [ ] **Step 1: Inventory state/effect/action ownership per target**

Record each `useState`, `useEffect`, API call, keyboard/mouse handler, dialog, and query-param update before moving it. Keep unrelated ownership separate; do not create a hook that merely contains the entire original file.

- [ ] **Step 2: Write failing focused tests for extracted boundaries**

Cover All Files query-param navigation and selection actions, Settings account loading/toggle/reconnect behavior, Remote Import probe/debounce/cURL/HLS form behavior, Drive layout storage refresh/navigation, and UploadContext progress/error/direct-path behavior. Any new hook test must fail before its export is implemented.

- [ ] **Step 3: Extract one target at a time**

Move the smallest cohesive boundary, run its focused tests, and preserve existing selectors, labels, accessible names, class names required by tests, and callback sequencing. Keep page files responsible for composition and route-level effects.

- [ ] **Step 4: Run the frontend focused suites**

Run:

```powershell
cd frontend
npm test -- --run src/context/UploadContext.test.tsx src/pages/RemoteImportsPage.test.tsx src/pages/WorkersPage.test.tsx src/pages/QuotaTrackerPage.test.tsx src/components/drive/FileTable.test.tsx
```

- [ ] **Step 5: Verify Phase 4**

Run:

```powershell
cd frontend
npm test
npm run build
```

Tick Phase 4 only after both commands pass and manual smoke checks cover selection, upload, Remote Import, settings, and navigation.

### Task 11: Final cross-phase verification and handoff

**Files:**
- Modify: `implementations/9drive-bottleneck-report-and-prompts/prompts/07-god-files/TODO.md`
- Modify: affected documentation under `docs/application`, `docs/reference`, and `docs/README.md` only where the extracted file map or architecture changed.

- [ ] **Step 1: Run complete backend verification**

```powershell
cd backend
npm test
npm run build
```

- [ ] **Step 2: Run complete frontend verification**

```powershell
cd frontend
npm test
npm run build
```

- [ ] **Step 3: Audit contracts and source structure**

Confirm route paths, public exports, worker signatures, stage/status literals, error codes, direct upload behavior, provider routing calls, HLS resource release, Telegram FloodWait/page bounds, and frontend routes/selectors are unchanged. Confirm no new dependency, env var, or migration exists.

- [ ] **Step 4: Perform the requested smoke checks**

Exercise register/login only as needed to enter the app, then verify file selection/navigation, upload progress and failure, Remote Import probe/create/cancel, Telegram settings/sync controls, connected storage display, and existing public routes.

- [ ] **Step 5: Tick the final tracker items and report evidence**

Record exact commands and pass/fail counts in `TODO.md`. Report changed files, migration/env status, test results, and residual risks without claiming performance improvement unless measured.

