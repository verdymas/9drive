# Phase 07 - Testing and Migration

Use PLAN MODE first.

Create comprehensive tests for:
1. export with stable ID and path;
2. import and match by ID;
3. move;
4. rename;
5. duplicate message;
6. malformed metadata;
7. missing metadata;
8. Telegram deletion safety;
9. duplicate ID detection;
10. deep paths;
11. Unicode names;
12. concurrent/idempotent sync.

If legacy messages exist, design safe backfill. Never invent paths when source data is insufficient.

Use automated tests and Playwright where applicable, plus queue/worker tests.

Plan, report, approve, then execute.
