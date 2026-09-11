# B3 — Remote Import / HLS Resources Checklist

Status key: check an item only after its implementation, focused tests,
relevant suite, and documentation update have passed. Complete phases in the
listed order.

## Phase 1 — Resource observability and admission control

- [x] Inspect temp-storage capacity before disk-heavy work.
- [x] Add documented free-space reserve and unknown-size reservation policy.
- [x] Defer resource-starved work recoverably without losing import intent.
- [x] Release every reservation on success, failure, cancellation, and requeue.
- [x] Expose structured resource diagnostics.
- [x] Preserve sweep, retry, heartbeat, cancellation, and SSRF behavior.
- [x] Add focused tests and run the relevant Remote Import suite.
- [x] Update Remote Import, worker, environment, and runbook documentation.

## Phase 2 — Separate direct and HLS concurrency budgets

- [ ] Classify work early and enforce independent direct/HLS limits.
- [ ] Preserve one state machine, IDs, status API, and cross-class per-user limit.
- [ ] Keep retry, cancellation, heartbeat, and reconciliation correct.
- [ ] Add focused tests and run the relevant Remote Import suite.
- [ ] Update topology, environment, and worker documentation.

## Phase 3 — Resumable stream-through direct imports

- [ ] Add explicit eligibility and retain temp-spool fallback for every ineligible path.
- [ ] Implement safe Google resumable stream-through and S3 multipart recovery.
- [ ] Keep HLS and Telegram on existing behavior.
- [ ] Preserve progress, cancellation, retry, placement, and final registration.
- [ ] Add focused tests and run the relevant Remote Import/provider suites.
- [ ] Update Remote Import workflow, provider integration, and runbook documentation.

## Phase 4 — Global HLS segment and FFmpeg control

- [ ] Bound aggregate HLS segment downloads independently of HLS job count.
- [ ] Bound concurrent FFmpeg processes with configurable slots.
- [ ] Prevent permit leaks, including cancellation while queued.
- [ ] Preserve HLS validation, retries, fallback, and quality selection.
- [ ] Add focused tests and run HLS/FFmpeg verification.
- [ ] Update HLS, environment, and runbook documentation.

## Completion audit

- [ ] Verify every phase's acceptance criteria against current code and tests.
- [ ] Record commands, results, migrations, new environment variables, and remaining deployment risks.

## Verification record

- Phase 1 — `cd backend && npm test -- src/modules/remote-imports` → 29 files / 377 tests passed; focused admission/HLS/queue/service verification → 5 files / 69 tests passed; `cd backend && npm run build` → passed (2026-09-11).
