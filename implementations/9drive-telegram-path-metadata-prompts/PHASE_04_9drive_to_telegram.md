# Phase 04 - 9drive to Telegram Export

Use PLAN MODE first.

When sending a file to Telegram, include:

    9drive:id=<stable-file-id>
    9drive:path=<current-logical-path>

Filename remains the actual filename, e.g. `architecture.md`.

Persist Telegram message/source identifiers. Reuse the same stable ID across re-uploads. Update metadata when a 9drive file is moved or renamed.

Do not encode folders into filenames and do not treat Telegram as the authoritative filesystem.

Plan, report, approve, then execute.
