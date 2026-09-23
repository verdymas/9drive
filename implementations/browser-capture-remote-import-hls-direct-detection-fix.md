# Browser Capture → Remote Import — Fix HLS vs Direct Media Detection, Request Context Propagation, and Safe Fallback

## Goal

Fix Remote Import failures like:

```text
HLS_INVALID_MANIFEST
The source is not a valid HLS playlist.
```

when the same captured resource can be downloaded normally in the browser.

Current symptom:

```text
Browser Capture
    ↓
resource captured
    ↓
Remote Import classifies source as HLS
    ↓
worker tries to parse manifest
    ↓
HLS_INVALID_MANIFEST
```

This task must focus only on the source-classification / initial fetch / request-context path.

Do NOT rewrite unrelated Remote Import, Telegram, WebDAV, Browser Capture UI, or FFmpeg logic.

Do NOT use Playwright.

---

# 1. Audit First

Trace the exact current flow:

```text
Browser Capture
    ↓
captured resource
    ↓
resource classification
    ↓
Remote Import API payload
    ↓
queue/job payload
    ↓
worker
    ↓
initial fetch/probe
    ↓
HLS detector
    ↓
HLS parser
```

Find exact files/functions responsible for:

```text
captured.type
sourceType/resourceType
HLS detection
manifest fetch
request-context propagation
redirect handling
Content-Type inspection
manifest parsing
direct-download fallback
```

Prove the exact decision path that currently produces `HLS_INVALID_MANIFEST`.

---

# 2. Browser Capture Type Is Only a Hint

The extension may send:

```json
{ "type": "hls" }
```

but this must NOT be treated as authoritative.

Likewise these are only HLS hints:

```text
URL ends with .m3u8
URL contains m3u8-like query/path
captured.type === hls
```

The worker must validate the actual fetched response before choosing the HLS pipeline.

---

# 3. Centralize Content-Aware Classification

Create/reuse one centralized classification abstraction such as:

```text
RemoteSourceClassifier
```

or the closest equivalent that matches existing project conventions.

Conceptual flow:

```text
captured resource
      ↓
fetch/probe using selected transport + request context
      ↓
inspect:
- HTTP status
- final URL after allowed redirects
- Content-Type
- Content-Disposition
- first bytes / first text
      ↓
classify actual payload
```

Do not spread final source classification across the extension, controller, queue producer, worker, and HLS parser.

---

# 4. HLS Detection Rules

Use strong evidence.

Recommended priority:

```text
1. Response body starts with #EXTM3U
   → confirmed HLS

2. HLS MIME type:
   application/vnd.apple.mpegurl
   application/x-mpegURL
   audio/mpegurl
   audio/x-mpegurl
   → candidate HLS, still validate #EXTM3U

3. final/original URL ending in .m3u8
   → candidate only

4. Browser Capture type=hls
   → candidate only
```

A valid HLS playlist should begin with `#EXTM3U`, allowing a UTF-8 BOM and only safe normalization if needed.

Do not accept arbitrary text solely because MIME says HLS.

---

# 5. Direct Media Reclassification

If the actual response is clearly direct media, reclassify it rather than throwing `HLS_INVALID_MANIFEST`.

Examples:

```http
Content-Type: video/mp4
Content-Type: video/webm
Content-Type: video/x-matroska
Content-Type: audio/mpeg
Content-Type: audio/mp4
```

or an already-supported strong binary media signature.

Example:

```text
captured type = hls
URL = https://cdn.example.com/55234234e.vid
actual response Content-Type = video/mp4
body = MP4 binary
```

Expected:

```text
HLS candidate
    ↓
not #EXTM3U
    ↓
clear direct video
    ↓
DIRECT_VIDEO
    ↓
normal direct Remote Import pipeline
```

Do NOT invoke the HLS parser in this case.

---

# 6. Safe Fallback Only

If HLS validation fails:

```text
HLS candidate
    ↓
fetch/probe
    ↓
starts with #EXTM3U?
    ├── YES → HLS pipeline
    └── NO
          ↓
      clearly direct media?
          ├── YES → direct pipeline
          └── NO  → real source/HLS error
```

Never fallback to direct media for:

```text
401
403
text/html
application/json error
Cloudflare/challenge page
login page
plain-text error response
```

Otherwise the worker could accidentally save an error page as a media file.

---

# 7. Request Context Must Apply From the FIRST Probe

The existing Browser Capture / Remote Import system already supports request context such as:

```text
Referer
Origin
User-Agent
Cookie
Authorization
```

or the project's safe allowlisted equivalent.

The initial HLS/direct classification request MUST use the same request context.

Wrong:

```text
probe without context
    ↓
parse fails
    ↓
context only used later for segments
```

Correct:

```text
Browser Capture
    ↓
URL + Request Context
    ↓
Remote Import
    ↓
selected Direct / Worker transport
    ↓
FIRST probe WITH same context
    ↓
actual payload classification
```

Reuse the existing secure fetcher and request-context abstraction.

Do not introduce another ad-hoc HTTP client.

---

# 8. Redirect-Aware Classification

Classification must use the FINAL response after allowed redirects.

Example:

```text
original:
https://site.example/master.m3u8

302
 ↓

final:
https://cdn.example/55234234e.vid

Content-Type: video/mp4
```

Expected:

```text
DIRECT_VIDEO
```

not HLS.

Preserve all existing SSRF and redirect security rules.

---

# 9. Selected Transport Must Be Used From First Probe

Remote Import can use transports such as:

```text
Direct
Worker
```

The actual classification probe must use the selected transport from the first request.

Do NOT do:

```text
Direct probe
    ↓
classification
    ↓
Worker download
```

when Direct and Worker can receive different responses due to:

```text
IP
headers
cookies
anti-bot behavior
```

No silent Direct fallback when Worker was explicitly selected.

---

# 10. Diagnostic Logging Before HLS_INVALID_MANIFEST

Add safe structured diagnostics before throwing the error.

Example:

```text
[remote-import-source-probe]
jobId=...
capturedType=hls
selectedTransport=direct|worker
originalUrl=<redacted>
finalUrl=<redacted>
status=200
contentType=video/mp4
contentLength=...
bodyKind=binary
startsWithExtM3u=false
classification=DIRECT_VIDEO
```

Failed example:

```text
status=403
contentType=text/html
bodyKind=text
startsWithExtM3u=false
classification=ERROR_RESPONSE
```

A short textual preview may be logged only if safe, for example:

```text
preview="<html>Access denied..."
```

Never log:

```text
Cookie
Authorization
full signed query strings
session tokens
secret headers
```

---

# 11. Improve Error Differentiation

Do not use `HLS_INVALID_MANIFEST` for every non-HLS response.

Introduce/reuse clearer internal errors where appropriate:

```text
REMOTE_SOURCE_HTTP_ERROR
REMOTE_SOURCE_AUTH_REQUIRED
REMOTE_SOURCE_UNEXPECTED_HTML
REMOTE_SOURCE_UNSUPPORTED_TYPE
HLS_INVALID_MANIFEST
```

Preserve public API compatibility if existing clients depend on it, but retain the true internal root cause.

---

# 12. Preserve Canonical Filename During Reclassification

Reclassification must NOT reset filename back to URL basename.

Example:

```text
media/page title:
video bagus

resource URL:
https://cdn.example.com/55234234e.vid

actual MIME:
video/mp4
```

Expected final name:

```text
video bagus.mp4
```

not:

```text
55234234e.vid
```

Preserve existing priority of:

```text
customFilename
suggestedFilename
canonicalFilename
```

Downstream components must not overwrite a valid canonical filename with:

```text
URL basename
temporary worker filename
FFmpeg temp output
storage object key
Telegram physical filename
```

---

# 13. Resolve Stem and Extension Separately

When:

```text
stem source = video bagus
URL extension = .vid
Content-Type = video/mp4
```

expected:

```text
video bagus.mp4
```

Treat weak/technical extensions such as:

```text
.vid
.bin
.dat
.blob
.tmp
```

as lower-confidence than a strong detected media MIME.

Do not globally rewrite extensions without evidence.

---

# 14. Do Not Break Real HLS

Real HLS must continue through the existing HLS implementation.

Example:

```text
Content-Type = application/vnd.apple.mpegurl
body starts with #EXTM3U
```

Expected:

```text
existing HLS pipeline
```

Preserve support for current functionality including where applicable:

```text
master playlists
media playlists
variant selection
audio renditions
EXT-X-MAP
byte ranges
AES-128
segment validation
remux
```

Do not rewrite FFmpeg/remux in this task.

---

# 15. Preserve HLS Child Request Context

Once a source is confirmed HLS, existing context propagation must remain valid for:

```text
master playlist
variant playlist
audio playlist
segments
EXT-X-MAP resources
AES-128 keys
```

Use the existing safe context propagation rules.

---

# 16. Required Tests — Misclassified Direct Video

Test:

```text
capturedType = hls
URL = https://cdn.example/55234234e.vid
Content-Type = video/mp4
body = valid MP4 bytes
```

Expected:

```text
classification = DIRECT_VIDEO
HLS parser not called
direct pipeline selected
```

---

# 17. Required Tests — .m3u8 Redirects to Direct Video

Input:

```text
/master.m3u8
302 → /video/file.bin
final Content-Type = video/mp4
```

Expected:

```text
DIRECT_VIDEO
```

---

# 18. Required Tests — Valid HLS

Input:

```text
Content-Type = application/vnd.apple.mpegurl
body starts with #EXTM3U
```

Expected:

```text
HLS
```

---

# 19. Required Tests — HTML/Auth Failure

Input:

```text
status = 403 or 200
Content-Type = text/html
body = login/access denied/challenge page
```

Expected:

```text
no direct fallback
no FFmpeg
clear source/auth error
```

---

# 20. Required Tests — Request Context

Mock a source that returns:

```text
403 without required Referer/Cookie
200 + #EXTM3U with captured request context
```

Expected:

```text
initial probe uses request context
HLS detection succeeds
```

---

# 21. Required Tests — Worker Path

If Worker transport is selected, verify:

```text
classification probe
manifest request
child requests
```

use the selected Worker route according to existing architecture.

No hidden Direct probe first.

---

# 22. Required Tests — Filename Preservation

Input:

```text
mediaTitle = video bagus
capturedType = hls
actual payload = video/mp4
URL basename = 55234234e.vid
```

Expected:

```text
canonical filename = video bagus.mp4
```

Verify it remains unchanged through:

```text
job payload
worker
destination upload
File.name
```

---

# 23. Required Tests — No False Direct Fallback

Input:

```text
capturedType = hls
status = 200
Content-Type = text/html
body = <html>challenge</html>
```

Expected:

```text
ERROR
```

not:

```text
DIRECT_VIDEO
```

---

# 24. Classification Evidence

Where useful, keep safe non-sensitive classification evidence in memory/logging.

Conceptually:

```json
{
  "kind": "direct-video",
  "evidence": {
    "capturedHint": "hls",
    "finalContentType": "video/mp4",
    "urlExtension": ".vid",
    "startsWithExtM3u": false
  }
}
```

Do not persist unnecessary sensitive network details.

---

# 25. Expected Fixed Flow

The failing case should become:

```text
Browser Capture
  type=hls
  title=video bagus
  URL=.../55234234e.vid
  request context=...
        ↓
Remote Import
        ↓
initial fetch using same request context
and selected transport
        ↓
status=200
Content-Type=video/mp4
not #EXTM3U
        ↓
reclassify DIRECT_VIDEO
        ↓
canonical filename=video bagus.mp4
        ↓
normal direct download pipeline
        ↓
upload destination
        ↓
File.name=video bagus.mp4
```

No `HLS_INVALID_MANIFEST` for this case.

---

# 26. Real HLS Acceptance Flow

```text
Browser Capture
  type=hls
  URL=.../master.m3u8
  context=...
        ↓
probe using selected transport + context
        ↓
#EXTM3U confirmed
        ↓
existing HLS pipeline
        ↓
remux
        ↓
canonical filename stem preserved
```

---

# 27. Manual Verification

Do NOT use Playwright.

Manually verify at least:

```text
1. Known valid HLS source
2. Captured HLS hint that is actually video/mp4
3. Source requiring Referer/Origin/User-Agent/Cookie
4. Redirecting media URL
5. Worker-selected import if configured
```

Record safe worker logs showing classification evidence.

---

# 28. Required Documentation

Create/update:

```text
docs/audits/remote-import-source-classification-fix.md
```

Document:

```text
root cause
old decision flow
new decision flow
request-context propagation
redirect behavior
safe direct fallback rules
filename behavior
tests/manual verification
```

---

# 29. Scope Restrictions

Do NOT:

- rewrite FFmpeg/remux pipeline
- change HLS output container behavior
- rewrite Browser Capture UI
- modify Telegram Drive
- modify WebDAV
- modify telegram-stream
- change storage-provider architecture
- disable/weaken SSRF checks
- weaken header allowlists
- log cookies/auth/session tokens
- fallback HTML/error responses to direct media
- use URL suffix as authoritative source type
- use Playwright

---

# 30. Final Terminal Summary

Print:

```text
Remote Import Source Classification Fix

Original Failure:
HLS_INVALID_MANIFEST

Root Cause:
...

Captured Type:
...

Actual Response Type:
...

Request Context Applied on Initial Probe:
YES / NO

Selected Transport Used From Initial Probe:
YES / NO

Redirect-Aware Classification:
PASS / FAIL

HLS Validation:
PASS / FAIL

Direct Media Reclassification:
PASS / FAIL

HTML/Error Safe Rejection:
PASS / FAIL

Worker Path:
PASS / FAIL / N/A

Filename Preservation:
PASS / FAIL

Expected Example:
video bagus.mp4

Real HLS Regression:
PASS / FAIL

Direct Import Regression:
PASS / FAIL

Tests:
...

Overall:
FIXED / NEEDS MORE WORK
```

The core rule is:

```text
Browser Capture source type is only a hint.
The actual fetched response, using the selected transport and captured request context, determines the final Remote Import pipeline.
```
