# Phase 05 - Sync Reconciliation

Use PLAN MODE first.

Use:
- `9drive:id` for identity;
- `9drive:path` for logical location.

Rules:
- matching ID means same logical file;
- path change means move/rename;
- missing ID means unlinked Telegram file;
- duplicate ID must be detected;
- Telegram deletion does not delete 9drive files;
- 9drive deletion follows normal application lifecycle.

Handle duplicate messages, stale metadata, missing messages, folder creation, concurrency, idempotency, and race conditions.

Plan, report, approve, then execute.
