# Phase 03 - Telegram to 9drive Import

Use PLAN MODE first.

Implement Telegram → 9drive ingestion using the stable ID and logical path.

Flow:
Telegram message → parse metadata → resolve ID → resolve path → find existing file → update or create → persist Telegram source reference.

Rules:
- ID takes precedence over filename;
- path determines folder placement;
- create missing folders when appropriate;
- final path segment is filename;
- no Telegram Topic folder mapping;
- Telegram deletion must not delete 9drive files.

Handle duplicates, re-imports, renames, moves, invalid paths, and messages without metadata. Use Inbox/fallback for unlinked files.

Plan, report, approve, then execute.
