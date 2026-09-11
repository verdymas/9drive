# Goal: Browser Capture Canonical Filename Fix

Fix Browser Capture filename resolution so captured media keeps a meaningful logical filename instead of opaque CDN/object names such as:

```text
55234234e.vid
f2a7d913843b.mp4
8b2c23f4a776e201.bin
```

Example expected behavior:

```text
Actual media title:
video bagus

Captured URL:
https://cdn.example.com/55234234e.vid

Content-Type:
video/mp4

Expected final filename:
video bagus.mp4
```

This task is intentionally narrow and optimized for GPT-5.6 Luna.
Do not refactor unrelated Browser Capture or Remote Import functionality.

---

## Current Problem

The current capture flow can treat an opaque URL basename as a valid filename.

A generated/internal transport filename such as:

```text
55234234e.vid
```

may be prefilled into the import dialog.

If the user clicks Import without editing the field, the popup may still send that prefilled value as an explicit `filename`.

The backend then treats it as a user override and preserves it, preventing later filename detection from selecting a better name.

This creates two separate problems:

1. opaque CDN/object identifiers are ranked too highly;
2. a suggested filename is incorrectly treated as an explicit user-chosen filename.

Both must be fixed.

---

## Read First

Do NOT scan the whole repository.

Read only:

1. `AGENTS.md` if present.
2. `docs/README.md` if present.
3. Browser Capture extension files containing:
   - `dlgName`
   - `customFilename`
   - `filename`
   - capture/import dialog submission
   - filename candidate scoring
   - generic filename detection
4. Backend files containing:
   - `importCapturedResource`
   - `createRemoteImport`
   - `detectedFileName`
   - `fileName`
   - filename detection/probing helpers
5. Existing Browser Capture / Remote Import filename tests.

Only inspect additional files when directly required by these code paths.

---

## Required Changes

### 1. Separate suggested filename from explicit user override

A filename shown in the import dialog is not automatically a user override.

The code must distinguish:

```text
suggested filename
```

from:

```text
explicit custom filename entered/changed by the user
```

Expected behavior:

```text
Suggested:
55234234e.vid

User does NOT edit the field

POST/import payload:
filename = null / omitted
```

The backend must remain free to resolve a better canonical filename.

If the user edits the field:

```text
Suggested:
55234234e.vid

User changes it to:
My Video.mp4
```

then send:

```text
filename = "My Video.mp4"
```

and preserve it as an explicit override.

Do not infer "edited" only from the field being non-empty.
Track whether the user actually changed the value, or compare safely against the original suggestion.

---

### 2. Detect opaque transport/object filenames

Add or reuse a conservative helper such as:

```ts
isOpaqueFilename(name)
```

Exact naming should follow project conventions.

It should recognize common non-human object identifiers such as:

```text
55234234e.vid
8b2c23f4a776e201.bin
550e8400-e29b-41d4-a716-446655440000.mp4
9273518273.dat
```

Use conservative heuristics based on combinations of:

- UUID-like stems
- long hex/hash-like stems
- long numeric-only stems
- known transport/generic extensions such as:
  - `.vid`
  - `.bin`
  - `.dat`
  - `.tmp`
- resource/media type

Do NOT classify normal filenames such as:

```text
matrix1999.mp4
episode12.mp4
video2026.mp4
```

as opaque only because they contain numbers.

Do not build an overly broad entropy heuristic that risks renaming valid user files.

---

### 3. Lower priority of opaque URL basenames

A meaningful URL basename may still be useful.

Example:

```text
/my-trip-video.mp4
```

should remain a strong candidate.

But an opaque basename such as:

```text
/55234234e.vid
```

must rank below meaningful metadata sources.

For video/media capture, prefer meaningful sources such as:

1. explicit user filename
2. `Content-Disposition filename*`
3. `Content-Disposition filename`
4. HTML `download` filename
5. structured/player/API filename or title
6. JSON-LD `VideoObject.name`
7. media/DOM title
8. `og:title`
9. meaningful URL basename
10. page title
11. opaque URL basename
12. generated fallback

Do not blindly reorder all existing candidates if the current implementation has additional valid signals.
Preserve existing good behavior and only ensure opaque URL names cannot dominate better semantic metadata.

---

### 4. Normalize generic extensions using MIME type

Transport extensions such as:

```text
.vid
.bin
.dat
.tmp
```

must not be treated as authoritative output extensions when a specific MIME type is known.

Examples:

```text
URL:
55234234e.vid

Content-Type:
video/mp4

Resolved title:
video bagus

Expected:
video bagus.mp4
```

```text
URL:
abc123.bin

Content-Type:
video/x-matroska

Resolved title:
Film Saya

Expected:
Film Saya.mkv
```

Use the project's existing MIME/extension mapping if available.

Do not create a conflicting second MIME map unless necessary.

---

### 5. Keep backend detection as a safety net

The backend must not trust an opaque final/request URL basename as authoritative merely because it is syntactically valid.

If no explicit user override exists, backend probing should still be able to prefer:

- Content-Disposition filename
- detected media metadata
- meaningful capture metadata
- MIME-derived extension

over an opaque URL basename.

Do not weaken explicit user overrides.

---

### 6. Preserve filename sanitation

All final filenames must continue to use the project's existing sanitization rules.

Preserve behavior for:

- invalid filesystem characters
- empty names
- excessively long names
- path traversal attempts
- duplicate naming rules

Do not introduce new path handling logic unless required.

---

## Regression Tests

Add focused tests for the following cases.

### A. Opaque `.vid` capture with meaningful media title

Input:

```text
URL:
https://cdn.example.com/55234234e.vid

Content-Type:
video/mp4

media/player title:
video bagus

user did NOT edit filename
```

Expected final filename:

```text
video bagus.mp4
```

Must NOT become:

```text
55234234e.vid
```

---

### B. Suggested filename must not become explicit override automatically

Given:

```text
suggestedFilename = 55234234e.vid
dialog field = 55234234e.vid
user does not edit
```

Expected import request:

```text
filename omitted/null
```

or equivalent existing representation for "no explicit override".

---

### C. Explicit user edit must win

Given:

```text
suggestedFilename = 55234234e.vid

user edits field to:
My Personal Video.mp4
```

Expected:

```text
filename = My Personal Video.mp4
```

Backend must preserve it.

---

### D. Opaque hash with real extension

Input:

```text
URL:
https://cdn.example.com/f2a7d913843b.mp4

Content-Type:
video/mp4

media title:
Video Bagus
```

Expected:

```text
Video Bagus.mp4
```

The `.mp4` extension alone must not make the hash-like stem authoritative.

---

### E. Meaningful URL filename remains valid

Input:

```text
URL:
https://example.com/media/video-bagus.mp4
```

with no stronger filename metadata.

Expected:

```text
video-bagus.mp4
```

Do not regress useful URL filename detection.

---

### F. Numeric but meaningful filename is preserved

Examples:

```text
matrix1999.mp4
episode12.mp4
video2026.mp4
```

These must NOT be treated as opaque by an overly aggressive rule.

---

### G. Generic extension replaced from MIME

Input:

```text
name candidate:
55234234e.vid

resolved semantic title:
video bagus

Content-Type:
video/mp4
```

Expected:

```text
video bagus.mp4
```

---

## Compatibility Requirements

Do not break:

- Browser Capture resource detection
- HLS capture
- DASH capture
- direct media capture
- Remote Import
- explicit custom filename behavior
- MIME detection
- Content-Disposition handling
- Google Drive
- S3
- Telegram
- upload routing
- existing filename sanitation

Do not modify Telegram metadata handling in this task.

Do not implement unrelated UI redesign.

---

## Implementation Rules

- Make the smallest safe change.
- Prefer shared filename classification helpers over scattered regexes.
- Do not rewrite the Browser Capture extension.
- Do not rewrite Remote Import.
- Reuse existing candidate scoring and MIME helpers where possible.
- Keep explicit user input highest priority.
- Treat URL/object names as hints, not authoritative names, when they are opaque.
- Add comments only where the distinction between suggested and explicit filename is non-obvious.
- Run focused tests first.

---

## Definition of Done

The fix is complete when:

- `55234234e.vid` is no longer selected over a meaningful video title;
- opaque/hash-like transport names are recognized conservatively;
- generic transport extensions can be replaced using known MIME type;
- an untouched suggested filename is not sent as an explicit user override;
- a genuinely user-edited filename is preserved;
- meaningful URL filenames still work;
- normal numeric filenames are not falsely classified as opaque;
- focused Browser Capture / Remote Import filename tests pass.

---

## Final Response

Keep the final report concise:

1. Root cause confirmed
2. Files changed
3. Filename priority/opaque-name rule implemented
4. Tests run and result
5. Any remaining edge case

Important: if the current code differs from the assumptions above, follow the concrete code evidence and keep the fix narrow. Do not broaden this into a general Browser Capture refactor.
