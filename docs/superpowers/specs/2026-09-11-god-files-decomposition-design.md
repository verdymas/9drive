# B7 God-Files Decomposition Design

## Goal

Reduce the context and regression cost of the largest upload, Remote Import, Telegram Sync, and frontend modules while preserving all public contracts and the runtime behavior established by earlier bottleneck phases.

## Scope and invariants

- Execute the four prompt phases strictly in order: uploads, Remote Import, Telegram Sync, then frontend.
- Keep HTTP paths, status codes, JSON response shapes, exported worker/service functions, provider placement rules, persisted states, retry stages, cancellation, heartbeat updates, resource reservations, and FloodWait handling unchanged.
- Keep Google Drive, S3, Telegram, direct and resumable uploads, Remote Import/HLS, synchronization, sharing, WebDAV/SMB, browser capture, and logical filesystem behavior in scope and compatible.
- Add no database migration, environment variable, or runtime dependency.
- Preserve existing tests and add focused tests only for newly extracted pure or boundary behavior.
- Keep shared placement in `resolveUploadPlacement`; extracted upload and import flows call that service rather than copying routing decisions.

## Phase boundaries

### Phase 1 — Upload orchestration

`upload.routes.ts` becomes route composition and compatibility exports. Multipart parsing/stream lifecycle, resumable session operations, provider finalization/cleanup, and quota-refresh dispatch move into focused services. Provider adapters receive typed inputs and return typed upload results; they do not own HTTP responses. `handleUpload` remains exported for the public API router and existing tests.

### Phase 2 — Remote Import processor

`processor.ts` retains `processRemoteImportJob` as the single state-machine entry point. A typed context carries the record, decrypted source/request data, timeout assertion, progress methods, and cancellation/resource cleanup. Probe/direct stream-through, temporary download, HLS conversion, provider upload/registration, and failure handling are extracted behind phase functions. Resource reservations and cleanup are owned by the phase that acquires them and released from exception-safe `finally` blocks; persisted transitions remain in one orchestration path.

### Phase 3 — Telegram Sync

`telegram-sync.service.ts` remains responsible for lock/run lifecycle, page loop, heartbeat/cancel checks, final status, audit, and usage refresh. Pure document classification and matching precedence move to a testable module. FloodWait-aware page/caption access moves to a Telegram boundary. Page persistence, issue creation, and generation-based missing reconciliation move to persistence modules. Results use explicit typed outcomes instead of shared mutable classification maps.

### Phase 4 — Frontend decomposition

Extract only cohesive ownership boundaries: data/action hooks, upload progress operations, page toolbars/dialog sections, settings account sections, Remote Import form sections, and Drive layout data/sidebar/header sections. Page components keep route composition and page-level orchestration. Existing labels, selectors, keyboard/mouse handlers, query-param navigation, API helper calls, and public component/context exports stay unchanged.

## Error and compatibility strategy

Extracted services return the same domain errors or rethrow the original errors. Route wrappers translate typed service results to the current HTTP response bodies. When a test or external caller imports a current symbol, retain that symbol as a thin wrapper or re-export until all references use the focused module. No error-code renames or status-model changes are allowed.

## Verification strategy

Each phase follows a red-green-refactor loop for new tests, then runs its focused test suite and the relevant package build. The final audit runs the complete backend and frontend test suites, both builds, and a source-level contract check for routes/exports. Manual smoke checks cover uploads, Remote Import, Telegram settings/sync, file navigation/selection, and the extracted settings/layout flows.

