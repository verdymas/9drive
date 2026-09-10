# Workflow: Telegram Reconciliation

```mermaid
flowchart TD
  Scheduler[Periodic scheduler or manual POST] --> Q[telegram-sync queue]
  Q --> W[Worker in API process]
  W --> Scan[Iterate channel messages]
  Scan --> Parse[Parse 9drive:id/path caption]
  Parse --> Compare[Compare with logical DB]
  Compare --> Match[Matched/update metadata]
  Compare --> Issue[Create non-destructive issue]
  Match --> State[Finalize run/state]
  Issue --> State
```

## Initial/Incremental
`TelegramSyncState.lastMessageId` acts as the pagination/incremental cursor. The scheduler enqueues accounts when they are due based on the last scan time and configured interval.

## Conflict Handling
Orphan, missing, and metadata-mismatch conditions are recorded as `TelegramSyncIssue`. Resolution sets `resolvedAt`; do not physically delete issue history as the default behavior.

## Concurrency
`status='syncing'` acts as a single-flight guard. Rate-limit/FloodWait handling must remain bounded and retry-aware.
