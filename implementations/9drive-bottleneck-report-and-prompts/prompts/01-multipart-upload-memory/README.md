# B1 — Multipart Upload Memory

Goal: remove file-size-proportional memory use from the multipart API while preserving the endpoint and all provider behavior.

Phases:

1. Establish boundaries and regression tests.
2. Remove full-file buffering using spool/stream primitives.
3. Use provider-native streaming where safe and harden abort/cleanup behavior.

Run sequentially.
