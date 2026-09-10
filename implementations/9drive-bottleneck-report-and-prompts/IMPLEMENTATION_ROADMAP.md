# 9Drive Bottleneck Implementation Roadmap

This roadmap defines the safest execution order for the phase prompts in `prompts/`.

## Rules

- Finish all tests for a phase before starting the next phase of the same bottleneck.
- Do not run two agents against the same core file at the same time.
- Commit or otherwise checkpoint after every phase.
- Run the complete relevant backend/frontend test suite at the end of each bottleneck.
- Update `docs/` as part of the phase, not as a later cleanup task.
- Preserve all current product capabilities.

## Recommended Waves

### Wave 1 — Immediate Safety

1. `01-multipart-upload-memory/phase-1-boundaries-and-tests.md`
2. `01-multipart-upload-memory/phase-2-remove-full-file-buffering.md`
3. `01-multipart-upload-memory/phase-3-provider-streaming-and-abort.md`

This removes the most direct process-stability risk.

### Wave 2 — Heavy Background Work

1. `03-remote-import-hls/phase-1-resource-observability-and-admission.md`
2. `03-remote-import-hls/phase-2-separate-resource-concurrency.md`
3. `03-remote-import-hls/phase-3-stream-through-direct-import.md`
4. `03-remote-import-hls/phase-4-hls-global-resource-control.md`

Phase 3 is intentionally after the basic resource controls. A new streaming fast path should not be used as a substitute for safe temp-disk behavior.

### Wave 3 — Metadata / Reconciliation Scale

These bottlenecks mostly touch separate files and can be handled by separate agents if Git isolation is used:

- `04-sync-db-write-amplification/*`
- `05-telegram-sync/*`
- `06-webdav-metadata/*`

However, review the Telegram phases against the generic reconciliation changes before merge because both depend on `lastSeenSyncRunId` semantics.

### Wave 4 — Data-Plane Optimization

Run:

- `02-centralized-data-plane/phase-1-proxy-hardening.md`
- `02-centralized-data-plane/phase-2-s3-direct-download.md`
- `02-centralized-data-plane/phase-3-s3-direct-upload.md`
- `02-centralized-data-plane/phase-4-media-process-isolation.md`

This wave is after B1 so new upload fast paths can reuse the safer upload/provider boundaries.

### Wave 5 — Structural Decomposition

Run all prompts in `07-god-files/` last.

The purpose of this wave is to reduce future engineering cost, not to change runtime semantics.

## File-Conflict Guide

| Area | High-conflict files |
|---|---|
| B1 | `upload.routes.ts`, S3/Google/Telegram upload helpers |
| B2 | `stream-file.ts`, S3 service, file routes, upload APIs |
| B3 | `remote-imports/processor.ts`, worker/queue/temp/HLS files |
| B4 | `sync/file-reconciler.ts`, Prisma schema |
| B5 | Telegram sync worker/service/queue/scheduler |
| B6 | `webdav-virtual-fs.ts`, Prisma schema |
| B7 | intentionally overlaps many prior files |

B4 Phase 3 and B6 Phase 1 may both create Prisma migrations. Do them sequentially or carefully rebase migration history.

## Completion Gate

The optimization program is complete only when:

- multipart upload memory is bounded;
- Remote Import has disk/resource admission control;
- sync does not write unchanged rows individually;
- Telegram account size no longer determines preload memory;
- WebDAV exact path resolution no longer loads sibling collections;
- S3 can bypass the byte proxy when safe;
- proxy streaming remains a fully supported fallback;
- structural refactors retain public contracts;
- docs and operational runbooks match the deployed architecture.
