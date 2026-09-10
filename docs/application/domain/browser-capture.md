# Domain: Browser Capture

## Purpose
The browser extension captures candidate media/resources and sends metadata plus request context to the backend so the user can select and import the resource through Remote Import.

## Entities

- `BrowserDevicePairing` — short-lived pairing code with expiry and `usedAt` state.
- `BrowserDevice` — registered device with a hashed device token.
- `CapturedResource` — encrypted source URL, filename, type, page metadata, optional request context, media identity, expiry, and status.

## Resource Status
`pending | consumed | expired | deleted`.

## Identity Boundary
Dashboard users authenticate with bearer JWTs. Browser-extension devices authenticate with device tokens through `requireDevice`. Selected import endpoints accept either identity according to the route contract (`requireAnyIdentity`).

## Media Identity
The backend stores only the winning metadata (`mediaIdentityTitle/source/confidence`); the full candidate list stays in the extension.

## Related Files

- `extensions/browser-capture/src/*`
- `backend/src/modules/browser-capture/*`
- `frontend/src/components/settings/BrowserCaptureCard.tsx`
