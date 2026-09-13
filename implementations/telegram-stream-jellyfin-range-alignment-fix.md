# Goal: Fix Telegram Stream Arbitrary Range Alignment for Jellyfin Metadata Scans

Fix `telegram-stream` so arbitrary HTTP Range requests from Jellyfin metadata refresh/probing do not fail with `LimitInvalidError`.

This task is intentionally narrow and optimized for GPT-5.6 Luna.

## Confirmed Failure

Jellyfin metadata refresh can request arbitrary byte ranges such as:

```text
Range: bytes=41639936-75194367
```

Current behavior:

```text
HTTP 206 is started
↓
telegram-stream begins Telethon download
↓
Telethon raises:
LimitInvalidError
(caused by GetFileRequest)
↓
0 bytes / 0 chunks sent
```

The failure occurs in the Telegram byte streaming path, around:

```text
services/telegram-stream/app/telegram/engine.py
```

and is triggered by arbitrary seek offsets that are not valid for Telegram `upload.getFile` request boundaries.

Do not special-case Jellyfin by User-Agent.
Fix arbitrary HTTP Range handling generically.

---

## Read First

Do NOT scan the whole repository.

Read only:

1. `AGENTS.md` if present.
2. `docs/README.md` if present.
3. `services/telegram-stream/app/api/stream.py`
4. `services/telegram-stream/app/telegram/engine.py`
5. Files directly used by:
   - `iter_bytes`
   - Telethon `iter_download`
   - Range parsing
   - stream metrics/error handling
6. Existing telegram-stream Range/stream tests.

Only inspect additional files if directly required.

---

## Required Fix

### 1. Align Telegram upstream reads, not the HTTP response

The client/Jellyfin must still receive the exact requested range.

For a requested start offset:

```text
start = arbitrary HTTP byte offset
```

align the Telegram upstream offset down to a valid chunk boundary.

Example with 512 KiB Telegram request size:

```text
request_size = 512 * 1024

aligned_start =
  floor(start / request_size) * request_size

prefix_skip =
  start - aligned_start
```

Then:

```text
Telegram starts reading from aligned_start
↓
discard prefix_skip bytes internally
↓
yield bytes starting exactly at requested HTTP start
```

Do NOT round or modify the HTTP Range visible to the client.

### 2. Respect Telegram file-part constraints

Ensure every underlying Telegram file request remains valid.

Do not allow a request chunk to cross an invalid Telegram file-part boundary.

Use the existing Telethon API correctly for the installed Telethon version.

Prefer a fixed aligned `request_size` that is valid for Telegram, e.g. 512 KiB if already used by the project.

Do not "fix" this only by making the request size smaller unless alignment is also correct.

### 3. Stop exactly at requested HTTP length

For a bounded range:

```text
bytes=start-end
```

yield exactly:

```text
end - start + 1
```

bytes.

Do not over-read into the HTTP response.

Internal upstream over-read needed for alignment is acceptable only if discarded before yielding.

### 4. Preserve streaming and low memory use

Do not buffer the whole video or the whole requested range.

Keep the implementation streaming and bounded-memory.

### 5. Improve first-chunk failure handling if small and safe

Currently `206 Partial Content` may be committed before the first Telegram chunk is successfully read.

If the existing architecture allows a small safe change, prefetch the first chunk before committing the streaming response so an upstream failure can return a proper error response instead of:

```text
206 + ASGI exception + 0 bytes
```

Do not perform a broad response-stack refactor if this becomes invasive.
The Range alignment fix is the priority.

---

## Regression Tests

Add focused tests for arbitrary Range offsets.

### A. Exact Jellyfin regression case

Use:

```text
start = 41639936
end   = 75194367
```

Expected:

```text
HTTP status: 206
first output byte: exact requested start
output length: 33554432 bytes
no LimitInvalidError
```

### B. Boundary cases

Test starts around alignment boundaries:

```text
0
1
4095
4096
(512 KiB) - 1
512 KiB
(1 MiB) - 1
1 MiB
```

Expected:
- upstream Telegram offset is valid/aligned;
- output still begins at the exact requested client offset.

### C. Open-ended Range

Example:

```text
bytes=41639936-
```

Expected:
- correct `206`;
- stream begins at exact requested byte;
- no invalid Telegram limit/offset request.

### D. Existing byte-zero streaming

Example:

```text
bytes=0-
```

must continue to work unchanged.

### E. No full buffering

Tests or implementation review should confirm the fix does not read the whole file into memory.

---

## Compatibility Requirements

Do not break:

- normal Telegram video playback
- Jellyfin metadata refresh
- seeking
- WebDAV
- Range responses
- existing Telegram resolver logic
- Telegram session/client lifecycle
- MIME handling
- Google Drive
- S3

Do not modify unrelated Telegram metadata/caption logic.

---

## Implementation Rules

- Make the smallest safe change.
- Fix the root cause in the Telegram byte-streaming layer.
- Do not add Jellyfin-specific branching.
- Do not download the full file as a workaround.
- Do not disable HTTP Range.
- Do not silently change requested offsets.
- Keep memory usage bounded.
- Reuse existing metrics/logging.

---

## Definition of Done

The fix is complete when:

- Jellyfin arbitrary metadata-probe ranges no longer raise `LimitInvalidError`;
- the exact regression range `41639936-75194367` streams successfully;
- client-visible byte ranges remain exact;
- Telegram upstream reads satisfy valid alignment/part constraints;
- byte-zero and normal playback still work;
- focused tests pass.

---

## Final Response

Keep the final report concise:

1. root cause confirmed;
2. files changed;
3. alignment strategy used;
4. regression tests run/result;
5. whether first-chunk error handling was also improved;
6. any remaining risk.

If the installed Telethon behavior differs from the assumptions above, follow the actual installed API and preserve the same correctness requirements.
