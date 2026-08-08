# Claude Code Prompt — Add Request Context / Paste as cURL to 9Drive Remote Import

You are working inside the existing 9Drive project.

Remote Import already supports direct HTTP/HTTPS files, HLS/M3U8 probing,
segment materialization, FFmpeg remux, retry/progress, and upload to configured
Google Drive/S3 storage.

Some sources still fail with:

```text
HLS_MANIFEST_FORBIDDEN
```

even though the same media request can be downloaded by a browser/download
manager.

A common workflow is:

```text
User opens a video in browser
→ browser/XDM captures media request
→ XDM can download
→ user pauses XDM
→ user copies captured URL
→ user pastes URL into 9Drive
→ 9Drive receives 403 for the HLS manifest
```

The likely reason is that URL alone is not always sufficient. The successful
browser/download-manager request may also depend on request context such as:

```text
Referer
Origin
User-Agent
Cookie/session
signed URL query parameters
```

Your task is to add a secure **Remote Import Request Context** feature and a
**Paste as cURL** input mode.

This feature is only for request context explicitly supplied by the user for
content they are authorized to access.

Do NOT implement:

- DRM bypass
- Widevine/FairPlay/PlayReady extraction
- CAPTCHA solving
- Cloudflare/anti-bot bypass
- browser automation
- automatic cookie extraction
- credential scraping
- paywall bypass
- arbitrary shell execution
- arbitrary header injection

Inspect the repository before modifying files. Do not assume route names,
Prisma fields, services, frontend components, or storage abstractions.

---

## 1. Mandatory initial inspection

Inspect:

- AGENTS.md
- README.md
- backend/frontend package files
- Docker Compose
- Prisma schema
- Remote Import model
- Remote Import create/probe/retry APIs
- Remote Import worker
- shared secure HTTP fetcher
- SSRF protection
- redirect handling
- URL redaction helpers
- URL encryption/storage
- HLS manifest/child/segment/map/key fetchers
- direct-file downloader
- frontend Remote Import modal
- application encryption utilities
- existing tests

Search for:

```text
remote-import
sourceUrl
safeDisplayUrl
encrypted
encrypt
decrypt
Cookie
Referer
Origin
User-Agent
Authorization
headers
fetch(
undici
HLS_MANIFEST_FORBIDDEN
manifest
segment
EXT-X-MAP
EXT-X-KEY
SSRF
```

Explain where request context is currently lost, then continue with the
implementation.

---

## 2. Add two source input modes

Extend the Remote Import modal:

```text
Source

[ URL ] [ cURL ]
```

### URL mode

Keep the existing URL input.

Add a collapsed section:

```text
Advanced Request Options
```

Fields:

```text
Referer
Origin
User-Agent
Cookie
```

Do not add an arbitrary key/value header editor.

### cURL mode

Add:

```text
Paste cURL command
```

Support commands copied from browser DevTools or download tools.

Example:

```bash
curl 'https://cdn.example.com/master.m3u8?token=...' \
  -H 'Referer: https://example.com/watch/123' \
  -H 'Origin: https://example.com' \
  -H 'User-Agent: Mozilla/5.0 ...' \
  -H 'Cookie: session=...'
```

9Drive must PARSE this text only.

Never execute the command.

Never invoke:

```text
bash
sh
cmd.exe
powershell
curl binary
eval
exec()
```

for the pasted input.

---

## 3. Safe cURL parser

Create a pure parser service/module.

Conceptual output:

```ts
type ParsedCurlRemoteImport = {
  url: string
  requestContext: {
    referer?: string
    origin?: string
    userAgent?: string
    cookie?: string
  }
  unsupportedOptions: string[]
}
```

Support at minimum:

```text
curl 'URL'
curl "URL"
curl URL

-H 'Header: value'
--header 'Header: value'

-A 'User Agent'
--user-agent 'User Agent'

-b 'cookie=value'
--cookie 'cookie=value'
```

Support multiline commands with normal backslash continuation.

Do not implement a general shell interpreter.

Reject dangerous or irrelevant transport options such as:

```text
--proxy
-x
--socks4
--socks5
--resolve
--connect-to
--interface
--unix-socket
--upload-file
-T
--form
-F
--data
-d
--data-binary
```

Reject shell composition/command substitution where safely detectable:

```text
;
&&
||
$(
backticks
shell pipes
redirections
```

Never use eval.

---

## 4. Allowlist only these request-context values

Extract only:

```text
URL
Referer
Origin
User-Agent
Cookie
```

Do not automatically forward:

```text
Host
Connection
Content-Length
Transfer-Encoding
Range
X-Forwarded-For
X-Real-IP
Proxy-Authorization
Proxy-Connection
Sec-*
```

Do not support arbitrary custom headers in this iteration.

If pasted cURL contains `Authorization`, return a clear validation message that
Authorization credentials are not supported by this feature.

Do not silently ignore it if that would make the request unexpectedly fail.

---

## 5. Add a Request Context domain model

Use one internal concept:

```ts
type RemoteImportRequestContext = {
  referer?: string
  origin?: string
  userAgent?: string
  cookie?: string
}
```

Reuse existing naming/style conventions.

If the application already has an encrypted JSON/blob pattern, reuse it.

Preferred persistence conceptually:

```text
RemoteImport
├── sourceUrlEncrypted / existing secure source URL field
├── safeDisplayUrl
└── requestContextEncrypted
```

Do not store Cookie in plaintext.

Do not store signed source URLs in a redacted form that is later used for
network access.

---

## 6. Encrypt sensitive request context at rest

Treat at least these as sensitive:

```text
Cookie
signed URL query parameters
future credentials
```

Prefer encrypting the full request-context object.

Reuse existing application encryption/key-management utilities.

Do not invent custom cryptography if a secure project utility already exists.

Normal Remote Import APIs must NOT return the Cookie value after creation.

Return only a safe summary, e.g.:

```json
{
  "requestContext": {
    "attached": true,
    "referer": true,
    "origin": true,
    "userAgent": true,
    "cookie": true
  }
}
```

---

## 7. Preserve the real source URL

Keep clear separation between:

```text
network source URL
safe display URL
final redirected URL
```

The networking layer must retain query parameters such as:

```text
?token=
?sig=
?signature=
?expires=
?hmac=
```

Do not fetch the redacted/safe display URL.

Never expose full signed URLs in logs or frontend responses unnecessarily.

---

## 8. Integrate Request Context into the shared secure fetcher

Do not create a separate insecure HTTP path.

Extend the existing shared secure fetch layer.

All requests must still use:

- SSRF validation
- DNS validation
- redirect validation
- timeout rules
- body-size limits
- cancellation
- redacted logging

Conceptually:

```ts
secureRequest({
  url,
  purpose,
  requestContext,
  ...
})
```

The secure fetcher should obtain safe request headers through one centralized
policy helper.

---

## 9. Centralize header-forwarding policy

Create/refactor a component conceptually like:

```text
RemoteRequestContextPolicy
```

Input:

```text
original source URL
current target URL
request context
```

Output:

```text
safe allowlisted headers for this exact request
```

Do not let individual HLS modules independently decide which sensitive headers
to forward.

---

## 10. User-Agent policy

If user supplies User-Agent:

```text
use it
```

Otherwise use the application default.

User-Agent may generally follow the HLS resource chain.

Validate against CR/LF injection.

Apply a practical maximum length.

---

## 11. Referer policy

Validate Referer as an absolute HTTP/HTTPS URL.

Reject unsupported schemes:

```text
file:
ftp:
javascript:
data:
```

Reject CR/LF.

If provided, allow it to be applied to appropriate child HLS resources.

---

## 12. Origin policy

Validate and normalize Origin to:

```text
scheme://host[:port]
```

Do not preserve pathname/query/fragment.

Reject malformed values and CR/LF.

---

## 13. Cookie policy — mandatory security rule

Cookie is the most sensitive field.

Default:

```text
Cookie scope = exact source host only
```

Example:

```text
Source:
https://video.example.com/master.m3u8
```

Cookie MAY be sent to:

```text
https://video.example.com/variant.m3u8
https://video.example.com/segment001.ts
```

Cookie MUST NOT automatically be sent to:

```text
https://cdn.other.net/segment001.ts
```

Do not leak cookies cross-origin.

If a robust Public Suffix List based same-site implementation already exists,
it may be reused, but `source-host` must remain the safe default.

Do not implement naive:

```ts
hostname.endsWith(...)
```

domain security checks.

---

## 14. Recalculate sensitive headers after redirects

Every redirect must still be manually/securely validated according to the
existing SSRF architecture.

If:

```text
video.example.com
→ cdn.other.net
```

recompute request headers for the new URL.

Do not carry Cookie automatically to the new host.

Do not rely only on HTTP-library defaults for sensitive header stripping.

---

## 15. HLS child-resource support is mandatory

Request context must be applied to the entire HLS fetch graph, not only the
initial manifest.

Audit and fix:

```text
master playlist
selected video playlist
separate audio playlist
subtitle playlist
video segments
audio segments
subtitle segments
EXT-X-MAP
AES-128 EXT-X-KEY
live playlist refresh
```

All must pass through the shared secure fetcher and centralized context policy.

FFmpeg must continue reading local materialized files only; do not give FFmpeg
remote authenticated URLs.

---

## 16. Cross-origin HLS policy

For cross-origin HLS child resources, use a safe default:

```text
User-Agent → may forward
Referer    → may forward when provided
Origin     → may forward when provided
Cookie     → NO unless target satisfies cookie-scope policy
```

If a cross-origin child requires a different cookie, fail safely with a clear
error such as:

```text
HLS_CHILD_AUTHENTICATION_REQUIRED
```

or the project's equivalent.

Do not leak source-host Cookie to make the request work.

---

## 17. Direct-file support

Request context must also work for ordinary direct files.

Example:

```text
GET video.mp4
Referer: ...
Cookie: ...
```

Reuse the exact same policy and secure networking abstraction.

Do not create an HLS-only implementation when the abstraction naturally applies
to both.

---

## 18. Probe API

Extend the existing probe flow to support Request Context.

Conceptual URL-mode request:

```json
{
  "url": "https://...",
  "requestContext": {
    "referer": "https://...",
    "origin": "https://...",
    "userAgent": "Mozilla/5.0 ...",
    "cookie": "..."
  }
}
```

Conceptual cURL-mode request:

```json
{
  "sourceMode": "curl",
  "curl": "..."
}
```

Adapt to existing API conventions.

Never send Cookie through query-string parameters.

Use POST body only.

Backend validation is authoritative.

---

## 19. Parse cURL on backend

Frontend may provide preview parsing, but backend must independently parse and
validate cURL input.

Possible architecture:

```text
POST /remote-imports/parse-curl
```

or integrate it into the existing probe endpoint.

Do not trust frontend-only parsing.

For a safe response, return detected booleans and non-sensitive normalized
values where needed.

Do not echo Cookie unnecessarily.

---

## 20. Frontend UX

Use existing design components and spacing.

### URL mode

Keep current fields.

Add collapsed:

```text
Advanced Request Options
```

with:

```text
Referer
Origin
User-Agent
Cookie
```

Cookie field should use secret/password styling.

### cURL mode

Textarea:

```text
Paste cURL command
```

Helper text:

```text
Paste a cURL request copied from your browser's network tools. 9Drive extracts
only the supported URL and request context; the command is never executed.
```

After safe parsing show:

```text
URL detected
Referer detected
Origin detected
User-Agent detected
Cookie detected
```

Do not show persisted Cookie values after job creation.

---

## 21. Job creation

When creating Remote Import, persist:

```text
canonical filename
network source URL
encrypted request context
destination
storage account selection
HLS options
```

The worker must be able to load/decrypt request context after the job has been
queued.

Do not rely on frontend state once the import exists.

---

## 22. Retry behavior

Retry must preserve:

```text
source URL
canonical filename
encrypted request context
destination
storage selection
HLS options
```

Do not require the user to repaste cURL for normal retry.

If request context or signed URL has expired, retry must fail visibly with a
clear error.

Do not stay queued forever.

Do not silently retry without the original request context.

---

## 23. Expired signed URL/context

Do not reverse-engineer or regenerate URL signatures.

Do not scrape the page to obtain a fresh URL.

If correct request context is present but server still returns 401/403, map it
to an error equivalent to:

```text
REMOTE_SOURCE_ACCESS_EXPIRED
```

User message:

```text
The source URL or request context may have expired. Capture a fresh media
request and try again.
```

Do not create infinite retries.

---

## 24. Keep existing HLS content validation

Request context is not a replacement for response validation.

Continue to reject cases where a supposed video segment actually contains:

```text
image/png
image/jpeg
text/html
application/json
```

Do not save an error/placeholder image as `.ts` and wait for FFmpeg to fail.

Keep media signature/content sniffing.

---

## 25. Header injection protection

Reject request-context values containing CR/LF.

Set practical limits, approximately:

```text
Referer <= 4096 bytes/chars
Origin <= 2048
User-Agent <= 2048
Cookie <= 16384
cURL input <= 65536
```

Adapt to existing configuration conventions.

Prevent values like:

```text
good-value
Host: internal
```

from becoming multiple headers.

---

## 26. SSRF remains mandatory

Request context and cURL mode must NOT weaken SSRF controls.

Continue blocking private, loopback, link-local, metadata, and internal network
targets.

Validate:

```text
initial URL
every redirect
master playlist
child playlist
segment
map
key
subtitle
live refresh
```

Do not honor cURL DNS/proxy routing options.

---

## 27. Safe logging/redaction

Never log:

```text
Cookie
Authorization
signed query values
session IDs
tokens
AES keys
```

Safe example:

```text
[remote-import:probe] <id> manifest GET status=200 host=cdn.example.com context=user-agent,referer,cookie
```

Unsafe:

```text
Cookie: session=SECRET
https://cdn.example.com/master.m3u8?token=SECRET
```

Centralize redaction.

---

## 28. New stable errors

Add/reuse errors equivalent to:

```text
REMOTE_IMPORT_CURL_INVALID
REMOTE_IMPORT_CURL_UNSAFE_OPTION
REMOTE_IMPORT_CURL_MULTIPLE_URLS
REMOTE_IMPORT_REQUEST_CONTEXT_INVALID
REMOTE_IMPORT_HEADER_VALUE_INVALID
REMOTE_SOURCE_AUTHENTICATION_REQUIRED
REMOTE_SOURCE_ACCESS_EXPIRED
HLS_CHILD_AUTHENTICATION_REQUIRED
```

Use project naming conventions.

Do not expose sensitive values in error messages.

---

## 29. Suggested configuration

Only add what is necessary:

```dotenv
REMOTE_IMPORT_REQUEST_CONTEXT_ENABLED=true
REMOTE_IMPORT_CURL_INPUT_ENABLED=true
REMOTE_IMPORT_REQUEST_CONTEXT_MAX_CURL_BYTES=65536
REMOTE_IMPORT_REQUEST_CONTEXT_MAX_COOKIE_BYTES=16384
REMOTE_IMPORT_REQUEST_CONTEXT_COOKIE_SCOPE=source-host
```

Do not add configuration for arbitrary header forwarding.

---

## 30. Unit tests — cURL parser

Test:

```text
simple URL
single quoted URL
double quoted URL
multiline cURL
-H Referer
--header Referer
-H Origin
-H User-Agent
-A User-Agent
-H Cookie
-b Cookie
header values containing colon
signed URL query parameters
spaces inside quoted values
```

Reject:

```text
multiple URLs
file://
ftp://
--proxy
--resolve
--connect-to
--upload-file
--data
--form
shell chaining
command substitution
malformed quoting
CRLF injection
unsupported Authorization
```

Prove no command is executed.

---

## 31. Unit tests — forwarding policy

### Same source host

Source:

```text
https://video.example.com/master.m3u8
```

Child:

```text
https://video.example.com/segment.ts
```

Expected:

```text
User-Agent yes
Referer yes
Origin yes
Cookie yes
```

### Different host

Child:

```text
https://cdn.other.net/segment.ts
```

Expected default:

```text
User-Agent yes
Referer yes when configured
Origin yes when configured
Cookie NO
```

### Redirect same host

Cookie may remain.

### Redirect different host

Cookie removed.

### Redirect to private address

Blocked by SSRF.

---

## 32. Mandatory integration fixture — reported scenario

Create a controlled local HTTP fixture.

Behavior:

```text
GET /protected/master.m3u8
without required context
→ 403
```

With:

```text
Referer: https://site.example/watch/1
Cookie: session=valid
```

return valid HLS.

Child playlist and same-host segments should also require the context.

Test:

```text
URL only
→ HLS_MANIFEST_FORBIDDEN
```

Then:

```text
URL + Request Context
→ probe succeeds
→ child playlist succeeds
→ segment download succeeds
→ remux succeeds
```

This test is mandatory.

---

## 33. Mandatory integration fixture — Paste as cURL

Use:

```bash
curl 'https://fixture.test/protected/master.m3u8?token=abc' \
  -H 'Referer: https://site.example/watch/1' \
  -H 'Origin: https://site.example' \
  -H 'User-Agent: Mozilla/5.0 Test' \
  -H 'Cookie: session=valid'
```

Verify:

```text
parse
→ URL extracted
→ context extracted
→ probe
→ create import
→ worker decrypts context
→ manifest
→ child playlist
→ segments
→ remux
```

No Cookie value may appear in subsequent API responses or logs.

---

## 34. Mandatory cookie-leak regression test

Fixture:

```text
manifest host = video.example.test
segment host = cdn.other.test
```

Provide:

```text
Cookie: session=secret
```

Assert:

```text
video.example.test receives Cookie
cdn.other.test does NOT receive Cookie
```

This test is mandatory.

---

## 35. Signed URL + request context test

Require both:

```text
?token=abc
```

and Referer for access.

Verify both are preserved during the network request.

Verify neither secret appears in logs.

---

## 36. Frontend tests

Test:

```text
URL/cURL mode switch
Advanced Request Options collapsed by default
Referer
Origin
User-Agent
Cookie
Paste cURL textarea
safe parsed summary
probe with request context
validation errors
```

After creation, UI/API must never return the persisted Cookie value.

Retry may show:

```text
Request context attached
```

but not secret values.

---

## 37. Regression checks

Do not regress previous Remote Import fixes.

Verify:

- normal URL imports still work
- public HLS without request context still works
- direct file imports still work
- HLS retry starts correctly instead of staying queued
- upload progress still appears after remux
- final uploaded filename still matches the user-selected canonical filename
- automatic/manual storage selection still works
- Google Drive/S3 upload still works
- filename auto-detection still works
- HLS media validation still detects PNG/HTML error bodies
- SSRF protection still works

---

## 38. Required verification commands

Determine the exact commands from the repository and run all applicable:

```text
Prisma format
Prisma validate
Prisma generate
migration if needed
backend lint
backend typecheck
backend tests
frontend lint
frontend typecheck
frontend tests
frontend build
Docker Compose validation
worker build
backend build
```

Run the controlled HLS/request-context integration tests.

Do not claim tests passed unless actually executed.

Clearly separate unrelated pre-existing failures.

---

## 39. Acceptance criteria

This work is complete only when:

- URL mode still works
- cURL mode exists
- cURL is parsed and never executed
- only URL, Referer, Origin, User-Agent, Cookie are extracted
- dangerous cURL options are rejected
- Cookie/request context is encrypted at rest
- signed URL query parameters are preserved
- secrets do not appear in normal APIs/logs
- request context works during probe
- request context works for child HLS playlists
- request context works for video/audio segments
- request context works for EXT-X-MAP
- request context works for AES-128 key fetches where supported
- Cookie is source-host-only by default
- Cookie is removed for cross-host resources
- SSRF protection remains active
- URL-only protected fixture returns expected 403
- same fixture + request context succeeds
- Paste-as-cURL fixture succeeds
- cookie-leak regression test passes
- existing public HLS/direct imports still pass
- retry/upload-progress/canonical-filename fixes still pass
- no DRM/browser automation/anti-bot bypass is introduced

---

## 40. Final report

At completion provide:

### Root cause

Explain why URL-only imports could receive:

```text
HLS_MANIFEST_FORBIDDEN
```

while a browser/download manager could access the media.

### New flow

```text
URL or cURL
→ safe parser/validation
→ encrypted Request Context
→ secure probe
→ manifest
→ child playlist
→ segments/maps/keys
→ local materialization
→ FFmpeg
→ upload
```

### cURL parser

Document supported and rejected options.

### Header forwarding

Document exact policy for:

```text
User-Agent
Referer
Origin
Cookie
```

including cross-origin behavior.

### Security

Explain:

```text
encryption at rest
log redaction
SSRF
cookie scope
no shell execution
no arbitrary headers
```

### Database/backend/frontend changes

List important files and migrations.

### Tests

List exact commands and results.

### End-to-end verification

Report:

```text
URL-only protected HLS → expected failure
same source + Request Context → success
Paste as cURL → success
cross-host segment → Cookie not leaked
```

### Remaining limitations

Explicitly mention:

```text
DRM
automatic browser-session acquisition
CAPTCHA/Cloudflare challenges
automatic cookie extraction
automatic signed-URL refresh
unsupported Authorization credentials
```

Do not introduce unrelated product changes.
