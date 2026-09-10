# B5 — Telegram Sync

Goal: improve large-channel sync duration and memory use while respecting Telegram FloodWait and preserving stable logical identity.

Phases:

1. Account-level concurrency with single-flight safety.
2. Page-scoped DB state instead of account-wide preload.
3. Bounded caption/outcome processing and batch persistence.
