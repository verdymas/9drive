# Telegram Drive WebDAV — Audit Existing 9Drive Using `tgfs` + `Telegram-Drive` References

## Objective

Audit the existing 9Drive read-only WebDAV implementation and identify why:

```text
Telegram-backed files
    ↓
appear correctly in Jellyfin
    ↓
but cannot be played / seeked
```

Then produce a concrete implementation plan for fixing Telegram Drive WebDAV playback by comparing the current 9Drive implementation with these read-only reference projects:

```text
references/tgfs
references/Telegram-Drive
references/teledrive
```

Reference repositories:

```text
https://github.com/TheodoreKrypton/tgfs.git
https://github.com/caamer20/Telegram-Drive.git
https://github.com/99apps-id/teledrive.git
```

Priority of references for this task:

```text
1. references/tgfs
2. references/Telegram-Drive
3. existing working Google Drive WebDAV implementation in 9Drive
4. references/teledrive
```

This task should start with an AUDIT and PLAN.

Only after the root cause is proven should the implementation be changed.

Do not blindly copy external source code.

---

# 1. Existing 9Drive WebDAV Context

9Drive already exposes a read-only WebDAV endpoint:

```text
http://<host>:4000/webdav
```

Authentication currently uses:

```env
WEBDAV_PASSWORD=...
```

with HTTP Basic Auth.

The WebDAV layer exposes the database-backed 9Drive virtual filesystem.

Existing behavior:

```text
Google Drive-backed file:
- visible in Jellyfin
- playable in Jellyfin
- WebDAV works

Telegram Drive-backed file:
- visible in Jellyfin
- PROPFIND/listing works
- playback fails
```

Do NOT create another WebDAV server.

Extend/fix the existing WebDAV architecture.

---

# 2. Clone References If Missing

If these reference folders are not already present:

```text
references/tgfs
references/Telegram-Drive
references/teledrive
```

clone them:

```bash
mkdir -p references

git clone https://github.com/TheodoreKrypton/tgfs.git \
  references/tgfs

git clone https://github.com/caamer20/Telegram-Drive.git \
  references/Telegram-Drive

git clone https://github.com/99apps-id/teledrive.git \
  references/teledrive
```

Rules:

```text
READ ONLY
DO NOT MODIFY
DO NOT ADD AS A DEPENDENCY
DO NOT COPY SOURCE BLINDLY
```

They are architectural references only.

---

# 3. Target Architecture

The intended architecture remains:

```text
Jellyfin / rclone
      ↓
Existing 9Drive WebDAV
      ↓
9Drive Virtual Filesystem
      ↓
Storage Provider Abstraction
      ↓
Telegram Provider
      ↓
Telegram MTProto storage
```

WebDAV must remain provider-agnostic.

Do NOT expose:

```text
Telegram channel IDs
Telegram message IDs
Telegram physical filenames
```

as WebDAV paths.

The 9Drive database remains the logical filesystem.

---

# 4. Primary Investigation Question

Find the exact answer to:

> Why can Jellyfin browse Telegram-backed files but not play them?

Do not assume the answer is range support until verified.

Investigate the actual request/response behavior.

Compare:

```text
Google Drive WebDAV
vs
Telegram Drive WebDAV
```

for the same type of media file.

---

# 5. Audit Existing WebDAV Request Flow

Locate the existing WebDAV implementation.

Trace:

```text
HTTP/WebDAV request
      ↓
WebDAV handler
      ↓
virtual path resolver
      ↓
9Drive file record
      ↓
storage provider
      ↓
stream/range
      ↓
HTTP response
```

For every stage document:

```text
file
class
function
responsibility
```

Audit:

```text
PROPFIND
HEAD
GET
Range GET
OPTIONS
```

Focus on read-only playback behavior.

---

# 6. Working Google Drive Baseline

Use Google Drive-backed files as the known-good implementation.

Trace:

```text
Jellyfin
    ↓
HEAD
    ↓
GET
    ↓
Range GET
    ↓
Google Drive provider
    ↓
stream
```

Record:

```text
status code
Content-Length
Content-Type
Accept-Ranges
Content-Range
Last-Modified
ETag
Transfer-Encoding
stream behavior
provider API call
requested byte start
requested byte end
actual returned bytes
```

This becomes the baseline.

---

# 7. Telegram Playback Trace

Run the same audit for a Telegram-backed media file.

Trace:

```text
Jellyfin
    ↓
HEAD /webdav/...
    ↓
GET /webdav/...
    ↓
Range GET /webdav/...
    ↓
Telegram provider
    ↓
Telegram MTProto download
    ↓
response
```

Compare it directly with Google Drive.

Identify exactly where the behavior differs.

---

# 8. `tgfs` Reference — Main Focus

Study:

```text
references/tgfs
```

specifically its WebDAV/resource abstraction and Telegram download implementation.

Identify how it models range-based resource reads, for example conceptually:

```text
get_content(begin, end)
```

or its equivalent.

Study how it translates:

```http
Range: bytes=<start>-<end>
```

into:

```text
Telegram download offset
requested byte count
stream termination
```

The important concept to evaluate for 9Drive is:

```text
WebDAV Range
      ↓
begin / end
      ↓
Telegram MTProto download
      ↓
offset = begin
      ↓
stream only requested bytes
      ↓
206 Partial Content
```

Do not copy code directly.

Extract the architecture/pattern.

---

# 9. `Telegram-Drive` Reference

Study:

```text
references/Telegram-Drive
```

Focus on:

```text
WebDAV serving
range reads
large file streaming
media seeking
Accept-Ranges
Content-Range
status handling
read-only mode
Telegram file access
```

Identify how the project avoids full-file download for random media access.

Also inspect any handling for:

```text
HEAD
GET
206
416
client disconnect
stream cancellation
```

Again:

```text
REFERENCE ONLY
```

Do not port the project architecture wholesale.

---

# 10. `teledrive` Reference

Use:

```text
references/teledrive
```

only for Telegram-specific behavior such as:

```text
Telethon/MTProto file download
message identity
channel identity
session reuse
iter_download
large file handling
```

Do not use Teledrive's filesystem architecture as the 9Drive architecture.

---

# 11. Range Support Audit

This is the highest-priority technical comparison.

Inspect how 9Drive handles:

```http
Range: bytes=0-1048575
```

Expected response:

```http
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-1048575/TOTAL_SIZE
Content-Length: 1048576
```

Also test/inspect:

```http
Range: bytes=1000000-
Range: bytes=1000000-1999999
```

Determine:

```text
Does Google Drive return 206?
Does Telegram return 206?
Does Telegram return the correct bytes?
Does Telegram start at the requested offset?
Does Telegram stop at the requested end?
```

---

# 12. Telegram Offset Streaming

Audit the current Telegram provider.

Determine whether it can do something equivalent to:

```text
readRange(message, start, end)
```

or:

```text
iter_download(media, offset=start)
```

with a bounded returned byte count.

The desired behavior is conceptually:

```text
requested:
bytes 1000000-1999999

Telegram provider:
offset = 1000000
length = 1000000

WebDAV:
206 Partial Content
```

Do NOT implement:

```text
download whole file from byte 0
discard first N bytes
return requested range
```

for every seek request.

---

# 13. Storage Provider Abstraction

Audit the current 9Drive storage provider interface.

Determine whether it already supports:

```text
stream
range
start/end
offset
length
```

If not, propose the smallest provider-agnostic extension.

Conceptually:

```ts
interface StorageProvider {
  getMetadata(...): Promise<FileMetadata>;

  createReadStream(...): Promise<Readable>;

  createRangeStream(
    file,
    start,
    end?
  ): Promise<{
    stream;
    start;
    end;
    totalSize;
  }>;
}
```

Do NOT force this exact interface if the existing architecture has a better abstraction.

The key rule:

```text
WebDAV should ask the provider for a range stream
```

rather than:

```text
WebDAV knows Telegram internals
```

---

# 14. No Telegram-Specific WebDAV Branching

Avoid architecture like:

```ts
if (provider === "telegram") {
  // Telegram WebDAV implementation
}
```

inside generic WebDAV handlers.

Prefer:

```text
WebDAV
    ↓
generic StorageProvider range/read API
    ↓
Google Drive implementation
Telegram implementation
```

Provider-specific transport logic belongs inside the provider.

---

# 15. HEAD Audit

Compare:

```http
HEAD /webdav/path/movie.mkv
```

for Google Drive and Telegram.

Verify:

```text
200 OK
Content-Length
Content-Type
Accept-Ranges
Last-Modified
ETag
```

where appropriate.

Jellyfin should not need to download the file to obtain basic metadata.

---

# 16. Content-Length

Telegram-backed files already exist in the 9Drive database.

Determine whether known size is available without contacting Telegram.

Prefer:

```text
DB metadata
```

for:

```http
Content-Length
```

where reliable.

Do not download the entire file to calculate size.

---

# 17. Content-Type

Use existing 9Drive logical metadata.

Do not rely on the Telegram physical filename.

This becomes especially important if Telegram physical filenames are later obfuscated.

Example:

```text
Telegram physical:
tg_aabbcc.bin

9Drive logical:
movie.mkv

WebDAV Content-Type:
video/x-matroska
```

Use the generic MIME abstraction.

---

# 18. Client Abort / Stream Cancellation

Jellyfin may cancel a stream after seeking.

Audit what happens when:

```text
client disconnects
request aborted
range request superseded
```

The Telegram download stream should stop/cancel when possible.

Avoid continuing to download a large file after the WebDAV client has disconnected.

Study reference behavior where useful.

---

# 19. Sequential vs Random Access

Determine whether the Telegram library currently used by 9Drive supports efficient offset reads.

Document:

```text
library
method
offset semantics
chunk size
alignment constraints
random access support
known limitations
```

Do not assume arbitrary offsets are free.

If alignment is required, design safe range handling that still returns exactly the requested HTTP bytes.

---

# 20. Chunk Alignment

If Telegram/MTProto download requires aligned offsets/chunk sizes:

```text
requested range
      ↓
aligned Telegram request
      ↓
trim prefix/suffix
      ↓
exact HTTP range bytes
```

may be acceptable.

Audit the actual library requirements.

Do not return incorrect bytes merely to satisfy Telegram chunk alignment.

---

# 21. Invalid Range

Audit:

```http
Range: bytes=999999999999-
```

for a smaller file.

Expected behavior should be standards-compatible, likely:

```http
416 Range Not Satisfiable
Content-Range: bytes */TOTAL_SIZE
```

Reuse existing Google Drive/WebDAV behavior if already correct.

---

# 22. Open-Ended Range

Support/plan:

```http
Range: bytes=1000000-
```

Expected:

```text
start = 1000000
end = fileSize - 1
```

Do not require an explicit end from Jellyfin.

---

# 23. Suffix Range

Audit whether existing WebDAV supports:

```http
Range: bytes=-65536
```

If existing Google Drive supports it, Telegram should follow the same semantics.

Do not invent different semantics per provider.

---

# 24. Multiple HTTP Ranges

Determine whether the existing WebDAV implementation supports:

```http
Range: bytes=0-100,200-300
```

If not supported, document existing behavior.

Do not expand scope unnecessarily unless Jellyfin/rclone compatibility requires it.

---

# 25. Full GET

Verify:

```http
GET /webdav/path/movie.mkv
```

without Range.

Expected:

```text
200 OK
correct Content-Length
correct Content-Type
stream from Telegram
```

Do not buffer the whole file in memory.

---

# 26. Telegram Physical Identity

WebDAV path resolution should remain:

```text
WebDAV logical path
      ↓
9Drive file
      ↓
Telegram provider mapping
      ↓
channelId + messageId / provider remote ID
      ↓
Telegram file
```

Do not resolve Telegram files by physical filename.

This is important for future encrypted/opaque filenames.

---

# 27. `9drive:id` / `9drive:path` / Encrypted Metadata Compatibility

Do not change Telegram recovery metadata in this WebDAV task.

Current/legacy:

```text
9drive:id=...
9drive:path=...
```

Future encrypted format may become:

```text
9drive:id=...
9drive:meta=v1:...
```

WebDAV normal read paths must not depend on either format.

The DB/provider mapping should already contain everything needed to stream a file.

---

# 28. WebDAV Must Not Decrypt Telegram Metadata

Normal WebDAV playback should use:

```text
DB logical metadata
+
Telegram remote identity
```

Do NOT add:

```text
decrypt Telegram metadata
```

to:

```text
HEAD
GET
Range GET
PROPFIND
Jellyfin seek
```

This preserves performance and separation of concerns.

---

# 29. PROPFIND Regression

Telegram file listing already works.

Preserve that behavior.

Only change PROPFIND if the audit finds incorrect metadata that affects Jellyfin playback.

Do not rewrite directory listing unnecessarily.

---

# 30. rclone Regression

Existing WebDAV supports rclone.

Verify after implementation:

```bash
rclone ls 9drive:/
rclone copy 9drive:/Movies/movie.mkv .
```

for:

```text
Google Drive-backed file
Telegram-backed file
```

---

# 31. Jellyfin Manual Verification

After implementation verify:

```text
1. Library scan
2. File visible
3. Start playback
4. Seek forward
5. Seek backward
6. Resume playback
7. Repeated seeking
8. Large-file playback
```

Also verify a Google Drive-backed media file still works.

Do not use Playwright.

---

# 32. Response Comparison Report

Create a real comparison table:

| Behavior | Google Drive | Telegram Before | Telegram Expected |
|---|---|---|---|
| PROPFIND | ? | ? | ? |
| HEAD status | ? | ? | ? |
| GET status | ? | ? | ? |
| Range status | ? | ? | 206 |
| Content-Length | ? | ? | correct |
| Accept-Ranges | ? | ? | bytes |
| Content-Range | ? | ? | correct |
| MIME | ? | ? | correct |
| Requested offset | ? | ? | forwarded |
| Returned bytes | ? | ? | exact |
| Client abort | ? | ? | stream stops |

Use actual evidence from code/tests/manual HTTP inspection.

---

# 33. Logging for Debugging

Add temporary/safe structured diagnostics where necessary.

Example:

```text
[webdav-read]
fileId=...
provider=telegram
requestRange=1000000-1999999
resolvedStart=1000000
resolvedEnd=1999999
contentLength=1000000
totalSize=...
status=206
```

Telegram provider:

```text
[telegram-range]
fileId=...
messageId=...
offset=1000000
requestedBytes=1000000
returnedBytes=1000000
```

Do NOT log:

```text
Telegram session
API hash
OTP
password
encrypted master key
sensitive auth headers
```

---

# 34. Testing

Add/update tests for:

## Full GET

```text
Telegram-backed file
GET
→ 200
→ correct bytes
```

## HEAD

```text
→ correct Content-Length
→ correct MIME
```

## Range Start

```http
Range: bytes=0-1023
```

Verify exact first 1024 bytes.

## Mid-File Range

```http
Range: bytes=1048576-2097151
```

Verify exact bytes.

## Open-Ended Range

```http
Range: bytes=1048576-
```

## Invalid Range

Verify 416 according to existing WebDAV semantics.

## Multiple Seek Requests

Perform several separate range requests.

Verify each range is correct and does not require a full-file redownload from byte 0.

## Client Abort

If test infrastructure permits, verify underlying stream closes/cancels.

## Google Drive Regression

All existing Google Drive WebDAV tests must continue to pass.

---

# 35. Memory / Performance Validation

Verify that memory consumption does not scale with full media file size.

Avoid:

```text
Buffer.concat(all file chunks)
```

for large WebDAV media reads.

Use streaming/backpressure compatible with the existing Node/Express architecture.

Document the actual stream chain.

---

# 36. Backpressure

Audit:

```text
Telegram stream
    ↓
Node Readable
    ↓
HTTP response
```

Ensure the implementation respects backpressure where possible.

Do not greedily fetch the entire Telegram file while Jellyfin is consuming a small range.

---

# 37. Telegram Session Reuse

Audit whether every WebDAV range request creates a new Telegram session/client.

Prefer reuse of the existing authenticated provider/client lifecycle.

Do not repeatedly perform login/session initialization for every seek.

Document current behavior and recommended changes if needed.

---

# 38. Rate-Limit Behavior

Jellyfin can issue frequent range requests.

Audit:

```text
FloodWait
rate limits
retries
parallel requests
```

Do not use aggressive retries.

Use the existing Telegram provider retry/rate-limit strategy.

---

# 39. Concurrent Jellyfin Requests

Consider:

```text
multiple users
multiple playback streams
metadata probes
parallel ranges
```

Audit whether the Telegram provider supports concurrent reads safely.

Do not introduce global serialization unless required.

---

# 40. Error Mapping

Map Telegram/provider errors to appropriate WebDAV/HTTP responses.

Examples:

```text
missing Telegram message
authentication expired
provider unavailable
FloodWait
timeout
stream failure
```

Do not return:

```text
200 OK
```

with an empty or truncated body.

Do not leak raw sensitive Telegram errors.

---

# 41. Implementation Strategy

After the audit, implement the smallest architectural fix.

Preferred order:

```text
1. Fix/extend provider-agnostic range abstraction
2. Implement Telegram range streaming
3. Reuse generic WebDAV 206 response handling
4. Preserve Google Drive behavior
5. Add tests
6. Verify Jellyfin/rclone
```

Do not rewrite unrelated:

```text
Telegram Sync
Remote Import
Browser Capture
encrypted metadata work
WebDAV auth
folder model
```

unless a direct dependency is proven.

---

# 42. Required Audit Report

Create:

```text
docs/audits/telegram-webdav-range-streaming-audit.md
```

Include:

## A. Executive Summary

State the exact proven reason Jellyfin playback fails.

## B. Existing 9Drive WebDAV Architecture

Show source locations and flow.

## C. Google Drive Known-Good Flow

Document:

```text
HEAD
GET
Range
provider stream
```

## D. Telegram Current Flow

Document the same.

## E. HTTP Comparison

Provide actual headers/status differences.

## F. `tgfs` Reference Findings

Explain:

```text
resource range abstraction
begin/end handling
Telegram offset streaming
```

without copying source code.

## G. `Telegram-Drive` Reference Findings

Explain relevant WebDAV/range patterns.

## H. `teledrive` Findings

Only Telegram transport/session findings relevant to this task.

## I. Root Cause

Be exact.

Bad:

```text
Telegram WebDAV streaming does not work.
```

Good:

```text
The existing WebDAV handler parses Range correctly, but TelegramProvider ignores the requested start offset and opens a full-file stream from byte 0, causing Jellyfin's 206 response body to contain the wrong byte sequence.
```

## J. Recommended Architecture

Show the provider-agnostic range flow.

## K. Implementation Plan

List exact files/services/interfaces to modify.

## L. Risks / Regression

Include Google Drive, rclone, Jellyfin, concurrency, memory, and Telegram rate limits.

---

# 43. Documentation Update

After implementation update relevant WebDAV/Telegram docs.

Document that the existing read-only WebDAV virtual filesystem can stream supported provider-backed files.

Do not expose Telegram implementation details to end users unless necessary.

---

# 44. Important Restrictions

Do NOT:

- create a second WebDAV endpoint
- expose Telegram channels as folders
- expose Telegram message IDs in paths
- copy `tgfs` source into 9Drive
- copy `Telegram-Drive` source into 9Drive
- add either reference repo as dependency
- modify reference repositories
- rewrite the virtual filesystem
- change Telegram metadata format
- add crypto/decrypt to WebDAV read path
- buffer entire large files in memory
- download from byte 0 for every range request if direct offset reads are available
- break Google Drive WebDAV
- use Playwright

---

# 45. Execution Workflow

## Phase 1 — Audit

Inspect:

```text
existing 9Drive WebDAV
Google Drive provider
Telegram provider
references/tgfs
references/Telegram-Drive
references/teledrive
```

Produce the audit report.

## Phase 2 — Plan

State:

```text
root cause
minimal architectural change
provider abstraction change if needed
Telegram range implementation
test strategy
```

## Phase 3 — Implement

Only after root cause is proven.

Implement the smallest correct fix.

## Phase 4 — Test

Run:

```text
backend tests
WebDAV tests
Telegram provider tests
range tests
streaming tests
type checks
lint
```

Do not use Playwright.

## Phase 5 — Manual Verify

Verify with:

```text
curl
rclone
Jellyfin
```

where practical.

## Phase 6 — Report

Update audit/implementation documentation with the actual final behavior.

---

# 46. Acceptance Criteria

Complete only when:

1. Telegram-backed files remain visible through the existing WebDAV endpoint.
2. `HEAD` works for Telegram-backed files.
3. Full `GET` works.
4. HTTP Range requests work.
5. Mid-file ranges return the exact requested bytes.
6. Open-ended ranges work according to existing WebDAV semantics.
7. Valid Range requests return `206 Partial Content`.
8. `Content-Range` is correct.
9. `Content-Length` is correct.
10. `Accept-Ranges: bytes` is correct where supported.
11. Invalid ranges are handled correctly.
12. Telegram reads start at/near the requested offset rather than always from byte 0 when the provider supports it.
13. Large files are streamed without whole-file memory buffering.
14. Client disconnects do not unnecessarily continue large downloads.
15. Jellyfin can start Telegram-backed video playback.
16. Jellyfin can seek forward.
17. Jellyfin can seek backward.
18. Jellyfin resume works.
19. rclone can read/copy Telegram-backed files.
20. Google Drive WebDAV remains unchanged and functional.
21. WebDAV remains provider-agnostic.
22. Telegram physical filename is not exposed as the logical WebDAV filename.
23. WebDAV does not depend on Telegram recovery metadata/decryption.
24. Existing Telegram Sync and Remote Import behavior remain unaffected.
25. Reference repositories remain untouched.
26. No reference source code is blindly copied.
27. Tests and documentation are updated.

---

# 47. Final Terminal Summary

Print:

```text
Telegram WebDAV Range Streaming Audit / Fix

Existing WebDAV:
HEALTHY / NEEDS CHANGES

Google Drive Baseline:
PASS / ISSUE

Telegram PROPFIND:
PASS / ISSUE

Telegram HEAD:
PASS / ISSUE

Telegram Full GET:
PASS / ISSUE

Telegram Range Parse:
PASS / ISSUE

Telegram Offset Read:
PASS / ISSUE

206 Partial Content:
PASS / ISSUE

Content-Range:
PASS / ISSUE

Content-Length:
PASS / ISSUE

Accept-Ranges:
PASS / ISSUE

Streaming:
PASS / ISSUE

Backpressure:
PASS / ISSUE

Client Abort:
PASS / ISSUE

Jellyfin Playback:
PASS / ISSUE

Jellyfin Seek:
PASS / ISSUE

rclone:
PASS / ISSUE

Google Drive Regression:
PASS / ISSUE

Root Cause:
...

tgfs Reference Insight:
...

Telegram-Drive Reference Insight:
...

Architecture Change:
...

Files Changed:
...

Tests:
...

Overall:
HEALTHY / NEEDS MORE WORK
```

The primary audit deliverable is:

```text
docs/audits/telegram-webdav-range-streaming-audit.md
```

The implementation must preserve the existing 9Drive virtual filesystem and use the external projects only as read-only references for Telegram range/streaming behavior.
