# Phase 4 — Decompose Large Frontend Pages and Drive Components

**Bottleneck:** B7 — oversized modules / engineering throughput  
**Phase:** 4 of 4

## Objective

Reduce context and regression surface in the largest React files by extracting focused hooks/components while preserving UI, routes, keyboard/mouse behavior, upload behavior, and API contracts.

## Read First

Start with repository instructions and project documentation if available:

- `AGENTS.md`
- `docs/README.md`
- the relevant feature/workflow/reference docs for this task

Then inspect these source files before editing:

- `frontend/src/pages/AllFilesPage.tsx`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/components/drive/RemoteImportModal.tsx`
- `frontend/src/layouts/DriveLayout.tsx`
- `frontend/src/context/UploadContext.tsx`

Do not assume the files are unchanged from the original audit. If an earlier phase extracted code, follow the current call graph and preserve the current public contract.

## Current Context

Large frontend files currently combine API loading, action state, dialogs, selection, layout, and rendering. The goal is maintainability, not a visual redesign.

Earlier B2 upload changes may have modified `UploadContext`; preserve its behavior and avoid mixing this refactor with transport redesign.

## Product Compatibility Constraints

Preserve all existing 9Drive capabilities and user-visible behavior unless this prompt explicitly adds an optional fast path. In particular, do not remove Google Drive, S3, Telegram, automatic storage routing, multipart upload, resumable upload, Remote Import/HLS, WebDAV, SMB, Jellyfin-compatible range streaming, sync/reconciliation, browser capture, existing auth, or logical filesystem semantics.

## Required Work

1. For each target file, map state/effects/actions before extraction.
2. Extract domain hooks for data fetching/actions only where ownership is clear.
3. Extract presentational sections/dialogs/toolbars that can receive typed props.
4. Keep route/page components responsible for composition and page-level orchestration.
5. Do not create a generic mega-hook that simply moves the god file elsewhere.
6. Preserve test selectors/accessibility behavior where existing tests depend on them.
7. Keep API client contracts unchanged.
8. Perform the files incrementally; do not rewrite all frontend architecture in one commit if the diff becomes hard to review.

## Tests and Verification

- Run focused tests for `UploadContext`, Remote Import modal/pages, Workers/settings where affected.
- Run frontend unit tests.
- Run typecheck/build.
- Perform manual smoke checks for file selection, upload, remote import, settings, and drive navigation.

## Documentation to Update

Update the existing relevant files, not duplicate documentation. At minimum inspect:

- `docs/README.md`
- `docs/application/features/*`
- `docs/reference/*frontend*`

If the exact docs were reorganized, update the equivalent current documents.

## Acceptance Criteria

- [ ] Major page/component responsibilities are split into focused units.
- [ ] No user-visible redesign is introduced.
- [ ] Upload/direct-path behavior from prior phases remains intact.
- [ ] Existing routes and API calls remain compatible.
- [ ] Type safety is maintained or improved.

## Do Not

- Do not introduce a new state-management library solely for this refactor.
- Do not redesign visual styles or interaction patterns.
- Do not change backend API contracts.

## Final Response Required from the Agent

Return:

1. concise summary of the implementation;
2. list of changed files;
3. migrations or new environment variables, including defaults;
4. tests executed and results;
5. any remaining risk or follow-up that belongs to the next phase.

Do not claim performance improvement without measurements. Distinguish code-level guarantees from benchmark results.
