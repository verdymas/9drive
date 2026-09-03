# Phase 01 - Architecture Audit

Use PLAN MODE first. Do not implement.

Audit the existing Telegram integration, including bot integration, upload/import flows, workers, file/message models, storage, folders, sync logic, webhooks, queues, tests, and docs.

Design around:

    9drive:id=xxx
    9drive:path=Projects/APP-V/docs/architecture.md

Requirements:
- 9drive remains authoritative for logical paths;
- Telegram Topics must not represent folders;
- stable ID identifies the logical file;
- path identifies current logical location;
- filename stays independent from logical path.

Report current architecture, conflicts, proposed data flow, affected files, risks, and tests. Stop after report.
