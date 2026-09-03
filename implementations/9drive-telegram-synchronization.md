# Add Telegram Synchronization / Reconciliation

## Goal

Implement proper synchronization between the configured Telegram Storage Channel and the 9Drive database.

The current Telegram integration supports storing files in a dedicated Telegram storage channel, but synchronization/reconciliation is not fully implemented.

Use `references/teledrive` as a read-only reference where useful. Do not modify it, copy its source code, or add it as a dependency.

## 1. Synchronization Architecture

Create a dedicated synchronization service following the existing 9Drive architecture.

Conceptually:

```text
TelegramSyncService
        |
        +-- scanTelegram()
        +-- compare()
        +-- reconcile()
        +-- cleanup()
```

Do not put synchronization logic directly inside controllers, `TelegramStorageProvider`, file browser, or upload controllers.

## 2. Synchronization Direction

Support both:

```text
Telegram → 9Drive
9Drive → Telegram
```

Telegram → 9Drive is primarily for recovery, reconciliation, externally added files, and detecting missing database records.

9Drive → Telegram is primarily for detecting missing remote files and failed uploads, with re-upload only when explicitly allowed.

Never blindly overwrite files.

## 3. Source of Truth

9Drive remains the source of truth for:

- folders and hierarchy
- filename and virtual path
- ownership and permissions
- file relationships

Telegram is the source of truth for:

- message existence
- message ID
- Telegram file identity
- Telegram file size
- Telegram message metadata

Therefore:

```text
9Drive   = Virtual File System
Telegram = Physical Storage
```

Do not recreate the complete 9Drive folder hierarchy inside Telegram.

## 4. Telegram Scan

Only scan the configured Telegram Storage Channel.

Never scan Saved Messages, personal chats, unrelated groups, or unrelated channels.

Collect metadata only:

```text
channelId
messageId
telegramFileId
filename
mimeType
size
messageDate
fileUniqueId if available
```

Do not download file contents during a synchronization scan.

## 5. Incremental Synchronization

Do not scan the entire channel every time.

Persist synchronization state, conceptually:

```text
telegram_sync_state

provider_id
last_message_id
last_scan_at
status
cursor
error
```

Support:

- Initial Sync
- Incremental Sync
- Full Resync

Use Telegram message IDs/cursors where appropriate.

## 6. Initial Sync

When Telegram Drive is connected for the first time:

```text
Telegram Storage Channel
        ↓
Scan
        ↓
Read metadata
        ↓
Compare with 9Drive DB
        ↓
Create reconciliation candidates
```

Do not automatically place files into arbitrary existing folders.

Unmapped files should go into a dedicated system-managed folder such as `Recovered from Telegram` when imported.

## 7. Existing File Matching

Match using the strongest identity first:

1. Stored Telegram remote ID
2. channelId + messageId
3. provider-specific remote identifier
4. Telegram file unique ID where safe
5. filename + size only as a fallback heuristic

Never assume two files are identical based only on filename.

## 8. Missing Remote File

If a known 9Drive file points to a Telegram message that no longer exists, mark it as:

```text
REMOTE_FILE_MISSING
```

Do not immediately delete the 9Drive record.

Distinguish an actually missing message from a temporary Telegram API/network failure.

## 9. Orphan Telegram File

If a document exists in the configured Telegram Storage Channel but has no matching 9Drive record, mark it:

```text
ORPHAN_REMOTE_FILE
```

Do not silently delete it.

Provide reconciliation actions such as:

```text
Import into 9Drive
Ignore
Delete from Telegram
```

Imported files should use `Recovered from Telegram` unless the user chooses another folder.

## 10. Metadata Conflict

If Telegram metadata differs from 9Drive metadata, do not blindly overwrite.

Create a conflict such as:

```text
TELEGRAM_METADATA_MISMATCH
```

Store both sides and `detectedAt`.

## 11. Deleted 9Drive File

If a 9Drive file was intentionally deleted, the existing delete workflow should remove its Telegram message.

Synchronization must not recreate it merely because the remote message still exists temporarily.

Respect existing deletion state/tombstone mechanisms.

## 12. Upload Failure Recovery

If Telegram upload succeeds but the 9Drive database update fails, the next synchronization must detect the Telegram message as an orphan.

Do not blindly upload the file again.

## 13. Missing Remote Recovery

If the 9Drive record exists but the Telegram message is missing, do not automatically re-upload unless the existing reconciliation policy explicitly allows it.

Possible actions:

```text
Re-upload
Mark missing
Delete local record
Ignore
```

Prefer safe/manual reconciliation over destructive automatic behavior.

## 14. Synchronization Status

Expose provider synchronization state such as:

```text
Never Synced
Syncing
Up to Date
Changes Detected
Needs Attention
Sync Failed
```

Example:

```text
Telegram Drive

Status:
Connected

Synchronization:
Up to date

Last Sync:
3 minutes ago

Files:
1,245

Total Stored Size:
384.6 GB
```

## 15. Synchronization UI

Add:

```text
[ Sync Now ]

Last Sync:
3 minutes ago

Status:
Up to Date
```

If conflicts exist:

```text
3 synchronization issues

[ Review ]
```

Synchronization must not be destructive by default.

## 16. Sync History

Persist synchronization runs, conceptually:

```text
telegram_sync_runs

id
provider_id
started_at
finished_at
status
scanned_count
matched_count
imported_count
missing_count
orphan_count
conflict_count
error_count
last_error
```

Use the existing 9Drive conventions where possible.

## 17. Sync Result

Show useful results:

```text
Telegram Sync Complete

Scanned: 1,250
Matched: 1,245
New Telegram Files: 3
Missing Remote Files: 1
Conflicts: 1
Errors: 0
```

## 18. Background Synchronization

Synchronization must run asynchronously through the existing queue/worker infrastructure.

Do not make a normal HTTP request wait for a full channel scan.

Flow:

```text
User clicks Sync Now
        ↓
Create Sync Job
        ↓
Queue
        ↓
TelegramSyncService
        ↓
Persist progress/state
        ↓
UI reads status
```

## 19. Automatic Sync

If the existing application supports scheduled jobs, allow periodic synchronization using the existing scheduler.

Recommended initial cadence: every 15–30 minutes, configurable.

Do not create a second scheduler system.

## 20. Concurrency Protection

Prevent multiple sync jobs for the same Telegram provider from running simultaneously.

Use existing mechanisms such as unique jobs, provider-level locks, database locks, or distributed locks.

If a sync is already running, return an equivalent of:

```text
SYNC_ALREADY_RUNNING
```

## 21. Rate Limiting

Do not assume unlimited Telegram API calls.

Implement:

- pagination
- bounded concurrency
- retry handling
- FloodWait handling
- exponential backoff where appropriate

Never aggressively scan the channel.

## 22. Large Channel Support

Support thousands, tens of thousands, and potentially hundreds of thousands of messages.

Do not load the entire channel into memory.

Use pagination/cursors, batches, and persisted progress.

## 23. Usage Calculation

Keep the existing Telegram product rule:

Telegram does not expose an assumed quota.

Display only:

```text
File Count
Total Stored Size
```

Do not create or display:

```text
availableSize
freeSpace
remainingQuota
totalCapacity
percentageUsed
```

for Telegram.

## 24. Logging

Use structured logs such as:

```text
[telegram-sync]
providerId=...
runId=...
phase=scan
scanned=...
matched=...
orphan=...
missing=...
conflict=...
```

Never log session strings, API hashes, OTPs, passwords, or authorization secrets.

## 25. Error Handling

Handle Telegram-specific failures such as:

```text
TELEGRAM_FLOOD_WAIT
TELEGRAM_AUTH_REQUIRED
TELEGRAM_CHANNEL_UNAVAILABLE
TELEGRAM_MESSAGE_NOT_FOUND
TELEGRAM_API_ERROR
TELEGRAM_NETWORK_ERROR
```

A temporary Telegram error must never cause all files to be marked missing.

## 26. Reconciliation Rules

Automatically safe:

```text
Known DB file + matching Telegram message
→ mark synchronized
```

```text
Known DB file + unchanged Telegram metadata
→ no action
```

Require reconciliation:

```text
Telegram orphan
→ candidate for import
```

```text
DB file + missing Telegram message
→ candidate for re-upload/recovery
```

```text
Metadata mismatch
→ conflict
```

Never automatically destroy data based only on a synchronization discrepancy.

## 27. Testing

Create automated tests for:

### Initial Sync

Telegram channel with 10 files and an empty 9Drive database must produce 10 reconciliation/import candidates.

### Incremental Sync

Existing 10 files plus 2 new Telegram files must process only the new messages.

### Orphan Detection

Telegram file exists but 9Drive record is absent → `ORPHAN_REMOTE_FILE`.

### Missing Remote

9Drive record exists but Telegram message is deleted → `REMOTE_FILE_MISSING`.

### Matching

Stored channelId + messageId → exact match.

### Temporary API Failure

Telegram API unavailable → retryable sync failure; existing files must NOT be marked missing.

### FloodWait

Respect `retry_after`; do not hammer the API.

### Large Channel

Verify pagination, batch processing, memory usage, and resume capability.

## 28. Documentation

Update:

```text
docs/implementation/telegram-drive.md
```

Add a `Telegram Synchronization` section covering:

- architecture
- source of truth
- initial sync
- incremental sync
- orphan handling
- missing remote handling
- conflict handling
- retry behavior
- automatic sync
- manual sync
- usage calculation

# Required Execution Workflow

## Step 1 — Plan

Inspect the existing Telegram implementation first.

Identify:

- current provider model
- current Telegram channel model
- existing queue infrastructure
- existing scheduled jobs
- existing file state model
- existing reconciliation mechanisms

Then create an implementation plan. Do not immediately modify code.

## Step 2 — Implement

Implement synchronization using existing 9Drive abstractions.

Do not create duplicate queue, scheduler, or storage systems.

## Step 3 — Test

Run:

- backend tests
- integration tests
- queue tests
- database tests
- type checks
- lint

Do not use Playwright unless an existing compatible setup specifically requires it.

## Step 4 — Report

Document implementation and test results in:

```text
docs/implementation/telegram-drive.md
```

# Final Acceptance Criteria

Complete when:

1. Telegram storage can be synchronized with 9Drive.
2. Only the configured storage channel is scanned.
3. Initial and incremental synchronization are supported.
4. Synchronization runs asynchronously.
5. Duplicate sync jobs are prevented.
6. Telegram pagination is used for large channels.
7. Telegram API rate limits are respected.
8. Existing 9Drive file identities are matched safely.
9. Orphan Telegram files are detected.
10. Missing Telegram files are detected.
11. Metadata conflicts are detected.
12. Sync does not blindly delete data.
13. Failed Telegram API requests are not interpreted as missing files.
14. Sync state and history are persisted.
15. User can manually trigger synchronization.
16. Automatic synchronization uses the existing scheduler infrastructure when enabled.
17. Telegram usage remains File Count + Total Stored Size only.
18. No artificial Telegram quota is introduced.
19. Remote Import continues working.
20. Existing storage providers remain unaffected.
21. `references/teledrive` remains untouched.
22. No Teledrive source code is copied into production.
23. Documentation and regression tests are included.

IMPORTANT: Before implementation, inspect the actual current 9Drive Telegram provider and adapt this specification to existing abstractions instead of creating parallel architecture.
