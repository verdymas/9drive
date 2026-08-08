# Claude Code Prompt — Fix Remote Import Upload Progress and Final Filename

You are working inside the existing 9Drive project.

The Remote Import feature is already implemented, including direct-file imports and HLS/M3U8 imports with FFmpeg remuxing.

There are two bugs that must now be fixed:

1. After HLS processing/remuxing finishes and the resulting file starts uploading to Google Drive or S3, the Remote Import UI does not show upload progress.
2. The final uploaded filename is sometimes different from the filename explicitly entered by the user when creating the Remote Import.

Inspect the actual repository and current implementation before modifying files.

Do not assume filenames, route names, service names, database fields, or frontend component names.

Trace the complete flow:

```text
Remote Import create
→ database record
→ queue
→ worker
→ direct download OR HLS materialization
→ FFmpeg remux
→ ffprobe
→ provider upload
→ file registration
→ Remote Imports progress UI
```

Inspect at least:

- Remote Import Prisma model.
- Remote Import create API.
- Remote Import worker.
- HLS worker/remux implementation.
- Direct-file import worker.
- Existing Google Drive uploader.
- Existing S3 uploader.
- Existing resumable/multipart upload logic.
- Existing normal file upload progress implementation.
- Existing progress event/broadcast/polling infrastructure.
- Remote Imports page.
- Remote Import item/card component.
- Filename auto-detection.
- Filename sanitization.
- Retry flow.
- Provider File creation service.
- Existing tests.

Before coding, identify the exact root cause of both bugs, then continue with the implementation.

---

# 1. Uploaded filename must use the filename chosen by the user

The filename supplied when the Remote Import is created must be the canonical final filename.

Example:

```json
{
  "url": "https://example.com/master.m3u8",
  "fileName": "My Movie (2026).mkv"
}
```

The final uploaded provider object and 9Drive File record must both be:

```text
My Movie (2026).mkv
```

The worker must NOT replace it with names derived from:

- The original source URL.
- The final redirected URL.
- The M3U8 filename.
- The temporary file.
- The FFmpeg output filename.
- `output.mkv`.
- `output.part.mkv`.
- The provider-generated filename.
- A UUID.
- A job ID.
- Content-Disposition discovered again later.

The user-selected effective filename must survive the entire job lifecycle.

---

# 2. Establish one canonical filename field

Inspect the existing Remote Import model.

Determine which current field is intended to represent the final requested filename.

Use one canonical value conceptually equivalent to:

```ts
remoteImport.fileName
```

or:

```ts
remoteImport.requestedFileName
```

Do not introduce another redundant filename field unless the current schema is ambiguous and a migration is genuinely necessary.

At Remote Import creation:

```text
detected filename
        ↓
user optionally edits filename
        ↓
sanitize
        ↓
validate
        ↓
store canonical filename in database
```

After the job is created, that canonical filename must be treated as immutable for that execution, except for an explicitly documented output-extension normalization before the job starts.

Do not let later source probing overwrite it.

---

# 3. HLS output filename handling

Temporary FFmpeg files should still use internal safe generated names.

Example:

```text
/job-id/output.part.mkv
/job-id/output.mkv
```

That is correct for temporary storage.

However, the provider upload metadata must use:

```ts
remoteImport.fileName
```

not:

```ts
path.basename(outputPath)
```

and not:

```ts
output.mkv
```

Conceptual distinction:

```text
Local temporary file:
  /data/.../output.mkv

Provider filename:
  My Movie (2026).mkv
```

These two values are intentionally different.

The temporary path is an implementation detail.

---

# 4. Output-container extension rules

Preserve the filename the user explicitly chose.

However, prevent filename/container mismatches before the job begins.

If effective output container is `mkv` and the user enters `Movie.mkv`, keep exactly `Movie.mkv`.

If the filename was automatically generated as `Movie.m3u8` and output becomes MKV, auto-normalize it before creation to `Movie.mkv`.

If the user manually entered `Movie.mp4` while explicitly selecting MKV, do NOT silently upload an MKV stream with an `.mp4` filename.

Preferred behavior:

- Validate before submission.
- Tell the user the filename extension must match the selected output container.

Do not silently rename the filename later inside the worker.

The filename displayed in the create modal immediately before submission must be the filename ultimately uploaded.

---

# 5. Final File record naming

After provider upload completes, inspect how the regular 9Drive File row is created.

Ensure:

```ts
File.name === RemoteImport.fileName
```

The provider's returned object name must not unexpectedly become the canonical 9Drive virtual filesystem name.

The uploaded provider object and virtual File record should normally have the same requested name.

If the provider API internally returns another name, preserve the user-requested name in the 9Drive File record and investigate why the provider upload metadata did not receive the requested name.

Add assertions or defensive validation where appropriate.

---

# 6. Retry must preserve filename

Retrying a Remote Import must preserve the original canonical filename.

Example:

```text
My Movie (2026).mkv
```

If upload fails and the user retries, the final file must still be:

```text
My Movie (2026).mkv
```

It must not become:

```text
output.mkv
remote-file.mkv
job-id.mkv
source.mkv
```

Do not re-run filename auto-detection during retry.

---

# 7. Add proper upload progress

After download/remux/verification finishes, Remote Import enters:

```text
uploading
```

At that point show an actual upload progress bar.

Required state:

```text
Uploading to Google Drive · 64%
[████████████░░░░░░]
```

The upload progress must represent:

```text
uploaded output bytes / final output file size
```

Do NOT use:

- Source HLS bytes.
- Manifest bytes.
- Total downloaded segments.
- Source Content-Length.
- Duration.
- FFmpeg remux progress.

The final remux output may differ in size from the downloaded source.

---

# 8. Initialize upload progress correctly

Immediately before provider upload begins:

1. Stat the final output file.

```ts
const outputStat = await fs.stat(finalOutputPath)
```

2. Set:

```text
stage = uploading
uploadedBytes = 0
uploadTotalBytes = outputStat.size
```

If the current schema already uses `totalBytes` for final upload size, inspect semantics carefully before reusing it.

Do not corrupt download progress values.

Preferred conceptual fields are:

```text
downloadedBytes
downloadTotalBytes

uploadedBytes
uploadTotalBytes
```

If the existing schema already contains equivalents, reuse them.

If only one ambiguous `totalBytes` exists and it cannot safely represent both source and final output sizes, refactor the model with a Prisma migration.

For HLS, source byte count and final output byte count are separate concepts.

---

# 9. Google Drive upload progress

Inspect the current Google Drive upload implementation.

If it already supports resumable uploads, expose progress from the resumable upload loop.

The upload service should support a callback or event interface conceptually like:

```ts
type UploadProgressCallback = (progress: {
  uploadedBytes: bigint
  totalBytes: bigint
}) => Promise<void> | void
```

Conceptual API:

```ts
await googleDriveUploader.upload({
  filePath,
  fileName,
  mimeType,
  onProgress,
})
```

During each successfully acknowledged resumable chunk:

```text
uploadedBytes = confirmed uploaded offset
```

Do not report bytes merely read from disk unless the provider has actually accepted them where practical.

Progress must be monotonic.

Never report more than total bytes.

On completion:

```text
uploadedBytes = uploadTotalBytes
uploadProgress = 100
```

---

# 10. S3 upload progress

Inspect the S3-compatible upload implementation.

If multipart upload is used, expose progress through the existing AWS SDK upload events or multipart completion tracking.

Reuse the existing provider abstraction.

Conceptual interface:

```ts
await s3Uploader.upload({
  filePath,
  fileName,
  mimeType,
  onProgress,
})
```

Both Google Drive and S3 must expose the same provider-independent progress callback to Remote Import.

Do not put provider-specific progress logic directly inside the Remote Import worker if a reusable upload abstraction can expose it.

---

# 11. Reuse normal upload infrastructure

Inspect whether ordinary 9Drive browser uploads already have progress-capable provider services.

Reuse or extend those services rather than implementing a second uploader only for Remote Import.

The architecture should conceptually become:

```text
Remote Import Worker
        ↓
Storage Upload Service
        ↓
Provider Adapter
   ┌────┴────┐
Google      S3
 Drive
   │          │
onProgress  onProgress
   └────┬─────┘
        ↓
Remote Import progress persistence
```

Keep the storage provider abstraction reusable.

---

# 12. Persist upload progress

Upload progress must survive page refresh.

Do not keep it only in worker memory.

Persist at least:

```text
stage
uploadedBytes
uploadTotalBytes
updatedAt
```

Avoid a database update for every small chunk.

Reuse the current Remote Import progress throttling.

Recommended behavior:

```text
update at most every ~1 second
```

Always persist:

- Stage transition to uploading.
- Initial 0 bytes.
- Final 100%.
- Failure state.
- Cancellation state.

---

# 13. Realtime/polling progress

Inspect how Remote Imports currently refresh progress.

If the project uses WebSocket, SSE, Socket.IO, or React Query polling, reuse it.

When upload progress changes, the frontend must receive data equivalent to:

```json
{
  "status": "processing",
  "stage": "uploading",
  "uploadedBytes": 1073741824,
  "uploadTotalBytes": 4294967296,
  "uploadProgress": 25
}
```

Adapt field names to current API conventions.

Do not create a second realtime system.

---

# 14. Frontend: separate stage-specific progress

The Remote Import item should clearly distinguish processing stages.

Preferred compact behavior:

During segment download:

```text
Downloading HLS segments · 72%
[progress]
```

During remux:

```text
Encoding / Remuxing · 64%
[progress]
```

During upload:

```text
Uploading to Google Drive · 42%
[progress]
```

The same progress component can be reused, but its source value must switch according to the current stage.

When stage changes from remuxing to uploading:

```text
progress must reset from remux 100% to upload 0%
```

Do not leave the bar at 100% while upload has just started.

---

# 15. Explicit upload progress bar requirement

The current bug is that after encoding/remux reaches 100%, the item looks as if nothing is happening while provider upload runs.

Fix this.

As soon as:

```text
stage === "uploading"
```

render:

```text
Uploading to {provider/account}
```

plus:

```text
upload progress bar
percentage
uploaded size / total output size
```

Example:

```text
Uploading to Google Drive

[██████████████░░░░░░] 68%

5.4 GB / 8.0 GB
```

Use the project's existing byte-formatting utility.

If upload total size is temporarily unknown:

```text
Uploading to Google Drive
[indeterminate progress]
5.4 GB uploaded
```

But for local files it should normally be known from `stat()`.

---

# 16. Progress calculation

Use a safe helper:

```ts
function percent(current: bigint, total: bigint): number {
  if (total <= 0n) return 0

  const result = Number((current * 10_000n) / total) / 100
  return Math.min(100, Math.max(0, result))
}
```

Avoid unsafe conversion of very large BigInt byte values before division.

Use the repository's existing BigInt serialization patterns.

Never return `NaN`, `Infinity`, values greater than 100, or values below 0.

---

# 17. Direct-file imports also need upload progress

Do not fix this only for HLS.

The same provider-upload stage exists for:

```text
direct URL
→ downloaded temp file
→ provider upload
```

Therefore both Direct Remote Import and HLS Remote Import must show upload progress.

Reuse the same code path.

---

# 18. Completed state

After provider upload succeeds:

```text
stage = registering
```

Then after File registration:

```text
status = completed
stage = finished
uploadedBytes = uploadTotalBytes
uploadProgress = 100
```

The completed item should display the final canonical filename.

Example:

```text
My Movie (2026).mkv
Completed
```

not:

```text
output.mkv
```

---

# 19. Error handling

If provider upload fails at 63%, persist the last confirmed upload progress.

The UI can show:

```text
Upload failed at 63%
```

Retry behavior should reuse the existing complete local output when available.

If Google Drive resumable upload can continue from an existing session, reuse the current resumable-upload mechanism. Otherwise restart upload safely.

Do not re-run HLS download/remux when a valid complete output file still exists unless required.

---

# 20. Naming tests

Add tests for:

## Direct file

User enters:

```text
custom-name.zip
```

Final provider name and final 9Drive File.name must both be:

```text
custom-name.zip
```

## HLS MKV

User enters:

```text
Movie Name (2026).mkv
```

Temporary local path may be:

```text
/job/output.mkv
```

But provider object and File.name must both be:

```text
Movie Name (2026).mkv
```

## HLS retry

Retry must preserve:

```text
Movie Name (2026).mkv
```

## Unicode

```text
映画 - Episode 01.mkv
```

must remain valid after sanitization and upload.

## Spaces

```text
My Movie Final Cut.mkv
```

must remain unchanged.

---

# 21. Upload progress tests

Add worker/integration tests covering:

1. Direct import upload progress.
2. HLS output upload progress.
3. Initial upload state is 0%.
4. Progress increases monotonically.
5. Progress persists to database.
6. Progress never exceeds 100%.
7. Final progress is 100%.
8. Failed upload preserves last confirmed progress.
9. Retry resets or resumes correctly.
10. Google Drive progress callback.
11. S3 progress callback.
12. Page refresh still shows current upload progress.

Use controlled mocked provider adapters where appropriate.

Also add at least one integration test using a fake provider that emits:

```text
0%
10%
37%
72%
100%
```

Verify the Remote Import record and UI follow those values.

---

# 22. Frontend tests

Add/update tests for the Remote Import item.

Test that `stage = uploading` renders:

```text
Uploading to Google Drive
```

and a visible progress bar.

Test that:

```text
uploadedBytes = 536870912
uploadTotalBytes = 1073741824
```

renders approximately:

```text
50%
512 MB / 1 GB
```

using the actual formatter conventions.

Also test:

- Progress resets when stage changes from remuxing to uploading.
- Completed item displays canonical user filename.
- Failed upload displays upload failure state.
- Retry preserves filename.
- Long filenames still respect the existing overflow-safe layout.

---

# 23. Regression checks

Verify no regression in:

- Remote Import creation.
- Filename auto-detection.
- Manual filename editing.
- Direct URL imports.
- HLS imports.
- Variant selection.
- HLS remux.
- ffprobe.
- Retry.
- Cancellation.
- Automatic storage routing.
- Manual account selection.
- Google Drive upload.
- S3 upload.
- Existing normal user uploads.
- File listing.
- Open destination.
- Remote Imports responsive layout.

---

# 24. Manual verification

Perform the following manual test.

Create an HLS import with:

```text
Filename:
Remote Import Test Movie.mkv
```

Verify the UI goes through:

```text
Downloading HLS segments
→ progress visible

Remuxing
→ progress visible

Uploading to Google Drive
→ upload progress starts at or near 0%
→ upload progress increases
→ bytes uploaded displayed

Completed
```

Then inspect Google Drive.

The actual uploaded object must be named exactly:

```text
Remote Import Test Movie.mkv
```

Then inspect the 9Drive database/API.

The File record must also be:

```text
Remote Import Test Movie.mkv
```

Do not accept:

```text
output.mkv
source.mkv
UUID.mkv
original-m3u8-name.mkv
```

Repeat with a direct-file Remote Import.

---

# 25. Required commands

Determine exact repository commands and run all applicable checks:

- Prisma format if schema changes.
- Prisma validate.
- Prisma generate.
- Prisma migration if required.
- Backend lint.
- Backend type check.
- Backend tests.
- Worker tests.
- Frontend lint.
- Frontend type check.
- Frontend tests.
- Frontend build.
- Docker Compose validation.
- Docker worker build.

Do not claim success unless commands were actually executed.

Fix all failures introduced by this change.

Clearly identify unrelated pre-existing failures.

---

# 26. Final report

At completion provide:

## Root causes

Explain separately:

1. Why upload progress was not displayed.
2. Why uploaded filename differed from the requested filename.

## Naming flow

Show the final flow:

```text
user filename
→ sanitize
→ Remote Import canonical filename
→ worker
→ provider upload metadata
→ 9Drive File.name
```

## Progress flow

Show:

```text
worker/provider
→ progress callback
→ throttled database persistence
→ API/realtime
→ Remote Import progress bar
```

## Files changed

List all important files.

## Database changes

Explain any migration.

## Google Drive changes

Explain how upload progress is obtained.

## S3 changes

Explain how upload progress is obtained.

## Frontend changes

Explain upload-stage UI behavior.

## Tests

List tests and results.

## Manual verification

Report final uploaded filename and upload progress behavior.

Do not consider the work complete until:

- A Remote Import reaches the uploading stage.
- A visible upload progress bar increases from 0 to 100.
- The provider receives the exact canonical filename.
- The resulting 9Drive File record uses the same filename.
- HLS and direct-file Remote Imports both pass the same behavior.

---

# 27. Fix HLS conversion retry stuck forever in `queued`

There is an additional Remote Import bug:

When an HLS/M3U8 conversion fails and the user clicks Retry, the Remote Import
often remains in:

```text
queued
```

forever.

The UI provides no reliable indication whether:

- the retry was actually enqueued,
- the worker has started it,
- the worker is unavailable,
- the queue job is missing,
- the job is delayed,
- the job is stalled,
- the retry immediately failed,
- the retry is waiting behind another job,
- or the queue deduplicated/rejected the retry.

Fix this as part of the same refactor.

Do not solve this by changing the frontend label only.

Trace the complete retry lifecycle:

```text
user clicks Retry
→ retry API
→ database state transition
→ BullMQ/queue enqueue
→ queue job ID persisted
→ worker receives job
→ worker marks execution started
→ stage-specific retry begins
→ heartbeat/progress updates
→ success OR explicit failure
```

Identify the exact root cause of the current `queued forever` behavior before
modifying the queue lifecycle.

Investigate especially:

- Whether retry uses the same BullMQ `jobId` as the previous execution.
- Whether an old failed/completed BullMQ job still exists and prevents a new job
  with the same ID from being added.
- Whether `removeOnComplete` / `removeOnFail` behavior affects retries.
- Whether retry updates the database to `queued` before the queue add succeeds.
- Whether queue add errors are swallowed.
- Whether Redis/queue connection errors are ignored.
- Whether the worker listens to the same queue name as the producer.
- Whether retry jobs use a different job name the worker does not process.
- Whether a stage-specific retry payload is malformed.
- Whether concurrency/per-user locking prevents the job from ever starting.
- Whether a stale lock survives a failed conversion.
- Whether a cancellation flag remains set from the previous execution.
- Whether the queue is paused.
- Whether the worker process is alive but not consuming.
- Whether the old job is still `active`, `delayed`, `waiting`, `failed`, or
  `completed`.
- Whether the retry job is created but the database stores the old queue job ID.

Do not assume the cause. Reproduce it and inspect BullMQ/Redis state.

---

# 28. Retry execution identity

A Remote Import database record represents the logical import.

A queue job represents one execution attempt.

Do not treat them as the same identity.

Preferred design:

```text
RemoteImport.id
    ↓
logical import

RemoteImport attempt 1
    ↓
queueJobId = <remoteImportId>:1

RemoteImport attempt 2
    ↓
queueJobId = <remoteImportId>:2

RemoteImport attempt 3
    ↓
queueJobId = <remoteImportId>:3
```

Use the repository's actual ID and naming conventions.

If BullMQ `jobId` currently equals only:

```ts
remoteImport.id
```

and this prevents retry jobs from being added, refactor it.

Use a unique execution identifier such as:

```ts
`${remoteImport.id}:${attemptNumber}`
```

or a generated execution ID persisted on the Remote Import record.

Do not rely on manually deleting the old queue job as the only retry strategy.

The logical Remote Import ID must remain stable so the frontend continues to
display one history item.

---

# 29. Persist retry/queue execution metadata

Inspect the existing Remote Import schema.

Reuse equivalent fields when they already exist.

If required, add fields conceptually equivalent to:

```text
attempts
queueJobId
queuedAt
startedAt
heartbeatAt
lastProgressAt
retryRequestedAt
retryFromStage
workerId (optional)
```

Do not add unnecessary fields if equivalent state already exists.

Important semantics:

```text
queuedAt
→ when queue.add() succeeds

startedAt
→ when a worker actually begins this execution

heartbeatAt
→ periodically while active

lastProgressAt
→ when meaningful job progress is persisted
```

Do not set `startedAt` merely because the Retry button was clicked.

For a retry, retain useful history such as attempt count and previous failure
diagnostics according to current data-model conventions.

---

# 30. Never mark retry as queued before enqueue succeeds

The retry API must not do this:

```text
database status = queued
        ↓
queue.add()
        ↓
queue.add() throws
        ↓
API hides error
        ↓
database stays queued forever
```

Fix the ordering/transactional behavior.

Preferred conceptual flow:

```text
validate retry eligibility
        ↓
determine retry stage
        ↓
prepare next attempt number
        ↓
queue.add(...)
        ↓
queue add succeeds and returns job ID
        ↓
persist:
  status = queued
  stage = waiting
  queueJobId = new job ID
  queuedAt = now
  retryRequestedAt = now
  attempts = next attempt
```

If database and queue semantics require the database row to exist/update before
`queue.add()`, implement compensating behavior:

- If enqueue fails, restore a stable failed/retryable state.
- Persist an enqueue-specific error.
- Never leave the item as `queued`.

The API must return an error when the retry could not actually be enqueued.

Do not return `200`/`202` claiming success if queue insertion failed.

---

# 31. Worker must immediately mark a retry as started

As soon as the worker receives the retry job, persist an explicit transition:

```text
status = processing
startedAt = now
heartbeatAt = now
```

Then set the actual stage.

For example, if retrying conversion:

```text
stage = remuxing
```

or use a short transitional stage if the current architecture requires it:

```text
stage = preparing_retry
→ remuxing
```

The frontend must not continue showing `queued` after the worker is actually
running.

Persist this transition before starting expensive FFmpeg work.

---

# 32. Stage-aware retry

Retry must resume from the earliest necessary stage.

For an HLS job:

## Case A — segment/materialization failure

```text
retry from:
downloading_segments
```

Reuse valid completed segments when supported.

## Case B — local materialization complete, FFmpeg/remux failed

```text
retry from:
remuxing
```

Do not download all HLS segments again when:

- local segments are complete,
- local playlist validates,
- required maps/keys are present,
- materialization state is still valid.

This is the specific "retry convert" path that currently gets stuck.

## Case C — FFmpeg output exists and ffprobe passed, provider upload failed

```text
retry from:
uploading
```

Do not run FFmpeg again.

## Case D — registration failed after provider upload

Resume registration safely without duplicate provider upload when possible.

Persist or derive a stable value equivalent to:

```text
retryFromStage
```

Do not trust a frontend-provided arbitrary retry stage.

Determine it server-side from persisted artifacts and state.

---

# 33. Explicit UI state for retry

When the user clicks Retry, show an immediate explicit state.

Example before worker starts:

```text
Queued for retry
Attempt 2
Waiting for worker…
```

For HLS conversion retry:

```text
Queued for conversion retry
Attempt 2
```

When the worker starts:

```text
Retrying conversion
Attempt 2
[progress]
```

When retry reaches upload:

```text
Uploading to Google Drive
Attempt 2
[progress]
```

If it fails:

```text
Conversion retry failed
Attempt 2
<safe error message>
[Retry]
```

Do not display only:

```text
Queued
```

with no indication of retry attempt or whether the worker started.

Use the existing visual style; do not redesign the Remote Imports page.

---

# 34. Show queue waiting duration

While genuinely waiting:

```text
Queued for retry · waiting 18s
```

or equivalent subtle metadata.

The UI should derive elapsed time from `queuedAt`.

Do not update the database every second merely to render elapsed time.

Use frontend time calculation.

If queue position is reliably available from BullMQ without expensive polling,
it may optionally be shown:

```text
2 jobs ahead
```

but queue position is NOT required.

Do not fake a queue position.

---

# 35. Detect jobs that never start

A queued retry must not remain ambiguous forever.

Add configuration equivalent to:

```dotenv
REMOTE_IMPORT_QUEUE_START_TIMEOUT_SECONDS=300
REMOTE_IMPORT_WORKER_HEARTBEAT_TIMEOUT_SECONDS=120
```

Choose actual defaults consistent with deployment needs.

Meaning:

```text
QUEUE_START_TIMEOUT
```

is the maximum time a job may remain in the application's `queued` state
without evidence that a corresponding valid queue job is still waiting/delayed.

Do NOT blindly fail every job after 5 minutes if it is legitimately waiting
behind long-running work.

Before declaring failure, reconcile with actual queue state.

Conceptual reconciliation:

```text
RemoteImport.status = queued
        ↓
load queue job by queueJobId
        ↓
job missing?
    → fail QUEUE_JOB_MISSING

job failed?
    → synchronize failed state

job active?
    → synchronize processing state

job waiting/delayed?
    → keep queued and show waiting

job completed?
    → reconcile application state

unknown/inconsistent for too long?
    → fail QUEUE_STATE_INCONSISTENT
```

Use BullMQ APIs appropriate to the installed version.

Do not query Redis internals using fragile custom key assumptions when BullMQ
provides supported APIs.

---

# 36. QueueEvents / worker lifecycle integration

Inspect whether BullMQ `QueueEvents` or equivalent is already used.

If suitable, consume lifecycle events for:

```text
waiting
active
progress
completed
failed
stalled
delayed
```

Use them to improve state reconciliation.

Do not make QueueEvents the only source of truth; the worker must still persist
critical state directly.

Important transitions:

```text
active
→ ensure Remote Import is processing

failed
→ ensure Remote Import is failed with safe error

stalled
→ surface a meaningful state and allow BullMQ retry/recovery rules

completed
→ reconcile if application state did not reach completed due to a crash
```

Avoid duplicate conflicting writes between QueueEvents and the worker.

---

# 37. Handle BullMQ stalled jobs explicitly

A process crash during FFmpeg may cause a BullMQ job to become stalled.

Inspect current BullMQ settings:

- `lockDuration`
- `lockRenewTime`
- `maxStalledCount`
- worker concurrency
- blocking timeout
- job timeout strategy

Do not confuse a long FFmpeg process with a stalled worker.

As long as the Node worker event loop is healthy, BullMQ should renew the lock.

Ensure the implementation does not block the Node event loop with synchronous
file/process operations during conversion.

Use async process handling.

When BullMQ declares a job stalled:

- Log safely.
- Persist a meaningful execution state.
- Let configured recovery occur.
- If it exceeds `maxStalledCount`, mark the Remote Import failed with a stable
  error.

Suggested stable errors:

```text
REMOTE_IMPORT_QUEUE_JOB_MISSING
REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED
REMOTE_IMPORT_QUEUE_STATE_INCONSISTENT
REMOTE_IMPORT_WORKER_STALLED
REMOTE_IMPORT_WORKER_UNAVAILABLE
REMOTE_IMPORT_RETRY_START_TIMEOUT
```

Use naming conventions already present in the project.

---

# 38. Worker heartbeat

While an import is actively processing, update a lightweight heartbeat.

Do not write continuously.

Recommended:

```text
every 15–30 seconds
```

or reuse existing progress writes.

If meaningful progress is already persisted frequently, `lastProgressAt` may
serve as the heartbeat for those stages.

However, FFmpeg may run for a while without byte-based progress changes, so make
sure an active conversion still has liveness evidence.

The UI may show:

```text
Retrying conversion · active
```

Do not expose worker IDs or internal infrastructure details to normal users.

---

# 39. Failed retry must become visibly failed

If the worker begins a retry and FFmpeg immediately fails, the item must change:

```text
queued
→ processing/remuxing
→ failed
```

It must not return to or remain:

```text
queued
```

Persist:

- Error code.
- Safe error message.
- Failure stage.
- Failed time.
- Attempt number.
- Last known progress.

The Retry button must appear again only when the failure is retryable.

---

# 40. Retry button behavior

Prevent accidental duplicate retries.

When the retry request is in flight:

- Disable the Retry button.
- Show a loading state.

Once retry is successfully queued:

- Hide/disable Retry while status is queued/processing.

Do not allow:

```text
Retry
Retry
Retry
Retry
```

to create four simultaneous executions.

Backend idempotency is mandatory even if the frontend button is disabled.

If a retry is already queued or active, return a stable conflict response such
as:

```text
REMOTE_IMPORT_ALREADY_ACTIVE
```

or the repository's equivalent.

---

# 41. Retry enqueue idempotency

Protect against double requests, browser retries, or network retries.

When two retry requests arrive concurrently:

- Only one new execution attempt should be created.
- Only one BullMQ job should be enqueued.
- The attempt number must not increment twice.
- The second request should return the existing active retry or an explicit
  conflict according to existing API conventions.

Use a database transaction, compare-and-set update, row lock, unique execution
ID, or another repository-consistent concurrency mechanism.

Do not depend only on frontend behavior.

---

# 42. Queue health visibility

Add a safe health signal for the Remote Import subsystem.

If an existing health endpoint exists, extend it carefully.

Conceptual internal status:

```json
{
  "remoteImportQueue": {
    "redis": "ok",
    "worker": "ok"
  }
}
```

Do not expose sensitive Redis details.

At minimum, log on worker startup:

```text
remote-import worker started
queue=<safe queue name>
concurrency=<n>
```

and on graceful shutdown.

If the backend can enqueue but no worker heartbeat has been seen for a defined
period, the UI may show a generic message such as:

```text
Remote Import worker is temporarily unavailable.
```

Do not expose Docker/container internals to normal users.

---

# 43. Retry API response

After a successful retry request, return enough safe state for immediate UI
update.

Conceptual response:

```json
{
  "data": {
    "id": "remote-import-id",
    "status": "queued",
    "stage": "waiting",
    "attempt": 2,
    "queuedAt": "2026-08-08T05:00:00.000Z",
    "retryFromStage": "remuxing"
  }
}
```

Do not expose raw BullMQ internals unless already part of admin/debug APIs.

The frontend should update optimistically only after the API confirms the retry
was successfully enqueued.

---

# 44. Retry queue tests

Add automated tests for the exact regression.

## API / service tests

1. Failed HLS remux can be retried.
2. Retry creates a new attempt.
3. Retry uses a new unique queue job ID.
4. Old failed BullMQ job does not block the new job.
5. Queue add failure does not leave the DB status as queued.
6. Duplicate retry requests create only one execution.
7. Retry is rejected when the import is already queued.
8. Retry is rejected when the import is already processing.
9. Retry preserves canonical filename.
10. Retry preserves destination folder/account selection.
11. Retry determines the correct server-side resume stage.

## Worker tests

1. Retry job changes queued → processing immediately when picked up.
2. HLS conversion retry starts at remuxing when local materialization is valid.
3. Failed retry changes processing → failed.
4. Successful retry continues to uploading.
5. Upload progress is shown after retry.
6. Successful retry reaches completed.
7. Retry does not duplicate provider objects.
8. Retry does not duplicate 9Drive File records.
9. Cancellation flag from a previous execution does not poison the retry.
10. Stale local state is detected safely.

## Queue-state reconciliation tests

Simulate:

```text
DB queued + BullMQ job missing
```

Expected:

```text
failed / QUEUE_JOB_MISSING
```

Simulate:

```text
DB queued + BullMQ job active
```

Expected:

```text
processing
```

Simulate:

```text
DB queued + BullMQ job failed
```

Expected:

```text
failed
```

Simulate:

```text
DB queued + BullMQ job waiting
```

Expected:

```text
remain queued
```

Simulate:

```text
DB queued + BullMQ job delayed
```

Expected:

```text
remain queued with appropriate waiting state
```

Simulate:

```text
BullMQ stalled beyond allowed retries
```

Expected:

```text
failed with stable stalled-worker error
```

---

# 45. Frontend retry tests

Add/update frontend tests.

Test a failed conversion card:

```text
status = failed
stage = remuxing
```

After Retry API succeeds:

```text
Queued for conversion retry
Attempt 2
```

must be visible.

When polling/realtime reports:

```text
status = processing
stage = remuxing
```

render:

```text
Retrying conversion
Attempt 2
```

and a progress indicator.

When the retry fails:

```text
Conversion retry failed
```

must be visible with the Retry action restored when retryable.

When the retry reaches upload:

```text
Uploading to Google Drive
```

and upload progress must be visible.

Also test:

- Retry button disabled while request is pending.
- Retry button absent/disabled while queued.
- Retry button absent/disabled while processing.
- Page refresh preserves queued attempt information.
- Page refresh preserves active retry information.
- Long error text does not overflow.
- Canonical filename remains unchanged through retry.

---

# 46. Manual regression procedure for the stuck retry bug

Reproduce a controlled FFmpeg conversion failure.

Example flow:

```text
HLS download completes
→ remux intentionally fails
→ Remote Import becomes failed
```

Click Retry.

Verify immediately:

```text
Queued for conversion retry
Attempt 2
```

Inspect queue state using supported BullMQ/application debugging tools.

Verify a NEW queue execution exists.

Verify the worker receives it.

The UI must then transition without manual refresh:

```text
Queued for conversion retry
→ Retrying conversion
→ Uploading to Google Drive
→ Completed
```

For an intentionally repeated remux failure:

```text
Queued for conversion retry
→ Retrying conversion
→ Conversion retry failed
```

It must NEVER remain permanently as:

```text
Queued
```

without a valid underlying waiting/delayed queue job.

Then test worker-unavailable behavior:

1. Stop the remote-import worker.
2. Retry a failed job.
3. Confirm it is genuinely queued in BullMQ.
4. UI shows waiting state.
5. Start the worker.
6. Confirm it becomes processing automatically.
7. Confirm no second Retry click is necessary.

Then test enqueue failure:

1. Make Redis/queue unavailable in a controlled test.
2. Click Retry.
3. API must report failure.
4. Database must NOT remain `queued`.
5. UI must show a retry-enqueue error and allow retry again.

---

# 47. Additional acceptance criteria for retry lifecycle

Do not consider this refactor complete until all of the following pass:

- Clicking Retry on a failed HLS conversion creates a real new queue execution.
- A retry cannot be blocked by reuse of an old BullMQ job ID.
- Queue enqueue failure never leaves the Remote Import stuck as queued.
- The UI shows `Queued for conversion retry` before worker start.
- The UI shows `Retrying conversion` after worker start.
- Attempt number is visible or otherwise clearly tracked.
- A failed retry becomes visibly failed.
- A successful retry reaches upload.
- Upload progress is visible during the retried upload.
- Canonical filename is unchanged during retry.
- Duplicate Retry clicks do not create duplicate executions.
- Stalled/missing queue jobs are detected and reconciled.
- Worker restart does not permanently strand retry jobs.
- Page refresh does not lose retry state.
- Direct-file retry behavior still works.
- Existing normal first-attempt Remote Import behavior still works.

