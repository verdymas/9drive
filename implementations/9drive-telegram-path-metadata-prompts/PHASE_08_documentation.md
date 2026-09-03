# Phase 08 - Documentation

Use PLAN MODE first.

Update Telegram documentation.

Document:
- 9drive as authoritative logical filesystem;
- Telegram as mirror/import channel;
- metadata format:

    9drive:id=xxx
    9drive:path=Projects/APP-V/docs/architecture.md

Explain stable identity, logical path, filename, create/update/move/rename, duplicate detection, deletion behavior, and unlinked files.

Explicitly state that Telegram Topics are NOT mapped one-to-one to 9drive folders.

Document developer rules: preserve stable ID, logical path, idempotency, and source-of-truth boundaries.

Plan, report, approve, then execute.
