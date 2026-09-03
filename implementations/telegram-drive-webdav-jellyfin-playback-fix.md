# Fix Telegram Drive WebDAV Playback for Jellyfin

## Context

9Drive already has an existing **read-only WebDAV** implementation.

Current WebDAV documentation:

```text
WebDAV (Read-Only) Access for rclone & Jellyfin
```

The endpoint is:

```text
http://<host>:4000/webdav
```

Authentication currently uses:

```env
WEBDAV_PASSWORD=...
```

with HTTP Basic Auth.

The existing WebDAV implementation currently works for the Google Drive-backed storage:

- Jellyfin can connect
- Jellyfin can browse folders
- Jellyfin can see files
- Jellyfin can play Google Drive-backed media

However, Telegram Drive behaves differently:

- Telegram Drive folders/files appear correctly in Jellyfin
- Jellyfin can see the media files
- But when Jellyfin attempts to play a Telegram-backed media file, playback fails

The goal is to make the existing WebDAV endpoint correctly serve Telegram-backed files to Jellyfin.

Do NOT create a second WebDAV implementation.

Do NOT replace the existing WebDAV architecture.

Do NOT modify `references/teledrive`.

---

# 1. Primary Goal

Make this work:

```text
Jellyfin
    ↓
WebDAV GET
    ↓
9Drive virtual file
    ↓
Telegram Drive provider
    ↓
Telegram physical file
    ↓
stream
    ↓
Jellyfin
```

Google Drive behavior must remain unchanged.

---

# 2. IMPORTANT: Audit First

Before modifying code, inspect the existing WebDAV implementation.

Determine exactly how the current WebDAV implementation handles:

```text
PROPFIND
HEAD
GET
Range
Content-Length
Content-Type
Last-Modified
ETag
Accept-Ranges
streaming
```

Then compare:

```text
Google Drive-backed file
vs
Telegram Drive-backed file
```

The key question is:

> Why can Jellyfin list Telegram files but cannot play them?

Do not assume the answer.

Find the actual root cause from the code.

---

# 3. Trace a Working Google Drive Playback

Trace the complete request lifecycle for a Google Drive-backed media file:

```text
Jellyfin
    ↓
PROPFIND
    ↓
file discovery
    ↓
GET / HEAD
    ↓
Range request?
    ↓
9Drive file
    ↓
Google Drive provider
    ↓
stream
    ↓
Jellyfin
```

Document:

- exact WebDAV handler
- exact service
- exact provider method
- HTTP status
- headers
- streaming behavior
- range behavior
- content length
- MIME type

This is the known-good reference implementation.

---

# 4. Trace Telegram Playback

Perform the same analysis for a Telegram-backed file:

```text
Jellyfin
    ↓
PROPFIND
    ↓
file discovery
    ↓
GET / HEAD
    ↓
Range request?
    ↓
9Drive file
    ↓
Telegram provider
    ↓
Telegram download
    ↓
WebDAV response
    ↓
Jellyfin
```

Compare it directly against Google Drive.

Identify exactly where the behavior differs.

---

# 5. Jellyfin-Compatible GET

Audit whether Telegram Drive correctly supports:

```http
GET /webdav/Movies/movie.mkv
```

and especially requests containing:

```http
Range: bytes=...
```

Jellyfin commonly needs efficient seeking/range access for media playback.

Determine whether the Telegram provider currently:

```text
supports streaming
supports range
supports partial reads
supports seeking
requires full download
uses temporary files
buffers the entire file
```

Do not implement until the current behavior is understood.

---

# 6. HTTP Range Support

This is a critical investigation.

Test/inspect requests such as:

```http
Range: bytes=0-1048575
```

Expected WebDAV response when range support exists:

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1048575/TOTAL_SIZE
Accept-Ranges: bytes
Content-Length: 1048576
```

Determine whether the existing Google Drive provider supports this.

Then determine whether Telegram provider does.

If Google Drive already has a working range implementation, reuse the same WebDAV abstraction.

Do not add Telegram-specific range handling inside the WebDAV controller unless absolutely necessary.

---

# 7. HEAD Behavior

Inspect:

```http
HEAD /webdav/Movies/movie.mkv
```

Compare Google Drive vs Telegram.

Verify:

```text
Content-Length
Content-Type
Last-Modified
ETag
Accept-Ranges
```

Jellyfin must be able to determine media metadata without downloading the entire file.

---

# 8. Content-Length

Telegram-backed files must return a reliable file size.

Example:

```http
Content-Length: 123456789
```

Do not omit `Content-Length` if the Telegram provider already knows the file size.

Do not calculate size by downloading the entire file.

---

# 9. Content-Type

Verify Telegram-backed media returns an appropriate:

```http
Content-Type
```

For example:

```text
video/mp4
video/x-matroska
video/webm
audio/mpeg
```

Use the existing 9Drive MIME abstraction if available.

Do not introduce Telegram-specific MIME detection into the WebDAV controller.

---

# 10. Streaming

Inspect whether the Telegram provider can expose a stream.

Preferred architecture:

```text
WebDAV GET
    ↓
9Drive FileService
    ↓
Telegram Provider
    ↓
Telegram download stream
    ↓
WebDAV response
```

Avoid:

```text
Telegram
    ↓
download entire 10GB file
    ↓
PHP/application memory
    ↓
WebDAV
```

Large media files must not unnecessarily consume application memory.

---

# 11. Temporary File Strategy

If Telegram's SDK/library cannot efficiently provide a seekable stream:

determine whether the existing architecture should use:

```text
Telegram
    ↓
temporary file
    ↓
range/stream WebDAV
```

instead.

Do not automatically implement this.

First determine what the Telegram provider already supports.

Document:

```text
current strategy
recommended strategy
reason
trade-offs
```

---

# 12. Range + Telegram Limitation

Investigate whether Telegram downloads support efficient random access.

Jellyfin may request different byte ranges during playback/seeking.

Determine whether the current Telegram provider can satisfy:

```text
Range 0-...
Range N-...
Range ...
```

without downloading the entire file repeatedly.

If Telegram requires sequential downloading, design an appropriate caching/temp-file strategy.

Do not implement repeated full Telegram downloads for every Jellyfin range request.

---

# 13. Response Header Comparison

Create a comparison table from an actual working request:

| Header | Google Drive | Telegram | Expected |
|---|---|---|---|
| Status | ? | ? | ? |
| Content-Length | ? | ? | required |
| Content-Type | ? | ? | correct MIME |
| Accept-Ranges | ? | ? | range support |
| Content-Range | ? | ? | for 206 |
| Last-Modified | ? | ? | consistent |
| ETag | ? | ? | consistent |
| Transfer-Encoding | ? | ? | appropriate |

Use actual implementation evidence.

---

# 14. Status Code Comparison

Compare Google Drive and Telegram responses:

```text
200
206
304
404
416
500
502
503
```

Determine whether Telegram playback fails because it returns an incorrect status code.

In particular inspect:

```text
Range request
    ↓
expected 206
actual ?
```

Also inspect invalid ranges:

```text
416 Range Not Satisfiable
```

where appropriate.

---

# 15. WebDAV PROPFIND

Do not change listing behavior unnecessarily.

Verify Telegram files already expose correct:

```text
filename
size
MIME
modified time
collection=false
```

Since Jellyfin can already see the Telegram files, preserve the existing successful PROPFIND behavior.

Focus changes on playback/streaming.

---

# 16. File Identity

Do not make WebDAV depend on Telegram message IDs directly.

The logical flow remains:

```text
WebDAV path
    ↓
9Drive file
    ↓
storage provider
    ↓
Telegram message/file
```

The provider resolves the physical Telegram object.

---

# 17. Telegram Metadata

Keep the existing canonical metadata:

```text
9drive:id=<9Drive file ID>
9drive:path=<complete 9Drive virtual path>
```

Do not change this format as part of the WebDAV playback fix.

---

# 18. Telegram File Mapping

Verify that the 9Drive file contains enough information to locate the physical Telegram object.

Determine:

```text
9Drive file ID
Telegram channel ID
Telegram message ID
Telegram file ID
provider remote ID
file size
MIME
```

If the mapping is already correct, do not redesign it.

---

# 19. Deleted Telegram File

Determine behavior when:

```text
9Drive file exists
Telegram physical message/file no longer exists
```

WebDAV should return an appropriate not-found/provider error.

Do not return:

```text
200 OK
```

with an empty stream.

---

# 20. Telegram Authentication Failure

Determine how WebDAV responds if Telegram authentication/session is unavailable.

Do not expose Telegram credentials or raw sensitive provider errors.

Map the provider error to an appropriate HTTP response.

---

# 21. Telegram Rate Limits

Determine whether Telegram rate limits can affect WebDAV playback.

The implementation should avoid making unnecessary duplicate Telegram requests.

Inspect:

```text
Jellyfin metadata requests
HEAD
GET
Range
repeated seeking
```

Do not add aggressive retry loops.

---

# 22. Jellyfin-Specific Compatibility

The final implementation must support typical Jellyfin media access patterns.

Investigate:

```text
directory discovery
file metadata
HEAD
GET
Range GET
seeking
resume playback
multiple range requests
large files
```

Do not hardcode Jellyfin-specific behavior into the provider unless absolutely necessary.

Make the underlying WebDAV/provider implementation standards-compliant.

---

# 23. rclone Compatibility

Existing WebDAV is also used by rclone.

After fixing Telegram playback, verify that:

```bash
rclone ls 9drive:/
rclone copy 9drive:/Movies/movie.mkv .
```

still works.

Do not break existing Google Drive behavior.

---

# 24. Google Drive Regression

The fix must preserve:

```text
Google Drive listing
Google Drive download
Google Drive WebDAV
Jellyfin Google Drive playback
rclone Google Drive access
```

No regression is acceptable.

---

# 25. Architecture Rule

Do NOT implement:

```text
if Telegram:
    special WebDAV controller
```

Prefer:

```text
WebDAV
    ↓
9Drive FileService
    ↓
Storage Provider Interface
    ↓
Telegram Provider
```

Provider-specific behavior belongs inside the provider/storage abstraction.

---

# 26. Testing

Create/update tests for:

## Telegram HEAD

```http
HEAD /webdav/path/file.mkv
```

Verify:

```text
200
Content-Length
Content-Type
```

## Telegram Full GET

```http
GET /webdav/path/file.mkv
```

Verify:

```text
200
correct file bytes
correct length
```

## Telegram Range GET

```http
Range: bytes=0-1048575
```

Verify:

```text
206
Content-Range
Content-Length
correct bytes
```

## Multiple Ranges / Seeking

Simulate several non-overlapping range requests.

Verify no incorrect full-file restart occurs.

## Large File

Verify memory usage does not scale with entire file size unnecessarily.

## Missing Telegram Object

Verify appropriate HTTP error.

## Telegram Provider Error

Verify safe HTTP error mapping.

## Google Drive Regression

Run existing WebDAV tests.

---

# 27. Integration Test

Create a realistic end-to-end test:

```text
Telegram-backed video
    ↓
9Drive virtual path
    ↓
WebDAV
    ↓
HTTP GET
    ↓
Range GET
```

Verify the returned bytes against the known Telegram file.

If possible, use a small deterministic media fixture.

---

# 28. Manual Jellyfin Verification

After implementation, verify:

1. Add the existing WebDAV endpoint to Jellyfin.
2. Browse Telegram-backed folder.
3. Open a Telegram-backed video.
4. Start playback.
5. Seek forward.
6. Seek backward.
7. Resume playback.
8. Verify large-file playback.
9. Verify Google Drive playback still works.

Do not use Playwright for this.

---

# 29. Execution Workflow

## Phase 1 — Plan

Audit existing WebDAV and compare:

```text
Google Drive
vs
Telegram Drive
```

Produce:

```text
Current WebDAV flow
Telegram playback flow
Google Drive playback flow
Exact difference
Root cause
Minimal fix
```

Do not implement before the plan is clear.

## Phase 2 — Implement

Implement only the required changes.

Prefer changes in:

```text
Storage Provider
Telegram Provider
Streaming abstraction
Range abstraction
```

rather than WebDAV-specific Telegram branching.

## Phase 3 — Test

Run:

- existing WebDAV tests
- Telegram provider tests
- range tests
- streaming tests
- integration tests
- type checks
- lint

## Phase 4 — Manual Verification

Verify with Jellyfin:

```text
browse
play
seek
resume
```

and verify rclone.

## Phase 5 — Documentation

Update:

```text
docs/implementation/telegram-drive.md
```

and the WebDAV documentation.

Document that WebDAV supports both:

```text
Google Drive
Telegram Drive
```

when configured.

---

# 30. Documentation Update

The existing documentation currently says:

```text
9Drive exposes its database-backed virtual filesystem over a read-only WebDAV endpoint.
```

Keep that concept.

Update it only as necessary to explain that the virtual filesystem can expose files backed by supported storage providers, including Telegram Drive.

Do not document Telegram physical channel/message structure to WebDAV users.

---

# 31. Important Constraints

Do NOT:

- create a second WebDAV server
- create Telegram-specific WebDAV routes
- expose Telegram message IDs in WebDAV paths
- expose Telegram channels as folders
- change `9drive:id`
- change `9drive:path`
- invent Telegram quota/available storage
- download the entire large file into application memory unnecessarily
- break Google Drive WebDAV
- modify `references/teledrive`
- copy Teledrive source code
- use Playwright

---

# 32. Final Deliverables

Create/update:

```text
docs/audits/telegram-webdav-jellyfin-playback-audit.md
```

and after implementation:

```text
docs/implementation/telegram-drive.md
```

The audit must clearly state:

```text
Why Jellyfin can see Telegram files
Why Jellyfin cannot currently play them
Which HTTP request fails
Which response/header/streaming behavior is incorrect
Where the bug exists
What the minimal architectural fix is
```

---

# 33. Final Terminal Summary

Print:

```text
Telegram Drive WebDAV Playback

WebDAV Listing:
PASS / ISSUE

PROPFIND:
PASS / ISSUE

HEAD:
PASS / ISSUE

Full GET:
PASS / ISSUE

Range GET:
PASS / ISSUE

Streaming:
PASS / ISSUE

Content-Length:
PASS / ISSUE

Content-Type:
PASS / ISSUE

Jellyfin Playback:
PASS / ISSUE

Jellyfin Seeking:
PASS / ISSUE

rclone:
PASS / ISSUE

Google Drive Regression:
PASS / ISSUE

Overall:
HEALTHY / NEEDS FIX

Root Cause:
...

Fix:
...

Tests:
...
```

The key acceptance criterion is:

```text
Jellyfin
    ↓
existing 9Drive WebDAV
    ↓
Telegram-backed video
    ↓
playback works
    ↓
seeking works
```

while the existing Google Drive WebDAV behavior continues to work.
