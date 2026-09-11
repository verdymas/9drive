# B7 — Structural Decomposition Progress

Tracker for the four prompt phases in this directory. A checkbox is ticked only after the listed focused verification and build gate has passed.

## Preparation

- [x] Read repository instructions, selected documentation, and all four phase prompts.
- [x] Audited current target sizes, call graph entry points, and public exports.
- [x] Wrote the design spec and implementation plan.
- [x] Establish and record the baseline test results.

Baseline recorded 2026-09-11:

- Frontend: `npm test` — 6 files and 99 tests passed.
- Backend: `npm test` — 95 files and 1,145 tests passed; 4 tests failed in three existing WebDAV suites because of timeout/fetch-mock behavior (`webdav-telegram-routing.test.ts`, `webdav-virtual-fs.test.ts`, `webdav-no-decrypt.test.ts`). These are baseline failures outside B7 scope and must not be attributed to the decomposition.

## Phase 1 — Decompose upload orchestration

- [x] Extract provider-specific staged-upload finalization and cleanup.
- [x] Extract multipart parsing, staging, cancellation, aggregation, and session lifecycle.
- [x] Extract resumable init/preflight/status/chunk service logic.
- [x] Preserve `uploadRouter` and exported `handleUpload` compatibility.
- [x] Run all upload/storage-routing tests — 10 files, 82 tests passed.
- [x] Run backend build — `npm run build` exited 0.

## Phase 2 — Decompose Remote Import processor

- [x] Add typed processor context, progress, cancellation, and failure boundaries (`processor-context.ts`, `processor-progress.ts`).
- [x] Extract direct probe, stream-through, and temporary download phases (`processor-probe.ts`, `processor-direct.ts`, `processor-download.ts`).
- [x] Extract HLS processing while preserving resource reservations and resume markers (`processor-hls.ts`).
- [x] Extract provider upload, registration, and shared completion tail (`processor-upload.ts`).
- [x] Preserve `processRemoteImportJob` signature and one transition path.
- [x] Run all Remote Import tests — 37 files and 405 tests passed.
- [x] Run backend build — `npm run build` exited 0.

## Phase 3 — Decompose Telegram Sync service

- [x] Add explicit sync types and pure matching/classification module.
- [x] Add direct classification tests for precedence and conflict outcomes — 4 tests passed.
- [x] Extract FloodWait-aware Telegram page/caption access.
- [x] Extract page persistence, issue recording, and missing reconciliation.
- [x] Preserve `runTelegramSync`, worker, routes, concurrency, and lock lifecycle.
- [x] Run all Telegram tests — 24 files and 209 tests passed.
- [x] Run backend build — `npm run build` exited 0.

## Phase 4 — Decompose frontend pages/components

- [x] Extract focused All Files data/actions and presentational sections (`useAllFiles.ts`, connected account section, existing file views).
- [x] Extract focused Settings data/actions and account sections (`useSettings.ts`, `ConnectedStorageAccountsCard.tsx`).
- [x] Extract Remote Import form/probe/HLS sections without changing behavior (`useRemoteImportForm.ts`, `RemoteImportHlsSection.tsx`).
- [x] Extract Drive layout data/sidebar/header responsibilities (`useDriveLayout.ts`).
- [x] Extract UploadContext transport/progress helpers without changing its public value (`upload-client.ts`).
- [x] Run focused frontend tests — 9 files and 102 tests passed.
- [x] Run frontend tests — 11 files and 104 tests passed.
- [x] Run frontend build — `npm run build` exited 0; Vite emitted only the existing chunk-size warning.
- [ ] Perform manual smoke checks for selection, upload, Remote Import, settings, and navigation.

Phase 4 implementation evidence (2026-09-11):

- `frontend/src/hooks/useAllFiles.ts` owns file/folder queries, mapping, account
  loading, drop moves, and selection actions; `AllFilesPage.tsx` remains route
  composition and dialog ownership.
- `frontend/src/hooks/useSettings.ts` owns connected-account loading,
  selection, provider connect/reconnect, sync, disconnect/purge, and Telegram
  connection state; `SettingsPage.tsx` retains system/config/backup concerns.
- `frontend/src/hooks/useDriveLayout.ts` owns storage/user refresh, theme,
  search filters, navigation, and logout state.
- `frontend/src/lib/upload-client.ts` owns browser resumable/direct-S3
  transport; `UploadContext` retains the existing public progress/retry value.
- Remote Import modal, page, worker, and hook regressions passed: 77 tests.
- Local HTTP check: backend `/health` returned 200. Port 5173 is occupied by
  an unrelated Laravel Vite page, so authenticated browser smoke checks were
  not run and are intentionally left open above.

## Final audit

- [x] Update affected documentation with the final file map (`docs/application/features/*`, `docs/reference/directory-map.md`).
- [x] Run complete backend test suite and build — 111 files and 1,173 tests passed; build exited 0.
- [x] Run complete frontend test suite and build — 11 files and 104 tests passed; build exited 0.
- [x] Verify no migrations, environment variables, dependencies, routes, response contracts, or public exports changed unintentionally. `git diff --check` is clean.
- [x] Record exact verification evidence and remaining risks here.

Remaining risks:

- [ ] Manual authenticated UI smoke checks remain pending because the available
  local frontend port is serving another application. Automated UI and build
  coverage is green; no performance improvement is claimed without a benchmark.
