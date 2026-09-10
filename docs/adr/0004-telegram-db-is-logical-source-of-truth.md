# ADR 0004: 9Drive DB Is the Logical Source of Truth for Telegram Storage

## Status
Accepted

## Decision
For Telegram storage, the 9Drive database is the authoritative logical filesystem. A private Telegram channel acts as the physical blob mirror.

Logical metadata is stored in document captions using these keys:

```text
9drive:id=<stable-id>
9drive:path=<folder/path/filename>
```

`telegramStableId` preserves file identity even if the Telegram message ID changes. Rename and move operations update the caption; the logical path is not derived from Telegram topics.

## Reconciliation Rule
Telegram synchronization is non-destructive. Missing, orphaned, or conflicting entries are recorded as issues for review; synchronization does not automatically delete or re-upload missing data.

## Related Files

- `backend/src/modules/telegram/telegram-metadata.ts`
- `backend/src/modules/telegram/telegram-caption.service.ts`
- `backend/src/modules/telegram/telegram-sync.service.ts`
- `backend/prisma/schema.prisma`
