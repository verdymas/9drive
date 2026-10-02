# Goal: Show Remote Import Request Context Details Safely

Add a request-context details viewer to the Remote Imports page so an authenticated user can inspect the context attached to their own import for debugging protected sources.

This task is intentionally narrow and optimized for GPT-5.6 Luna.

## Current Behavior

The Remote Imports page currently shows only:

```text
Request context attached
```

Current frontend:

```text
frontend/src/pages/RemoteImportsPage.tsx
```

renders the label when:

```ts
item.requestContext?.attached
```

Current API type:

```text
frontend/src/lib/remoteImports.ts
```

uses a boolean-only summary:

```ts
type RequestContextSummary = {
  attached: boolean
  referer: boolean
  origin: boolean
  userAgent: boolean
  cookie: boolean
}
```

Current backend:

```text
backend/src/modules/remote-imports/remote-import.service.ts
```

intentionally removes `requestContextEncrypted` and serializes only boolean presence flags through `serializeRemoteImport()`.

Keep that behavior for list/detail Remote Import responses.

Do NOT start returning decrypted request-context values from the normal Remote Import list API.

---

## Read First

Do NOT scan the whole repository.

Read only:

1. `AGENTS.md` if present.
2. `docs/README.md` if present.
3. `frontend/src/pages/RemoteImportsPage.tsx`
4. `frontend/src/lib/remoteImports.ts`
5. Existing modal/dialog UI primitives used by this project.
6. `backend/src/modules/remote-imports/remote-import.routes.ts`
7. `backend/src/modules/remote-imports/remote-import.service.ts`
8. `backend/src/modules/remote-imports/request-context.ts`
9. Existing Remote Import route/service/frontend tests.

Only inspect additional files when directly required.

---

## UX Requirement

Make the existing:

```text
🔒 Request context attached
```

interactive.

Clicking it should open a small details modal/dialog for that Remote Import.

Show:

```text
Request Context

Referer
https://example.com/watch/123

Origin
https://example.com

User-Agent
Mozilla/5.0 ...

Cookie
session=••••••••; cf_clearance=••••••••
```

Only show fields that are actually attached.

If a field is not attached, either omit it or show `Not attached`.

Prefer a compact read-only details layout consistent with the current UI.

---

## Security Model

### Normal Remote Import APIs

Keep existing list/detail serialization safe:

```text
GET /remote-imports
GET /remote-imports/:id
```

must continue returning only:

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

Do NOT include decrypted values there.

### Dedicated Details Endpoint

Add an authenticated owner-only endpoint such as:

```text
GET /remote-imports/:id/request-context
```

It must:

1. Verify the Remote Import belongs to the authenticated user.
2. Read `requestContextEncrypted`.
3. Decrypt it using the existing request-context helper.
4. Return only request-context fields.
5. Never log decrypted values.
6. Return `404` for imports the user does not own.

Suggested safe response:

```json
{
  "attached": true,
  "referer": "https://example.com/watch/123",
  "origin": "https://example.com",
  "userAgent": "Mozilla/5.0 ...",
  "cookie": {
    "attached": true,
    "masked": "session=••••••••; cf_clearance=••••••••"
  }
}
```

Do not return internal encrypted blobs.

---

## Cookie Handling

Cookie is sensitive.

By default, the details endpoint/UI should expose a masked representation.

Mask Cookie values while preserving cookie names.

Example input:

```text
session=abc123; cf_clearance=xyz789
```

default display:

```text
session=••••••••; cf_clearance=••••••••
```

Do not log either the raw or masked Cookie string unnecessarily.

### Optional Reveal

Add a `Reveal` action only if it can be implemented narrowly and safely.

Preferred behavior:

```text
Cookie
session=••••••••; cf_clearance=••••••••    [Reveal]
```

When the user explicitly clicks `Reveal`, fetch the raw value from a dedicated authenticated endpoint/action rather than putting it in the initial list payload.

For example:

```text
GET /remote-imports/:id/request-context?revealCookie=1
```

or an equivalent dedicated route.

Requirements:

- owner-only authorization;
- explicit user action;
- raw Cookie never appears in logs;
- raw Cookie is not cached in localStorage/sessionStorage;
- do not persist it in frontend state longer than the open dialog lifecycle;
- closing the dialog clears the revealed value.

If implementing raw reveal would require a broad security change, omit raw reveal and keep cookie values masked.

---

## Frontend

In:

```text
frontend/src/pages/RemoteImportsPage.tsx
```

make the request-context label a button/link-style control.

Example:

```text
🔒 Request context attached  View
```

Click:

```text
RemoteImport row
    ↓
GET /remote-imports/:id/request-context
    ↓
Request Context dialog
```

Add a frontend API helper in:

```text
frontend/src/lib/remoteImports.ts
```

such as:

```ts
getRemoteImportRequestContext(id)
```

Add a dedicated type for the details response.

Do not overload `RemoteImportItem.requestContext`, which should remain boolean-only.

Handle:

- loading;
- API error;
- import with no context;
- dialog close;
- long Referer/User-Agent values without overflowing the viewport.

Provide copy buttons for `Referer`, `Origin`, and `User-Agent` if the project already has an established copy-button pattern.

Do not add a large dependency.

---

## Backend

Add the smallest service/helper needed to retrieve request context for the authenticated owner.

Reuse:

```text
decryptRequestContext(...)
```

Do not duplicate encryption/decryption logic.

Do not expose:

```text
requestContextEncrypted
sourceUrlEncrypted
resumeSessionEncrypted
```

or any unrelated secret.

The endpoint should return an appropriate empty response when the import has no attached request context.

---

## Tests

Add focused regression tests.

### Backend

Test:

1. owner can retrieve request-context details;
2. another user cannot retrieve them;
3. normal `/remote-imports` list still exposes booleans only;
4. normal `/remote-imports/:id` still exposes booleans only;
5. encrypted blob is never returned;
6. cookie is masked by default;
7. no-context import returns the expected empty state;
8. raw Cookie reveal, if implemented, requires explicit request and owner authorization.

### Frontend

Test:

1. `Request context attached` is interactive;
2. opening it fetches details lazily;
3. Referer is displayed;
4. Origin is displayed;
5. User-Agent is displayed;
6. Cookie is masked by default;
7. long values do not break the card/dialog layout;
8. closing the dialog clears sensitive detail state;
9. rows without attached context do not show the details action.

---

## Important Constraints

Do NOT:

- return raw request context in the Remote Import list response;
- expose Cookie in logs;
- expose encrypted database blobs;
- weaken authentication/ownership checks;
- change Remote Import download behavior;
- change Browser Capture logic in this task;
- change Cloudflare relay behavior;
- redesign the Remote Imports page;
- perform unrelated refactors.

Keep this a focused observability/debugging feature.

---

## Definition of Done

The feature is complete when:

- Remote Imports still shows the compact `Request context attached` indicator;
- clicking it opens request-context details;
- Referer, Origin, and User-Agent can be inspected;
- Cookie presence and masked cookie names/values can be inspected;
- raw Cookie is shown only after explicit reveal if reveal is implemented;
- normal Remote Import APIs remain boolean-only;
- only the owner can retrieve details;
- sensitive values never appear in logs;
- focused tests pass.

---

## Final Response

Keep the implementation report concise:

1. files changed;
2. endpoint added;
3. fields shown in the dialog;
4. Cookie masking/reveal behavior;
5. security boundary preserved;
6. tests run/result.

Use the existing project UI patterns and make the smallest safe change.
