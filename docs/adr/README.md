# ADR Index

Architecture Decision Records capture decisions that are difficult to infer from code alone. Read this folder only when a task affects architecture, data ownership, security boundaries, queueing, or provider abstractions.

| ADR | Decision |
|---|---|
| `0001-virtual-filesystem-over-multiple-providers.md` | The database unifies multiple providers into one logical filesystem. |
| `0002-encrypt-provider-secrets-at-rest.md` | Sensitive tokens and credentials are encrypted or hashed at rest. |
| `0003-background-remote-import-with-bullmq.md` | Remote Import runs in a BullMQ worker instead of a long-lived HTTP request. |
| `0004-telegram-db-is-logical-source-of-truth.md` | 9Drive DB is authoritative for logical paths; Telegram is a physical mirror. |
| `0005-remote-fetch-worker-is-transport-only.md` | Remote Fetch Workers provide network transport only; they do not execute the HLS/upload pipeline. |
