# Domain: Telegram Synchronization

## Ownership Model
The 9Drive database is the logical source of truth; the Telegram channel is the physical mirror/storage layer.

## Metadata Identity
Outbound Telegram documents can carry captions containing:

```text
9drive:id=<stable-id>
9drive:path=<logical/path/file.ext>
```

- `stableId` is not the Telegram message ID.
- `logicalPath` is logical metadata and is validated segment by segment.
- `.`/`..`, control characters, and reserved path characters are rejected.
- Additional user caption text is preserved when it still fits within Telegram caption limits.

## Sync State
`TelegramSyncState.status`:

- `never_synced`
- `syncing`
- `up_to_date`
- `changes_detected`
- `needs_attention`
- `sync_failed`

## Issue Types

- `ORPHAN_REMOTE_FILE`
- `REMOTE_FILE_MISSING`
- `TELEGRAM_METADATA_MISMATCH`

## Safety Invariant
Synchronization is non-destructive. Issues are resolved through `resolvedAt`; never automatically delete or re-upload files merely to make both sides appear identical.

## Page-Scoped Reconciliation and Memory Limits
- Sync memory scales with `TELEGRAM_SYNC_PAGE_SIZE` rather than total channel message count.
- The database is queried page-locally via `providerFileId IN (...)` for each Telegram page.
- Observed rows are stamped with `lastSeenSyncRunId = <runId>`.
- Missing-file detection runs generation-based queries (`lastSeenSyncRunId != runId` or `null`) during complete full scans instead of maintaining full account snapshots in RAM.

## Concurrency and Single Flight
- BullMQ worker concurrency is configured by `TELEGRAM_SYNC_CONCURRENCY` (default `2`, allowed range `1`–`8`).
- Independent connected accounts execute concurrently across available worker slots.
- Per-account single-flight safety is enforced by the database-backed `TelegramSyncState.status` transition (`status='syncing'`).
- Lock release occurs in all completion, error, cancellation, and exception paths. FloodWait delays stay local to the affected account job.
