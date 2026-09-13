# Goal: Fix Remote Import Queue Jobs Failing After Concurrency Limit

Fix the Remote Import queue bug where jobs #1 and #2 process normally, but job #3 and later can fail instead of waiting.

## Known Context

Current configuration may use:

```env
REMOTE_IMPORT_PER_USER_CONCURRENCY=2
REMOTE_IMPORT_GLOBAL_CONCURRENCY=4
```

The suspected affected code is:

```text
backend/src/modules/remote-imports/worker.ts
```

Current per-user gate behavior resembles:

```ts
if (!acquirePerUserSlot(userId)) {
  throw new DelayedError()
}
```

There is also a resource-admission path where:

```ts
processRemoteImportJob(job)
```

can return:

```text
deferred
```

and the worker throws `DelayedError`.

A BullMQ job must be moved to the delayed state before throwing `DelayedError`; otherwise it may be handled as an invalid processor transition/failure.

## Read First

Do NOT scan the whole repository.

Read only:

1. `AGENTS.md` if present.
2. `docs/README.md` if present.
3. `backend/src/modules/remote-imports/worker.ts`
4. Files directly used by:
   - `acquirePerUserSlot`
   - `releasePerUserSlot`
   - `processRemoteImportJob`
   - resource/admission control
5. Existing Remote Import worker/queue tests.

## Required Fix

For every processor-controlled defer path:

1. Move the BullMQ job to delayed state first.
2. Then throw `DelayedError`.
3. Use the current BullMQ worker lock token correctly.
4. Do not consume normal retry attempts for expected concurrency/resource waiting.
5. Do not mark the Remote Import record as failed just because no slot is currently available.

Expected pattern:

```ts
async (job, token) => {
  if (!acquirePerUserSlot(userId)) {
    await job.moveToDelayed(
      Date.now() + delayMs,
      token,
    )

    throw new DelayedError()
  }
}
```

Reuse/import BullMQ types normally. A small helper for defer logic is preferred if both paths need the same behavior.

Apply this to at least:

- per-user concurrency saturation;
- resource/admission result `deferred`.

Use a short delay for concurrency saturation and a reasonable longer delay for temporary resource shortage, following existing project constants/config if available.

## Important Lifecycle Rule

Only release a per-user slot if this execution actually acquired one.

Prevent:
- double release;
- leaked slots;
- negative counters;
- releasing a slot for a job that was deferred before acquisition.

Preserve existing cleanup/finally behavior where correct.

## Do Not

- Do not increase concurrency limits as the fix.
- Do not remove the per-user gate.
- Do not rewrite the queue architecture.
- Do not change Remote Import business logic.
- Do not modify HLS/download processing unless required for this queue-state fix.
- Do not add polling loops inside a worker job.

## Regression Test

Add a focused test with:

```text
per-user concurrency = 2

enqueue:
A
B
C
D
```

Expected:

```text
A → active
B → active
C → delayed/waiting, not failed
D → delayed/waiting, not failed

A/B finish
↓
C/D eventually process
↓
all jobs complete
```

Also test the resource-admission `deferred` path:

```text
temporary resource unavailable
→ job delayed
→ NOT failed
→ retries later
```

Existing successful Remote Import jobs must continue to work.

## Definition of Done

- job #3+ no longer fails only because the per-user concurrency limit is reached;
- deferred jobs are correctly represented in BullMQ as delayed/waiting;
- deferred jobs later resume automatically;
- expected deferrals do not consume failure retries;
- slot accounting remains correct;
- focused tests pass.

## Final Response

Keep the report short:

1. root cause confirmed;
2. files changed;
3. defer mechanism used;
4. tests run/result;
5. any remaining risk.

If the installed BullMQ version requires a slightly different `moveToDelayed` signature, follow the installed version's API instead of forcing the example above.
