# Goal: Browser Capture Authenticated Request Context

Fix Browser Capture so remote imports can reuse the browser request context required by protected media sources such as Pixeldrain, while preserving strict credential security.

This task is intentionally narrow and optimized for GPT-5.6 Luna.

## Confirmed Problem

A captured media request works in the browser, but the Remote Import Cloudflare relay receives only:

```text
accept
origin
range
referer
user-agent
```

and logs:

```text
hasCookie=false
```

The upstream source then returns HTTP `403`.

The current Browser Capture flow intentionally does not capture/send `Cookie`, even though the Remote Import core already supports encrypted request context and exact-origin cookie forwarding.

Do not add a Pixeldrain-specific workaround. Fix authenticated Browser Capture request context generically.

## Read First

Do NOT scan the whole repository.

Read only:

1. `AGENTS.md` if present.
2. `docs/README.md` if present.
3. Browser Capture extension files containing:
   - `webRequest`
   - `onBeforeSendHeaders`
   - `onHeadersReceived`
   - `requestId`
   - `requestContext`
   - capture/import submission
4. Backend files containing:
   - Browser Capture request-context schema
   - `RemoteImportRequestContext`
   - `validateRequestContext`
   - `encryptRequestContext`
   - request-context forwarding / redirect-origin checks
5. Cloudflare relay transport code only if needed to verify forwarding.
6. Existing Browser Capture / Remote Import request-context tests.

Only inspect additional files when directly required.

## Required Changes

### 1. Capture the actual Cookie header used by the browser request

Use the extension's existing request tracking.

Prefer capturing the actual outgoing request headers through `webRequest.onBeforeSendHeaders`, correlated by `requestId`.

Capture only the required sensitive context:

```text
Cookie
```

Keep existing:

```text
Referer
Origin
User-Agent
```

If Chromium requires `extraHeaders` to expose Cookie, use the correct listener option.

Do NOT capture unrelated sensitive headers.

Do NOT capture `Authorization` in this task.

### 2. Join request headers to the captured resource by requestId

The Cookie attached to a captured media resource must come from the same browser network request.

Do not read the entire cookie jar and guess which cookies apply.

Expected concept:

```text
onBeforeSendHeaders(requestId)
        ↓
store temporary request context
        ↓
onHeadersReceived(requestId)
        ↓
attach context to captured resource
```

Bound/clean temporary request-context state so it cannot grow indefinitely.

### 3. Accept Cookie in the Browser Capture backend schema

Update the Browser Capture request-context validation so:

```json
{
  "referer": "...",
  "origin": "...",
  "userAgent": "...",
  "cookie": "..."
}
```

is accepted.

Reuse the existing Remote Import request-context validation and encryption path.

Cookie must NOT be stored plaintext.

### 4. Preserve exact-origin security

Cookie may only be forwarded to the exact source origin according to the existing Remote Import security policy.

On redirect to another origin:

```text
Cookie must be stripped
```

unless an existing explicit safe policy already allows it.

Do not weaken SSRF or redirect protections.

### 5. Never expose Cookie values

Never include actual Cookie values in:

- logs
- API responses
- UI
- audit messages
- Cloudflare relay diagnostics

Boolean diagnostics are allowed:

```text
hasCookie=true
```

The API may expose presence metadata only, for example:

```json
{
  "requestContext": {
    "attached": true,
    "cookie": true
  }
}
```

### 6. Preserve Cloudflare relay forwarding

Verify that when encrypted request context contains Cookie and the target is the allowed exact origin, the Remote Import worker forwards it through the Cloudflare relay.

Expected diagnostic:

```text
hasCookie=true
```

Do not log the Cookie value.

## Regression Tests

Add focused tests for:

1. Browser Capture request with Cookie:
   - Cookie is captured from the actual request;
   - correlated by `requestId`.

2. Backend accepts Browser Capture Cookie context.

3. Cookie is encrypted at rest / not persisted plaintext.

4. API responses never expose the Cookie value.

5. Exact-origin request forwards Cookie.

6. Cross-origin redirect strips Cookie.

7. Existing capture without Cookie still works.

8. Existing security validation for disallowed headers remains intact.

## Compatibility Requirements

Do not break:

- Browser Capture detection
- Remote Import
- Cloudflare relay
- HLS/DASH capture
- filename detection
- request-context encryption
- SSRF protection
- redirect security
- Google Drive
- S3
- Telegram

Do not add `Authorization` capture in this task.

Do not add source-specific Pixeldrain logic.

## Definition of Done

The fix is complete when:

- Browser Capture can attach the actual request Cookie used by the captured media request;
- Cookie is accepted by the backend;
- Cookie is encrypted at rest;
- Cookie is forwarded only to the allowed exact source origin;
- cross-origin redirects strip Cookie;
- Cookie values never appear in logs/API/UI;
- Cloudflare relay diagnostics can show `hasCookie=true`;
- focused tests pass.

## Final Response

Keep the report concise:

1. root cause confirmed;
2. files changed;
3. how Cookie is captured/correlated;
4. security boundaries preserved;
5. tests run/result;
6. any remaining limitation.

If the current code differs from the assumptions above, follow the actual code and keep the change narrow.
