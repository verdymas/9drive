# 9drive Telegram Path Metadata Sync Prompts

Core metadata:

    9drive:id=xxx
    9drive:path=Projects/APP-V/docs/architecture.md

Principles:
- 9drive is the authoritative logical filesystem.
- Telegram Topics are not mapped to folders.
- Filename remains the actual filename.
- `9drive:id` is stable identity.
- `9drive:path` is the logical location.
- Telegram deletion must not automatically delete a 9drive file.

Workflow for every phase:
PLAN MODE → REPORT → APPROVAL → EXECUTE → TEST → DOCS
