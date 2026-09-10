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

## Related Files

- `backend/src/modules/telegram/telegram-sync.service.ts`
- `backend/src/modules/telegram/telegram-sync.scheduler.ts`
- `backend/src/modules/telegram/telegram-sync.worker.ts`
- `backend/src/modules/telegram/telegram-metadata.ts`
