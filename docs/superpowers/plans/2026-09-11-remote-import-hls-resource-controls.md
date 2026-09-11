# Remote Import / HLS Resource Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Remote Import while bounding its disk, queue, segment-download, and FFmpeg resource use.

**Architecture:** A process-local controller owns temp-storage reservations and FIFO abort-aware permits. Direct and HLS records use separate BullMQ queues while one processor keeps the existing database state machine. Eligible direct HTTP sources use persisted range-resumable Google/S3 transfers; every other case retains the temp spool. HLS segment and FFmpeg operations acquire shared process-wide permits.

**Tech Stack:** TypeScript, Node `fs.promises.statfs`, BullMQ, Prisma/MySQL, Google Drive resumable uploads, AWS S3 multipart uploads, Vitest.

**Spec:** `implementations/9drive-bottleneck-report-and-prompts/prompts/03-remote-import-hls/README.md` and its four phase documents.

## Global Constraints

- Preserve public API/status contracts, secure fetching/SSRF protection, retries, cancellation, and the temp-spool fallback.
- Do not log or expose source URLs, request context, credentials, resumable session URLs, S3 upload IDs, keys, or encrypted transfer state.
- HLS and Telegram remain on the existing spool behavior.
- Add persistent transfer state through Prisma schema plus migration; add no dependencies.
- Verify every task with focused tests and finish with `cd backend && npm run build` and `npm test`.

### Task 1: Temp storage inspection and recoverable admission

**Files:** create `backend/src/modules/remote-imports/resource-control.ts` and `resource-control.test.ts`; modify `temp-storage.ts`, `processor.ts`, `worker.ts`, and `config/env.ts`.

**Interfaces:** `inspectTempStorage(): Promise<{ freeBytes: bigint }>`; `estimateTempReservation({ sourceType, contentLength }): bigint`; `TempStorageReservations.tryAcquire(input)` returns either `{ admitted: true, reservation: { release() } }` or `{ admitted: false, diagnostics }`; `processRemoteImportJob` returns `'deferred' | undefined`.

- [ ] Write this failing test in `resource-control.test.ts`.

```ts
it('rejects a reservation that would consume the free-space reserve', async () => {
  const control = new TempStorageReservations(async () => ({ freeBytes: 150n }))
  await expect(control.tryAcquire({ importId: 'a', stage: 'downloading', requiredBytes: 60n, reserveBytes: 100n }))
    .resolves.toMatchObject({ admitted: false, diagnostics: { freeBytes: 150n, requiredBytes: 60n } })
})
```

- [ ] Run `cd backend && npm test -- src/modules/remote-imports/resource-control.test.ts`; it must fail because the controller does not exist.
- [ ] Implement `fsp.statfs(tempDir())` after `ensureTempDir()`, using `BigInt(stats.bavail) * BigInt(stats.bsize)`. Keep an idempotent in-memory reservation ledger. A known direct source reserves content length; unknown direct sources use `REMOTE_IMPORT_TEMP_UNKNOWN_RESERVATION_BYTES`; HLS uses `REMOTE_IMPORT_TEMP_HLS_RESERVATION_BYTES`; all paths retain `REMOTE_IMPORT_TEMP_FREE_SPACE_RESERVE_BYTES`.
- [ ] Acquire before `downloadToTemp` and HLS job materialization. On rejection persist `{ status: 'queued', stage: 'waiting', errorCode: 'RESOURCE_WAITING', errorMessage: 'Waiting for temporary storage capacity.', internalError: JSON.stringify({ freeBytes, reservedBytes, requiredBytes, stage, importId, reason }) }`, return `'deferred'`, and have the worker throw `DelayedError`. Release in each `finally`, including failures and cancellation.
- [ ] Run `cd backend && npm test -- src/modules/remote-imports/resource-control.test.ts src/modules/remote-imports/processor-placement.test.ts`; expect PASS. Commit `feat(remote-import): defer work when temp storage is reserved`.

### Task 2: Independent direct and HLS queues

**Files:** modify `queue.ts`, `worker.ts`, `worker-entry.ts`, `remote-import.service.ts`, `queue-reconcile.ts`, `queue.test.ts`, and `config/env.ts`; create `worker.test.ts`.

**Interfaces:** `RemoteImportWorkload = 'direct' | 'hls'`; `workloadForRemoteImport({ sourceType })`; `enqueueRemoteImport(importId, attempt, workload)`; `createRemoteImportWorkers(): Worker<RemoteImportJobData>[]`.

- [ ] Write these failing tests.

```ts
it('classifies HLS separately from direct work', () => {
  expect(workloadForRemoteImport({ sourceType: 'hls_master' })).toBe('hls')
  expect(workloadForRemoteImport({ sourceType: null })).toBe('direct')
})

it('creates independent direct and HLS consumers', () => {
  expect(createRemoteImportWorkers().map((worker) => worker.name)).toEqual(
    expect.arrayContaining(['remote-imports-direct', 'remote-imports-hls']),
  )
})
```

- [ ] Run `cd backend && npm test -- src/modules/remote-imports/queue.test.ts src/modules/remote-imports/worker.test.ts`; it must fail because workload queues are absent.
- [ ] Implement `remote-imports-direct` and `remote-imports-hls`, configured by `REMOTE_IMPORT_DIRECT_CONCURRENCY` and `REMOTE_IMPORT_HLS_JOB_CONCURRENCY`, both defaulting to the old global value. Use a single shared per-user counter in both worker handlers. Persist only the existing job ID in the row; queue lookup, cancellation, retry, and reconciliation choose by `sourceType` and search both queues for legacy rows. Both workers invoke the same processor.
- [ ] Run `cd backend && npm test -- src/modules/remote-imports/queue.test.ts src/modules/remote-imports/worker.test.ts src/modules/remote-imports/queue-reconcile.test.ts src/modules/remote-imports/remote-import.service.test.ts`; expect PASS. Commit `feat(remote-import): separate direct and HLS worker budgets`.

### Task 3: Persisted stream-through direct transfer

**Files:** create `stream-through.ts` and `stream-through.test.ts`; modify `google-resumable-uploader.ts`, `processor.ts`, `s3.service.ts`, `schema.prisma`; create a Prisma migration.

**Interfaces:** `getStreamThroughEligibility(input): { eligible: boolean; reason?: string }`; `transferDirectStreamThrough(input)`; a `RemoteImport.streamUploadStateEncrypted` text field storing encrypted provider resume metadata.

- [ ] Write this failing test.

```ts
it('only permits bounded, range-supported ordinary sources', () => {
  expect(getStreamThroughEligibility({ sourceType: null, sourceRangeSupported: true, contentLength: 100n, provider: 'google_drive' })).toMatchObject({ eligible: true })
  expect(getStreamThroughEligibility({ sourceType: 'hls_media', sourceRangeSupported: true, contentLength: 100n, provider: 'google_drive' })).toMatchObject({ eligible: false })
  expect(getStreamThroughEligibility({ sourceType: null, sourceRangeSupported: true, contentLength: 100n, provider: 'telegram' })).toMatchObject({ eligible: false })
})
```

- [ ] Run `cd backend && npm test -- src/modules/remote-imports/stream-through.test.ts`; it must fail because the module is absent.
- [ ] Add `streamUploadStateEncrypted String? @map("stream_upload_state_encrypted") @db.Text` and a normal migration. For Google, create/query a resumable session and PUT bounded range-read chunks with `Content-Range`, persisting the acknowledged next offset. For S3, create/reconstruct multipart state with `ListParts`, persist ETags and the next offset after each acknowledged part, and complete exactly once. Fetch each source chunk through `SecureRemoteFetcher` with a validated Range request and terminate its iterator. Abort upstream and provider work on cancellation/non-retryable failure.
- [ ] Probe range behavior before selection, resolve placement afterward, then call the fast path only when source, exact length, and provider are eligible. Keep `downloadToTemp` for every other case. Retain transfer state solely for retryable interruption; clear it only after File registration.
- [ ] Run `cd backend && npm run prisma:generate && npm test -- src/modules/remote-imports/stream-through.test.ts src/modules/remote-imports/processor-placement.test.ts src/modules/s3/s3.service.test.ts && npm run build`; expect PASS. Commit `feat(remote-import): resume eligible direct transfers without temp spool`.

### Task 4: Fair global HLS segment and FFmpeg permits

**Files:** modify `resource-control.ts`, `resource-control.test.ts`, `hls/materialize.ts`, `hls/ffmpeg.ts`, `hls/segments.test.ts`, `hls/ffmpeg.test.ts`, and `config/env.ts`.

**Interfaces:** `FairSemaphore.acquire({ signal?, ownerId? }): Promise<{ release(): void }>`; process-wide `hlsSegmentPermits` and `ffmpegPermits` driven by `REMOTE_IMPORT_HLS_GLOBAL_SEGMENT_CONCURRENCY` and `REMOTE_IMPORT_HLS_FFMPEG_CONCURRENCY`.

- [ ] Write this failing test.

```ts
it('does not leak a permit when a queued waiter is cancelled', async () => {
  const sem = new FairSemaphore(1)
  const active = await sem.acquire()
  const abort = new AbortController()
  const waiting = sem.acquire({ signal: abort.signal })
  abort.abort()
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  active.release()
  await expect(sem.acquire()).resolves.toMatchObject({ release: expect.any(Function) })
})
```

- [ ] Run `cd backend && npm test -- src/modules/remote-imports/resource-control.test.ts`; it must fail because `FairSemaphore` is absent.
- [ ] Implement FIFO queueing, abort-listener removal, idempotent release, and no negative active count. Retain each per-job segment limit and acquire a global permit only around a real segment transfer. Wrap every `runFfmpegProcess` spawn in an FFmpeg permit so remux, timestamp compatibility retry, concat-copy, and re-encode share the same cap.
- [ ] Run `cd backend && npm test -- src/modules/remote-imports/resource-control.test.ts src/modules/remote-imports/hls/segments.test.ts src/modules/remote-imports/hls/ffmpeg.test.ts src/modules/remote-imports/processor-hls.integration.test.ts`; expect PASS (the binary integration may skip if FFmpeg is unavailable). Commit `feat(hls): bound process-wide segments and ffmpeg`.

### Task 5: Documentation and completion audit

**Files:** modify `docs/reference/environment.md`, `docs/application/features/remote-imports.md`, `docs/application/workflows/remote-import.md`, `docs/application/integrations/ffmpeg-hls.md`, `docs/runbooks/remote-import-troubleshooting.md`, and `implementations/9drive-bottleneck-report-and-prompts/prompts/03-remote-import-hls/TODO.md`.

- [ ] Document defaults, admission diagnostics, queue topology, stream-through eligibility/fallback, persisted recovery state, global HLS permits, and operator troubleshooting; do not make performance claims.
- [ ] Run `cd backend && npm test -- src/modules/remote-imports src/modules/s3/s3.service.test.ts && npm run build && npm test`; record exact outcomes in `TODO.md`.
- [ ] Tick only verified checklist items and commit `docs(remote-import): document resource controls`.
