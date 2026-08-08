# Claude Code Prompt — Fix Remote Import Probe / HLS Fetch Reliability

You are working inside the existing 9Drive project.

The Remote Import feature already supports direct files and HLS/M3U8, but some
sources intermittently fail during probe/download.

A real failure currently looks like:

```text
[remote-import:probe] <id> HEAD ok status=403 redirects=0
[remote-import:probe] <id> ranged GET ok redirects=0
[remote-import:probe] <id> HLS fetch rejected code=DOWNLOAD_HTTP_ERROR

Invalid input: expected object, received null
```

Your task is to reproduce this exact failure, identify the root cause, and
refactor the Remote Import probe pipeline so direct-file and HLS probes use one
consistent secure HTTP layer.

Do not apply a frontend-only workaround.

Before modifying files, inspect:

- `AGENTS.md`
- `README.md`
- backend/frontend package files
- Docker Compose
- Remote Import routes/controllers/services
- probe endpoint
- direct-file probe logic
- HLS probe logic
- secure fetcher / Undici / fetch wrapper
- SSRF protection
- redirect handling
- URL redaction/safe-display logic
- encrypted/original source URL storage
- filename auto-detection
- HLS parser/fetcher
- frontend API/Zod schemas
- Remote Import modal
- existing tests

Search for:

```text
remote-import
probe
HEAD
Range
bytes=0-0
DOWNLOAD_HTTP_ERROR
HLS fetch
sourceUrl
safeDisplayUrl
redacted
fetch(
undici
redirect
SSRF
nullable
z.object
```

Reproduce the issue first and report a concise root-cause analysis. Then continue
with implementation without waiting for confirmation unless a genuine
repository blocker exists.

---

## 1. Fix HEAD semantics

A HEAD response with HTTP 403 is NOT successful.

Incorrect log:

```text
HEAD ok status=403
```

Correct behavior:

```text
HEAD rejected status=403; falling back to GET
```

Only 2xx HEAD responses count as successful metadata probes.

HEAD 403/405/501 should normally allow fallback probing instead of failing the
entire Remote Import.

Use explicit outcomes such as:

```text
head_success
head_rejected
head_failed
```

---

## 2. Build one shared secure HTTP fetcher

Direct-file probing and HLS probing must use the same secure networking layer.

Refactor toward a shared abstraction equivalent to:

```text
SecureRemoteFetcher
├── head()
├── rangedGet()
├── boundedGet()
├── fetchManifest()
├── fetchSegment()
├── fetchMap()
└── fetchKey()
```

or a generic API:

```ts
secureRequest({
  url,
  method,
  purpose,
  headers,
  maxBytes,
  signal,
})
```

All Remote Import requests must share:

- SSRF validation
- DNS validation
- redirect validation
- timeout rules
- cancellation
- URL preservation
- User-Agent policy
- safe logging/redaction

Do not let HLS probing call a separate raw `fetch()` path that behaves
differently from the successful ranged GET.

---

## 3. Preserve original network URL vs safe display URL

Audit all URL values and separate these concepts clearly:

```text
originalSourceUrl
finalResolvedUrl
safeDisplayUrl
```

Only the original/final network URL may be used for HTTP requests.

A redacted URL must NEVER be used for fetching.

Example:

```text
Network URL:
https://cdn.example.com/master.m3u8?token=SECRET&expires=123

Display URL:
https://cdn.example.com/master.m3u8
```

If URLs are encrypted at rest, decrypt only inside trusted backend/worker code.

Never expose signed query parameters to the frontend.

---

## 4. Preserve signed query parameters

If the user submits:

```text
https://cdn.example.com/master.m3u8?token=ABC&expires=123
```

every request for that same manifest must preserve the full query string.

Do not accidentally refetch:

```text
https://cdn.example.com/master.m3u8
```

Add tests where the server returns 403 when the query token is missing.

Do not log token values.

---

## 5. Stop unnecessary duplicate manifest requests

The current sequence suggests:

```text
HEAD
→ ranged GET succeeds
→ HLS fetch performs another request
→ second request fails
```

If a bounded GET already returned a valid HLS manifest, reuse that exact body.

Preferred architecture:

```text
probe response
→ detect HLS
→ manifest body already available
→ parse it directly
```

Do not refetch the same manifest unless technically necessary.

If a second request is unavoidable, it must reuse the exact secure fetcher,
original URL, signed query, redirect policy, and compatible request profile.

---

## 6. Use an HLS-specific probe strategy

Do not use only:

```http
Range: bytes=0-0
```

to inspect an M3U8 manifest.

Use:

```text
Validate URL + SSRF
        ↓
HEAD
        ↓
2xx?
  ├─ yes → collect metadata
  └─ no  → continue
        ↓
Probable HLS?
  ├─ yes
  │    ↓
  │ bounded GET manifest
  │    ↓
  │ body <= REMOTE_IMPORT_HLS_MAX_MANIFEST_BYTES
  │    ↓
  │ validate #EXTM3U
  │    ↓
  │ parse manifest
  │
  └─ no
       ↓
     ranged GET bytes=0-0
       ↓
     generic file probe
```

Probable HLS signals:

1. Final URL path ends in `.m3u8`
2. HLS-compatible Content-Type
3. Safely read prefix contains `#EXTM3U`
4. Existing source classification already says HLS

Do not rely only on extension.

---

## 7. Bounded manifest GET

For HLS:

```http
GET /manifest.m3u8
```

Read only up to:

```env
REMOTE_IMPORT_HLS_MAX_MANIFEST_BYTES=1048576
```

or the project's existing equivalent.

Requirements:

- stream response
- abort once limit is exceeded
- preserve cancellation
- enforce SSRF on every redirect
- require a successful final HTTP status
- never buffer an unbounded response
- validate HLS content before parsing

---

## 8. Use consistent request profiles

Inspect differences between:

- HEAD
- generic ranged GET
- HLS manifest GET
- segment GET

Use a controlled application request profile.

Manifest example:

```http
User-Agent: 9Drive-Remote-Import/1.0
Accept: application/vnd.apple.mpegurl, application/x-mpegURL, audio/mpegurl, */*
Accept-Encoding: identity
```

Segment example:

```http
Accept: video/*, audio/*, application/octet-stream, */*
```

Do not accept arbitrary user-controlled headers.

Do not add browser cookies, Authorization, Origin, or Referer unless 9Drive
explicitly supports authenticated remote sources.

If a source requires browser session cookies/anti-bot state, return a clear
unsupported authentication error.

---

## 9. Distinguish HEAD 403 from manifest GET 403

HEAD 403:

```text
not fatal by itself
→ fallback to GET
```

Manifest GET 403:

```text
fatal for manifest fetch
→ HLS_MANIFEST_FORBIDDEN
```

Do not collapse both into:

```text
DOWNLOAD_HTTP_ERROR
```

Use stable errors equivalent to:

```text
REMOTE_PROBE_HTTP_ERROR
REMOTE_PROBE_TIMEOUT
REMOTE_PROBE_BODY_TOO_LARGE
HLS_MANIFEST_FETCH_FAILED
HLS_MANIFEST_FORBIDDEN
HLS_MANIFEST_NOT_FOUND
HLS_MANIFEST_TIMEOUT
HLS_MANIFEST_TOO_LARGE
HLS_INVALID_MANIFEST
REMOTE_SOURCE_AUTHENTICATION_REQUIRED
```

Use project naming conventions.

---

## 10. Fix `Invalid input: expected object, received null`

Inspect the backend response and frontend Zod/schema contract.

The application must never surface raw schema errors to the user.

If direct files may legitimately have no HLS metadata, encode that in the type
system.

Prefer a discriminated union such as:

```ts
type ProbeResult =
  | {
      sourceType: 'direct_file'
      hls?: null
      // direct-file metadata
    }
  | {
      sourceType: 'hls_master'
      hls: HlsMetadata
    }
  | {
      sourceType: 'hls_media'
      hls: HlsMetadata
    }
```

The Zod schema should express the same contract.

A success response like:

```json
{
  "sourceType": "hls_master",
  "hls": null
}
```

must never be emitted.

If the source was identified as HLS but the manifest fetch fails, return the
normal structured API error envelope instead.

---

## 11. Never convert probe/network errors to `null`

Audit patterns such as:

```ts
try {
  ...
} catch {
  return null
}
```

Do not use `null` to represent:

- 403
- timeout
- DNS failure
- SSRF block
- invalid manifest
- body too large

Return/throw typed errors.

This likely contributes to the current frontend schema failure.

---

## 12. Use final redirected URL for HLS relatives

If:

```text
URL A
→ URL B
→ final manifest URL C
```

resolve child playlists and segments relative to URL C:

```ts
new URL(childUri, finalManifestUrl)
```

not URL A.

Validate every child through the existing SSRF layer.

Do not expose signed final URLs to the frontend.

---

## 13. Safe logging

Good logs:

```text
[remote-import:probe] <id> HEAD rejected status=403 redirects=0 host=cdn.example.com
[remote-import:probe] <id> manifest GET status=200 bytes=8421 redirects=0 host=cdn.example.com
[remote-import:probe] <id> HLS parsed type=master variants=6
```

Never log:

- signed query values
- cookies
- Authorization
- provider tokens
- AES keys
- full signed URLs

Keep one correlation ID across:

```text
HEAD
fallback GET
manifest detection
redirects
HLS parsing
filename detection
final result
```

---

## 14. Frontend behavior

When probe succeeds:

- keep filename auto-detection
- keep debounce/cancellation
- display HLS options where applicable
- do not overwrite manually edited filename

When probe fails:

show a safe message such as:

```text
The source server rejected access to the HLS manifest.
```

or:

```text
The HLS manifest could not be read.
```

Never show:

```text
Invalid input: expected object, received null
```

Never show raw Zod errors, stack traces, internal IPs, or signed URLs.

When the URL changes:

- abort previous HEAD
- abort previous fallback GET
- abort previous manifest GET
- ignore stale responses

---

## 15. Preserve filename detection

Do not regress the current filename logic.

Maintain fallback order:

1. `Content-Disposition: filename*`
2. `Content-Disposition: filename`
3. final URL pathname
4. original URL pathname
5. generated fallback

HEAD rejection must not prevent GET-based filename detection.

For HLS, auto-generated `.m3u8` names may be converted to the selected output
container extension, but manually edited names must remain respected.

---

## 16. Required integration fixtures

Create a local controlled HTTP server. Do not depend on public internet URLs.

Required cases:

### HEAD forbidden, HLS GET allowed

```text
HEAD /head-403-hls
→ 403

GET /head-403-hls
→ 200 valid #EXTM3U manifest
```

Expected: probe succeeds.

### HEAD 405, direct file GET allowed

Expected: direct-file probe succeeds.

### Signed HLS

```text
/signed-hls?token=abc
```

Without `token=abc`: 403.

Verify query is never lost.

### Redacted URL regression

The display URL lacks query parameters, while internal fetch retains them.

### Redirected HLS

Initial URL redirects to final manifest. Relative child resolution must use the
final URL.

### HLS without `.m3u8`

Return an HLS Content-Type and valid `#EXTM3U`.

### `.m3u8` returning HTML

Must fail as invalid manifest.

### `.m3u8` returning PNG/JSON error

Must fail as invalid manifest.

### Oversized manifest

Must stop at configured maximum.

### Slow manifest

Must respect timeout/cancellation.

---

## 17. Required HTTP status tests

Test:

```text
HEAD 200
HEAD 403 → GET 200
HEAD 405 → GET 200
HEAD 500 → GET 200 when fallback policy permits
GET 401
GET 403
GET 404
GET 429
GET 500
GET timeout
GET body too large
```

Verify non-2xx HEAD is never logged as success.

---

## 18. Frontend schema/API tests

Test direct file result.

Test HLS master result.

Test HLS media result.

Test that an invalid successful shape:

```json
{
  "sourceType": "hls_master",
  "hls": null
}
```

is rejected internally during development, while the backend itself never emits
that shape.

Test that a failed HLS probe uses the normal API error envelope and the UI
renders a safe message instead of a schema error.

---

## 19. Preserve SSRF security

Do not weaken SSRF protection while improving compatibility.

Continue blocking at minimum:

```text
127.0.0.0/8
::1
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
100.64.0.0/10
fc00::/7
fe80::/10
169.254.169.254
metadata.google.internal
Docker/internal service names
```

Validate DNS and every redirect.

Do not accept arbitrary user headers.

---

## 20. Manual verification

Test a controlled source matching the reported behavior:

```text
HEAD → 403
GET → 200 valid HLS
```

Expected logs:

```text
[remote-import:probe] <id> HEAD rejected status=403 redirects=0 host=...
[remote-import:probe] <id> manifest GET status=200 bytes=... redirects=0 host=...
[remote-import:probe] <id> HLS parsed type=master variants=...
[remote-import:probe] <id> probe completed sourceType=hls_master
```

There must NOT be:

```text
HEAD ok status=403
```

There must NOT be:

```text
Invalid input: expected object, received null
```

There should not be an unnecessary second manifest GET after a valid manifest
body has already been obtained.

Also verify ordinary direct file Remote Imports still work.

---

## 21. Required verification commands

Determine exact commands from the repository and run all applicable checks:

- backend lint
- backend type check
- backend unit tests
- backend integration tests
- frontend lint
- frontend type check
- frontend tests
- frontend build
- Docker Compose validation
- backend/worker Docker builds if relevant

Do not claim success unless commands were actually executed.

Fix every failure introduced by this refactor.

Clearly separate unrelated pre-existing failures.

---

## 22. Acceptance criteria

Do not consider this complete until:

- HEAD 403 is no longer treated/logged as success.
- HEAD 403 can fall back to GET.
- direct-file probing still works.
- HLS probing uses bounded GET for manifests.
- HLS probing does not depend on one-byte Range responses.
- valid manifest bodies are reused instead of unnecessarily refetched.
- direct-file and HLS networking use the shared secure fetcher.
- signed query parameters are preserved internally.
- safe/redacted URLs are never used for network access.
- final redirected URL is used for HLS relative URI resolution.
- HLS manifest 403 produces a specific structured error.
- backend never emits successful HLS metadata as `null`.
- frontend no longer displays raw `expected object, received null` errors.
- stale probe requests cannot overwrite newer results.
- SSRF protections remain active.
- filename auto-detection still works.
- successful direct imports still work.
- successful HLS imports still work.
- all relevant tests/builds pass.

---

## 23. Final report

At completion provide:

### Root cause

Explain exactly why the observed sequence happened:

```text
HEAD 403
→ ranged GET success
→ HLS fetch failure
→ null HLS metadata
→ frontend schema error
```

### Previous probe flow

Show the old request flow.

### New probe flow

Show:

```text
secure HEAD
→ conditional fallback
→ bounded HLS GET when applicable
→ reuse manifest body
→ parse
→ typed result or structured error
```

### URL handling

Explain:

- original network URL
- final redirected URL
- safe display URL
- signed query preservation

### Shared fetcher

Explain how direct file and HLS now share networking and SSRF behavior.

### API contract

Explain the discriminated/typed success response and structured failures.

### Frontend changes

Explain how safe errors replace raw schema errors.

### Tests

List new tests and exact command results.

### Manual verification

Report the HEAD-403 / GET-200 HLS fixture result.

### Remaining limitations

Explicitly state sources that still require browser cookies, anti-bot sessions,
or unsupported authentication.

Do not introduce unrelated product changes.
