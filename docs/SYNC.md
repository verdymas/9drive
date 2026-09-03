# Multi-Storage Sync (Provider → Virtual)

The sync engine turns physical files and folders living on connected storage
accounts (Google Drive `9drive` folder, S3 prefixes) into ONE virtual
filesystem per user.

Telegram storage has its own dedicated sync engine — see
`docs/implementation/telegram-drive.md` (`Telegram Synchronization`
section). The Provider → Virtual engine intentionally treats Telegram
as a no-op because Telegram is flat blob storage with no physical
folder hierarchy to mirror; the dedicated engine handles Telegram's
caption-driven identity, logical-path reconciliation, and
orphan/missing-remote issue tracking.

## Model

- **Virtual `Folder`** — the single user-facing node (`userId`, `parentId`,
  `name`). It has **0..n physical homes**.
- **`FolderStorageLocation`** — one physical mirror per connected account
  (`folderId` + `connectedAccountId`, unique together). Sync A finds
  `9drive/Mov` on account A; Sync B finds `9drive/Mov` on account B; both map to
  THE SAME virtual `Mov` folder via two location rows.
- **`SyncRun`** — one persisted run row per account (status, started/completed,
  scalar stats).
- **`lastSeenSyncRunId`** — stamped on Files and location rows during a scan.
  Cleanup only ever touch rows NOT stamped by the current run (and never rows
  without a stamp — legacy data is safe on the first post-upgrade run).

## Identity rules (the whole design rests on these)

| Entity              | Identity                                    | Never                     |
| ------------------- | ------------------------------------------- | ------------------------- |
| Virtual folder      | `(userId, virtualParentId, normalizedName)` | the name alone            |
| Physical folder     | `(connectedAccountId, providerFolderId)`    | a filename                |
| File                | `(connectedAccountId, providerFileId)`      | a filename                |

`normalizedName` = `NFC → trim → lowercase`. User-created folders keep
`normalizedName = NULL` (MySQL allows many NULLs in a unique index — no
constraint). Sync-created folders always carry a normalized name and the
`@@unique([userId, parentId, normalizedName])` constraint rejects ambiguous
duplicates.

## Reconciliation algorithm

`resolveVirtualFolder(ctx, virtualParentId, physical)` — two levels:

1. **Physical identity** — `location(connectedAccountId, providerFolderId)`.
   Consistent (same virtual parent + same normalized name)? → stamp
   `lastSeenSyncRunId`, reuse. Diverged (provider renamed/moved it)? → DETACH
   the location row and re-resolve (never rename a shared virtual folder).
   Exception: single-location sync-originated folder may update in place when
   the new name does not collide (§28).
2. **Logical identity** — find existing virtual children under the resolved
   virtual parent by `normalizedName` (legacy NULL rows matched by
   `normalize(name)`). Found → attach a new location row (merge). Not found →
   create the virtual folder + first location in ONE transaction; on P2002
   (concurrent run won the same path) re-read the winner and attach instead.

Same-account duplicate folder names get a deterministic ` (2)`, ` (3)` suffix
— never dropped, never merged.

## Missing reconciliation (account-scoped, success-only)

Only after a **complete successful scan** of an account:

- Files: soft-delete active rows `lastSeenSyncRunId NOT IN [this run]` (+ not
  NULL) → `filesMissing`.
- Locations: delete the stale mapping rows (never the Virtual folder; B's rows
  are untouched by A's run) → `mappingsMissing`.

Failed, cancelled, or partial scans **never** run this pass (§22/§60).

## Provider interactions (READ-ONLY)

Sync only ever calls provider READs (`files.list` on Drive, `ListObjectsV2` on
S3). It never creates/renames/moves/deletes provider folders to mirror the
virtual tree — those happen only through upload materialization and explicit
user folder actions. See `sync-boundary.test.ts` (§70).

S3 has no folders: prefixes derived from `buildObjectKey`
(`{root}/{folderPath}/{userId}/{fileId}/{safeName}`). A prefix IS the provider
folder id — S3 cannot see provider-side renames, only the missing reconciler
does (honest by construction).

## Drive scan (BFS)

Iterative queue + depth cap (`SYNC_MAX_DEPTH` default 40), visited set, one
page of 1000 at a time. `callWithRetries` exponential backoff on 429/5xx/
network errors.

## API

```txt
POST  /sync/all                 Sync ALL connected accounts (bounded concurrency)
POST  /sync/account/:id        Sync one account
POST  /sync/account/:id/cancel  Cancel an in-flight sync (never cleans up)
GET   /sync/runs?limit=50       Recent run history
POST  /files/sync-google       Legacy alias → { status:'ok', results:[...] }
```

`POST /sync/all` returns per-account results — one account's failure never
rolls back another's valid rows:

```jsonc
{
  "status": "ok",
  "results": [{
    "accountId": "...", "provider": "google_drive",
    "status": "completed", "runId": "...",
    "stats": { "filesCreated": 3, "filesUpdated": 0, "filesMoved": 0, "filesMissing": 1, "mappingsMissing": 0 }
  }]
}
```

## Configuration (env)

| Variable                     | Default | Meaning                          |
| ---------------------------- | ------- | ------------------------------- |
| `SYNC_ACCOUNT_CONCURRENCY`   | 2       | Accounts running in parallel     |
| `SYNC_FOLDER_LIST_CONCURRENCY` | 2     | Provider list calls in parallel  |
| `SYNC_MAX_DEPTH`             | 40      | Max virtual folder depth        |
| `SYNC_DRIVE_MAX_RETRIES`     | 3       | Retries for transient provider errors |

## Concurrency & race safety

- Per-account runs are independent (no cross-account transaction).
- Two Sync All calls racing onto the same virtual path: the
  `@@unique([userId,parentId,normalizedName])` constraint + P2002 re-read
  loop makes the second one attach to the winner instead of duplicating.
- `(folderId, connectedAccountId)` unique guards duplicate locations.
- Missing-reconcile is account-scoped — Sync A can never delete B's rows.

## Run status / error codes

`running → completed | failed | cancelled`. Stats are committed with the
`completed` update. Error codes:
`SYNC_ACCOUNT_UNAVAILABLE`, `SYNC_PROVIDER_LIST_FAILED`,
`SYNC_PROVIDER_RATE_LIMITED`, `SYNC_PROVIDER_ACCESS_DENIED`,
`SYNC_PROVIDER_NOT_FOUND`, `SYNC_RECONCILIATION_FAILED`,
`SYNC_CANCELLED`, `SYNC_PARTIAL_SCAN`, `SYNC_VIRTUAL_FOLDER_CONFLICT`.