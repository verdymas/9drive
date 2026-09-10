# Phase 2 — Decompose Remote Import Processor into Explicit Phases

**Bottleneck:** B7 — oversized modules / engineering throughput  
**Phase:** 2 of 4

## Objective

Split the Remote Import processor into focused phase modules while preserving the same state machine, retries, HLS behavior, provider placement, and worker contract.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `backend/src/modules/remote-imports/processor.ts`
- `backend/src/modules/remote-imports/remote-import.service.ts`
- `backend/src/modules/remote-imports/worker.ts`
- `backend/src/modules/remote-imports/hls/*`
- `backend/src/modules/remote-imports/google-resumable-uploader.ts`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

`processor.ts` coordinates probing, direct download, HLS, placement, provider upload, progress, final registration, retry state, and failures. B3 may already have added resource controls and stream-through paths.

This refactor must preserve those semantics and should expose phase boundaries rather than duplicate the state machine.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. Create an explicit processor context type that carries only required state/dependencies.
2. Extract coherent phases such as probe, download/materialize, HLS processing, placement, provider upload, finalize, and failure/retry helpers.
3. Keep provider-specific upload adapters separate from orchestration.
4. Keep one authoritative transition/state-machine path.
5. Preserve cancellation and heartbeat checks between long phases.
6. Preserve B3 resource reservations/semaphores across extraction; ensure cleanup remains centralized and exception-safe.
7. Keep the worker-facing processor export/signature stable if possible.

## Tests and Verification

- Run all Remote Import unit tests.
- Run HLS integration tests where FFmpeg exists.
- Specifically test retry from each persisted stage after extraction.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/REMOTE_IMPORTS.md`
- `docs/WORKERS.md`
- `docs/application/workflows/*remote*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Processor orchestration is readable without provider implementation details.
- [ ] State transitions are not duplicated.
- [ ] Retry/cancel/resource cleanup behavior is unchanged.
- [ ] Tests remain at least as strong as before.

## Do Not

- Do not redesign RemoteImport statuses during this refactor.
- Do not merge HLS and direct paths into an overly generic abstraction that obscures different resource semantics.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
