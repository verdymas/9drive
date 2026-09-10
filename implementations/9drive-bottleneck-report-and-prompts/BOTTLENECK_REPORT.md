# 9Drive Bottleneck Report

**Assessment type:** Static source-code analysis  
**Project:** 9Drive  
**Primary goal:** Remove scalability and reliability bottlenecks without reducing functionality.

---

## Executive Summary

The most important constraints in the current 9Drive architecture are not basic database capacity or Redis throughput. The highest-risk bottlenecks are in the file data path, temporary-storage lifecycle, reconciliation write patterns, and metadata-heavy access paths.

### Priority Matrix

| ID | Bottleneck | Current Risk | Primary Resource | Priority |
|---|---|---|---|---|
| B1 | Multipart upload buffers entire files in memory | OOM / process instability | RAM | P0 |
| B2 | Backend proxies most file bytes | Throughput ceiling / connection pressure | Network + sockets | P1 |
| B3 | Remote Import / HLS depends heavily on temp disk and FFmpeg | Disk exhaustion / I/O contention / CPU contention | Disk + CPU + network | P1 |
| B4 | Sync reconciliation performs per-row writes | Slow large-account syncs / DB write amplification | MySQL IOPS | P2 |
| B5 | Telegram sync is too serial and loads account-wide state | Long sync duration / growing memory footprint | Latency + RAM + Telegram API | P2 |
| B6 | WebDAV path resolution loads directory children then scans in memory | Slow Jellyfin/rclone metadata operations | DB + application CPU/RAM | P2 |
| B7 | Several modules are oversized and highly coupled | Slow development / high agent context cost / regression risk | Engineering throughput | P3 |

### Recommended Order

1. B1 — fix multipart upload memory behavior.
2. B3 — add resource-aware Remote Import/HLS scheduling and isolation.
3. B4 + B5 + B6 — optimize reconciliation and metadata paths.
4. B2 — introduce direct S3 fast paths and stronger media-plane isolation.
5. B7 — perform structural decomposition after runtime behavior is stabilized.

B7 should generally be last because large refactors performed before runtime fixes increase merge conflicts and make regression diagnosis harder.

---

# B1 — Multipart Upload Memory Amplification

## Current Evidence

Primary file:

`backend/src/modules/uploads/upload.routes.ts`

The multipart path currently accumulates every incoming file chunk:

```ts
const chunks: Buffer[] = []

fileStream.on('data', (chunk: Buffer) => {
  chunks.push(chunk)
})

const fileBuffer = Buffer.concat(chunks)
```

The same route allows:

- up to 25 multipart files;
- a per-file limit controlled by `MAX_UPLOAD_BYTES`;
- multiple `uploadOne(...)` promises collected in `pendingUploads`.

The dashboard resumable flow is materially safer because it uses chunked resumable requests. The critical risk is the multipart API path, not the normal dashboard resumable upload path.

## Why It Is a Bottleneck

Memory consumption grows with uploaded file size. `Buffer.concat()` also allocates a final contiguous buffer, so peak process memory may exceed the payload already held in chunk buffers.

Large or concurrent multipart uploads can therefore:

- trigger Node.js process OOM;
- cause aggressive garbage collection;
- affect unrelated API requests;
- make the configured maximum file size practically unsafe.

## Target Architecture

```text
Multipart request
      |
    Busboy
      |
      +--> S3: bounded stream / provider upload
      |
      +--> Google: bounded stream or resumable provider stream
      |
      +--> Telegram: bounded temp spool -> Telegram file upload
```

When routing metadata is not available early enough to stream directly, use a bounded temporary spool rather than RAM.

## Solution

1. Extract multipart request processing into a small service boundary.
2. Remove the `Buffer[]` / `Buffer.concat()` path.
3. Count streamed bytes while data flows through a `Transform` or equivalent bounded stream.
4. Use provider-native streaming where safe.
5. Keep temp-file fallback for providers or flows that require a file path.
6. Guarantee cleanup on success, failure, request abort, provider failure, and size mismatch.
7. Preserve `POST /api/v1/uploads`, automatic placement, batch response semantics, quotas, upload sessions, and current provider support.

## Validation Targets

- Process memory must not grow linearly with uploaded file size.
- Declared-size mismatch behavior must still be enforced.
- Client disconnect must stop downstream work and remove temporary files.
- S3, Google Drive, and Telegram multipart uploads must still work.
- Existing resumable upload behavior must remain unchanged.
- Large-file tests should use generated streams rather than constructing equivalent-size buffers.

---

# B2 — Backend as a Centralized File Data Plane

## Current Evidence

Provider streaming is centralized through:

- `backend/src/modules/files/stream-file.ts`
- `backend/src/modules/files/stream-google-file.ts`
- `backend/src/modules/s3/s3.service.ts`
- Telegram streaming services
- WebDAV virtual filesystem streaming

S3 downloads currently use `GetObjectCommand` and then pipe the object through the 9Drive process:

```text
S3 -> 9Drive backend -> client
```

Google and Telegram similarly require server-side provider access for many flows.

## Why It Is a Bottleneck

For Jellyfin, WebDAV, rclone, previews, downloads, and concurrent media clients, the backend becomes a bandwidth and socket concentrator.

Even when the backend does not buffer the entire file, it still consumes:

- inbound provider bandwidth;
- outbound client bandwidth;
- open sockets;
- Node stream bookkeeping;
- provider connections.

This can make ordinary API operations share failure modes with heavy media traffic.

## Target Architecture

Use a hybrid data plane:

```text
                9Drive API
              auth / metadata
                    |
      +-------------+-------------+
      |                           |
Direct-capable provider       Proxy-required
      |                           |
      v                           v
     S3                     Google / Telegram
      |                           |
      +-------> client <----------+
```

A provider direct path must be optional and must always have a secure proxy fallback.

## Solution

1. Harden proxy streaming first: backpressure, abort propagation, consistent range/header behavior.
2. Introduce a download-delivery decision layer so routes do not care whether delivery is proxy or redirect/signed URL.
3. Add short-lived presigned S3 downloads where semantics allow it.
4. Preserve proxy delivery for WebDAV and other clients that require stable server-side range semantics.
5. Add optional direct S3 multipart upload as a fast path while preserving current resumable APIs.
6. Optionally isolate high-throughput media endpoints into a dedicated process/service behind the same public URL.

## Validation Targets

- Authorization is checked before any signed URL is generated.
- Signed URLs are short-lived and scoped to one object.
- WebDAV and Jellyfin range playback remain compatible.
- Existing preview/public share semantics remain unchanged unless explicitly routed through the new abstraction.
- Client aborts cancel upstream provider work where possible.
- API responsiveness is measurable under concurrent media load.

---

# B3 — Remote Import / HLS Temp-Disk and FFmpeg Pressure

## Current Evidence

Relevant files include:

- `backend/src/modules/remote-imports/processor.ts`
- `backend/src/modules/remote-imports/temp-storage.ts`
- `backend/src/modules/remote-imports/worker.ts`
- `backend/src/modules/remote-imports/queue.ts`
- `backend/src/modules/remote-imports/hls/*`

Configuration includes:

- `REMOTE_IMPORT_GLOBAL_CONCURRENCY`
- `REMOTE_IMPORT_PER_USER_CONCURRENCY`
- `REMOTE_IMPORT_HLS_SEGMENT_CONCURRENCY`
- `REMOTE_IMPORT_TEMP_DIR`
- `REMOTE_IMPORT_TEMP_RETENTION_HOURS`
- FFmpeg and FFprobe configuration

Direct imports materialize temporary data before provider upload. HLS additionally manages segment downloads and FFmpeg output, making disk and CPU consumption substantially different from ordinary URL imports.

## Why It Is a Bottleneck

A large import can consume file-size-equivalent disk. HLS can temporarily consume more than final output size because segments, playlists, and remux/re-encode output may coexist.

Concurrent jobs can contend for:

- free disk space;
- read/write IOPS;
- outbound and inbound network;
- FFmpeg CPU;
- file descriptors.

Queue concurrency alone does not represent real resource availability.

## Target Architecture

```text
Queue
 |
 +--> Direct-import workers ---- network-heavy
 |
 +--> HLS workers ------------- CPU/disk-heavy
          |
          +--> global segment semaphore
          +--> disk reservation
```

Longer term, range-capable remote sources and stream-capable providers can use stream-through transfer to avoid full temp materialization.

## Solution

1. Add disk/resource observability and a configurable safety reserve.
2. Introduce admission control: jobs wait for resources rather than starting and failing because disk becomes full.
3. Separate direct-download concurrency from HLS/FFmpeg concurrency.
4. Add a global cap on HLS segment activity, not only a per-job cap.
5. Preserve current retry and resumability semantics.
6. Introduce stream-through direct import only for combinations that can resume safely; retain temp-spool fallback for all others.

## Validation Targets

- No new import begins when doing so would violate the configured disk safety reserve.
- Resource-starved jobs remain recoverable and do not become false failures.
- HLS and direct imports can use different concurrency budgets.
- Existing HLS retry/remux/re-encode behavior remains available.
- Temp cleanup remains correct across retry, cancel, success, and failure.
- Stream-through is opt-in by eligibility and can fall back to current temp-spool behavior.

---

# B4 — Sync Reconciliation Database Write Amplification

## Current Evidence

Primary file:

`backend/src/modules/sync/file-reconciler.ts`

The code already performs a page-scoped `findMany` by provider IDs, which avoids one read query per physical file.

However, reconciliation still iterates the physical files and performs row-level create/update operations. Unchanged rows may still receive an update only to stamp:

`lastSeenSyncRunId`

The Prisma `File` model already has useful indexes including:

- `connectedAccountId`
- `providerFileId`
- `(connectedAccountId, status, lastSeenSyncRunId)`

## Why It Is a Bottleneck

For a complete scan of a large provider account, unchanged files dominate. If every unchanged object generates its own SQL update, MySQL write count grows approximately with total file count, not with actual change count.

This causes:

- longer sync runs;
- more transaction/redo log activity;
- higher storage IOPS;
- larger contention window with normal user actions.

## Target Architecture

Per provider page:

```text
physical page
    |
single findMany
    |
 classify
 +--+---------+
 |            |
new/changed   unchanged
 |            |
batched or    one updateMany
bounded write     per page
```

## Solution

1. Instrument current reconciliation counts and query behavior.
2. Classify page results before writing.
3. Stamp unchanged rows with one `updateMany` per page where semantics allow.
4. Use `createMany` only if no required returned IDs or side effects are lost; otherwise use safe bounded transactional writes.
5. Keep changed rows explicit when per-row semantic logic is required.
6. Evaluate and, only if the invariant is confirmed, enforce physical identity uniqueness for `(connectedAccountId, providerFileId)` after duplicate migration analysis.

## Validation Targets

- Existing rename/move/restore/missing semantics remain identical.
- Unchanged pages no longer require one update statement per file.
- Sync tests remain deterministic.
- A full sync remains safe while user-created logical state changes concurrently.
- Schema changes include duplicate preflight and rollback strategy.

---

# B5 — Telegram Sync Serialization and Account-Wide Memory Loading

## Current Evidence

Relevant files:

- `backend/src/modules/telegram/telegram-sync.worker.ts`
- `backend/src/modules/telegram/telegram-sync.service.ts`
- queue/scheduler modules

The worker currently declares:

```ts
concurrency: 1
```

The service loads existing Telegram-backed `File` rows for the account with `findMany`, builds account-wide in-memory maps, then processes pages/documents largely serially.

Telegram-specific rate limits and FloodWait behavior make uncontrolled parallelism unsafe, but global serialization unnecessarily blocks independent accounts.

## Why It Is a Bottleneck

As channel/account size grows:

- initial DB data loaded into RAM grows with total indexed files;
- sync latency grows with every Telegram item;
- one slow account can delay another;
- caption/API calls can dominate runtime.

## Target Architecture

```text
Worker pool
 +--> Account A sync (single-flight)
 +--> Account B sync (single-flight)
 +--> Account C sync (single-flight)

Within an account:
 page -> page-scoped DB lookup -> bounded classification/caption work
```

## Solution

1. Apply configurable concurrency at the account/job level.
2. Enforce at most one active sync per connected Telegram account.
3. Replace account-wide file preload with page-scoped lookups based on the current Telegram page identifiers.
4. Preserve `lastSeenSyncRunId` / missing reconciliation semantics.
5. Avoid expensive caption resolution for already unambiguous matches.
6. Use low bounded concurrency for caption/network operations and continue respecting FloodWait.

## Validation Targets

- Two independent accounts can progress concurrently.
- One account cannot run two destructive/full reconciliation jobs simultaneously.
- Peak memory is related to page size rather than total account size.
- FloodWait retry behavior remains correct.
- Stable Telegram logical identity and caption reconciliation remain correct.

---

# B6 — WebDAV Metadata and Path-Resolution Cost

## Current Evidence

Primary file:

`backend/src/modules/webdav/webdav-virtual-fs.ts`

`VirtualFsCache` caches directory contents per request, but path resolution currently loads all children then searches in JavaScript:

```ts
const folders = await this.cache.foldersUnder(parentId)
const folder = folders.find((candidate) => candidate.name === segment)
```

For the final segment it similarly loads folders, then files, then uses `.find(...)`.

`filesUnder()` also includes the entire `connectedAccount` relation even when the operation only needs WebDAV metadata.

## Why It Is a Bottleneck

Jellyfin and rclone are metadata-heavy clients. They can generate many PROPFIND/HEAD/path-resolution operations before or during streaming.

Large directories therefore cause unnecessary:

- MySQL row transfer;
- Prisma object creation;
- application memory use;
- JS scanning;
- credential/account relation hydration.

## Target Architecture

Separate:

1. exact child lookup for path resolution;
2. directory listing for PROPFIND;
3. full provider-account loading only when a file is actually streamed.

## Solution

1. Add exact child-folder and child-file lookup methods.
2. Use database predicates on parent/folder + name + active/deleted state.
3. Add or adjust composite indexes based on actual query shape.
4. Slim directory-list projections to metadata required by WebDAV.
5. Load `connectedAccount` lazily for actual streaming.
6. Add a short-lived path/metadata cache after query behavior is correct; use an invalidation or very short TTL strategy compatible with writes.

## Validation Targets

- Deep path resolution does not load all siblings at each level.
- PROPFIND still returns the same visible tree and metadata.
- Range streaming remains unchanged.
- Telegram/Google/S3 WebDAV playback still works.
- Cache cannot expose another user's data.
- Renames/moves become visible within the documented cache window.

---

# B7 — Oversized Modules and Engineering Throughput

## Current Evidence

Large/high-responsibility files include, among others:

- `backend/src/modules/remote-fetch-workers/drivers/cloudflare.ts`
- `backend/src/modules/remote-imports/processor.ts`
- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/modules/telegram/telegram-sync.service.ts`
- `backend/src/modules/telegram/telegram.service.ts`
- `frontend/src/pages/AllFilesPage.tsx`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/components/drive/RemoteImportModal.tsx`
- `frontend/src/layouts/DriveLayout.tsx`

The issue is not line count by itself. These files combine orchestration, provider-specific behavior, state transitions, side effects, and presentation concerns.

## Why It Is a Bottleneck

Large coupled files increase:

- regression surface;
- merge conflicts;
- code-review difficulty;
- AI-agent context requirements;
- probability that unrelated changes touch the same file.

## Target Architecture

Use incremental extraction while keeping public entry points stable.

Example:

```text
remote-imports/
  processor.ts            # orchestration
  phases/
    probe.ts
    download.ts
    placement.ts
    upload.ts
    finalize.ts
  providers/
    google.ts
    s3.ts
    telegram.ts
```

## Solution

1. Do not perform a rewrite.
2. Establish tests around current contracts first.
3. Extract pure helpers and provider-specific adapters.
4. Keep exported functions/routes/components stable until callers have migrated.
5. Decompose frontend state into hooks and focused components without changing UX.
6. Perform these changes after runtime optimization phases so refactors do not create unnecessary conflicts.

## Validation Targets

- Public route contracts remain unchanged.
- Existing test behavior stays green.
- Each extracted unit has a clear responsibility.
- No temporary compatibility layer becomes permanent without documentation.
- Agent tasks should be able to modify one concern without loading unrelated provider/UI code.

---

# Cross-Cutting Recommendations

## 1. Measure Before and After

At minimum track:

- Node RSS / heap during large uploads;
- active upload count;
- open media streams;
- direct-vs-proxy delivery count;
- temp-disk free/reserved bytes;
- active FFmpeg processes;
- Remote Import queue wait and execution time;
- sync objects scanned / created / changed / unchanged;
- DB write count or sync SQL duration;
- Telegram page and caption-request counts;
- WebDAV path lookup/query latency.

## 2. Preserve Fallbacks

Every optimization that introduces a faster path must preserve a proven fallback:

```text
fast path eligible?
  yes -> optimized path
  no  -> existing compatible path
```

This is particularly important for:

- S3 signed delivery;
- stream-through remote import;
- provider-native multipart streaming;
- metadata caching.

## 3. Avoid Concurrent Structural Refactors

Do not decompose `upload.routes.ts` while another agent is simultaneously changing its multipart runtime behavior. Likewise, do not decompose `processor.ts` while Remote Import scheduling changes are in progress.

Finish behavioral phases first, then extract structure.

## 4. Keep Documentation Synchronized

After each phase, update the relevant files under `docs/` and especially architecture/workflow/reference documentation when contracts, environment variables, queues, processes, or database schema change.

---

# Expected End State

The recommended end state keeps 9Drive feature-complete but changes its resource behavior:

```text
Large uploads:
  O(file size) RAM       -> bounded RAM / spool / stream

S3 delivery:
  backend byte proxy     -> direct when safe, proxy fallback

Remote Import:
  queue concurrency only -> resource-aware scheduling

Sync:
  row-by-row writes      -> page-oriented batched writes

Telegram:
  globally serial        -> account-concurrent, account-single-flight

WebDAV:
  load siblings + .find  -> exact indexed lookup

Codebase:
  god files              -> stable orchestration + focused modules
```

The objective is not maximum theoretical throughput. It is predictable resource use, graceful degradation, and maintainable behavior across the same complete 9Drive feature set.
