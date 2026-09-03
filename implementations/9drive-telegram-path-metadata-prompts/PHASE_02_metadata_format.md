# Phase 02 - Metadata Format

Use PLAN MODE first.

Define and implement reusable Telegram metadata:

    9drive:id=<stable-file-id>
    9drive:path=<logical-path>

Requirements:
- stable ID;
- normalized path;
- deterministic serialization;
- safe parser;
- malformed metadata handled safely;
- messages without metadata remain supported.

Do not use filename, chat, or topic as primary identity. Define escaping, validation, duplicate-field behavior, and caption-size considerations.

Plan, report, approve, then execute.
