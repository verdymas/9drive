# B2 — Centralized Data Plane

Goal: prevent all file bytes from unnecessarily traversing the main API process while preserving server-proxy compatibility.

Phases:

1. Harden the existing proxy and introduce a delivery abstraction.
2. Add secure direct S3 downloads with fallback.
3. Add optional direct S3 uploads while keeping existing APIs.
4. Isolate media-heavy routes/processes behind the same external URLs.
