# Goal: Telegram Stream P0 Fix

Fix the current Telegram streaming 502 failure without changing unrelated features.

## Context

Current symptoms:

- `telegram-stream` `/health` returns 200.
- Video preview fails with:
  - `stream_start`
  - `stream_resolve_failed`
  - HTTP 502
- After this, Telegram videos cannot be streamed.
- Backend currently uses `teleproto 1.229.0` / Telegram Layer 229.
- `services/telegram-stream` currently uses `Telethon 1.44.0`, which is behind the backend Telegram layer.
- The stream service already maps `TypeNotFoundError` to `TELEGRAM_LAYER_MISMATCH`.
- Current logging hides the useful error code because `code` is redacted.
- The backend Telegram stream gateway does not correctly preserve all non-2xx upstream JSON errors.

This task is ONLY the Telegram streaming P0 fix.
Do not implement MIME normalization yet.

## Read First

Do NOT scan the whole repository.

Read only:

1. `AGENTS.md` if present.
2. `docs/README.md` if present.
3. `services/telegram-stream/requirements.txt`
4. `services/telegram-stream/pyproject.toml`
5. Files containing these symbols:
   - `TypeNotFoundError`
   - `TELEGRAM_LAYER_MISMATCH`
   - `stream_resolve_failed`
   - `resolve_document`
   - `ClientManager`
6. `services/telegram-stream/app/observability.py`
7. `backend/src/modules/telegram/telegram-stream-gateway.ts`
8. Existing Telegram stream tests related to resolver/error handling.

Only inspect additional files when required by these dependencies.

## Required Changes

### 1. Align Telegram protocol layer

Upgrade the telegram-stream Telethon dependency from:

`Telethon 1.44.0`

to:

`Telethon 1.45.0`

in every dependency declaration used by the service.

Do not change `teleproto` in the Node backend.

Keep dependency declarations consistent.

### 2. Preserve useful structured error logging

`stream_resolve_failed` must expose the stable application error code.

Do NOT weaken secret/OTP redaction.

Prefer changing:

`code=exc.code`

to a non-sensitive field such as:

`error_code=exc.code`

Expected log shape:

```json
{
  "event": "stream_resolve_failed",
  "error_code": "TELEGRAM_LAYER_MISMATCH",
  "status": 502
}
```

Include a safe exception type when useful, but never log:

- API hash
- session string
- auth token
- OTP/login code
- credentials

### 3. Fix gateway error propagation

Inspect:

`backend/src/modules/telegram/telegram-stream-gateway.ts`

When telegram-stream returns ANY non-2xx response:

- do not treat the body as video;
- do not override its content type with the file MIME type;
- preserve an appropriate HTTP status;
- preserve/forward structured JSON error information when safe;
- do not start the media streaming path.

Successful 200/206 streaming behavior must remain unchanged.

### 4. Keep client lifecycle safe

Review the existing `ClientManager` only around the affected resolver path.

Do not redesign it unless necessary.

A failed resolve request must not intentionally disconnect or invalidate unrelated healthy clients.

Do not add aggressive reconnect loops.

If an existing retry/reconnect mechanism already exists, preserve it.

## Tests

Add or update focused tests for:

1. `TypeNotFoundError` maps to:
   - HTTP 502
   - `TELEGRAM_LAYER_MISMATCH`

2. Structured logging exposes:
   - `error_code`
   while sensitive `code` values remain redacted.

3. Backend gateway receiving an upstream 502 JSON error:
   - returns an error response;
   - does NOT set `Content-Type: video/*`;
   - does NOT enter the streaming pipeline.

4. Existing successful 200/206 Telegram Range streaming tests still pass.

Run only relevant test suites first.
Run broader tests only if needed.

## Compatibility Requirements

Do not break:

- Telegram uploads
- Telegram sync
- WebDAV
- preview routes
- Range requests
- existing provider IDs
- channel/message IDs
- credential format
- Google Drive or S3 behavior

Do not modify MIME classification in this task.

## Definition of Done

The phase is complete when:

- telegram-stream uses Telethon 1.45.0 consistently;
- Telegram Layer mismatch errors are visible as `error_code`;
- upstream Telegram stream errors are propagated correctly;
- error JSON is never returned as `video/*`;
- existing successful Telegram streaming behavior remains intact;
- focused tests pass.

## Implementation Rules

- Make the smallest safe change.
- Do not rewrite working modules.
- Do not perform unrelated refactors.
- Reuse existing helpers and error types.
- Preserve public API contracts unless fixing the incorrect error response requires it.
- Update relevant documentation only if behavior/configuration changed.

## Final Response

Keep the final report concise:

1. Root cause confirmed/found
2. Files changed
3. Tests run and result
4. Any remaining risk
5. Required deployment action

Important: if the code contradicts the assumptions above, stop following the assumption and report the concrete evidence from the code before making a broader architectural change.
