# Feature: Browser Capture Extension

## Components

Extension:

- `extensions/browser-capture/manifest.json`
- `extensions/browser-capture/src/background.js`
- `content-script.js`
- `classify.js`, `filters.js`, `filename-resolver.js`, `metadata-collectors.js`, `media-identity.js`, `store.js`
- popup under `extensions/browser-capture/popup/`

Backend:

- `backend/src/modules/browser-capture/browser-capture.routes.ts`
- `browser-capture.service.ts`
- `device.middleware.ts`
- rate-limiting middleware.

Frontend:

- `frontend/src/components/settings/BrowserCaptureCard.tsx`

## API Families

Dashboard-authenticated device management:

- create pairing;
- list/rename/rotate/delete devices;
- read resource count;
- download extension ZIP.

Device-authenticated operations:

- register pairing;
- heartbeat;
- submit/list/consume/delete captured resources.

Import bridge:

- get import options;
- import a captured resource into Remote Import.

## Build
The backend build runs `scripts/zip-extension.mjs` so the extension artifact can be served from `/browser-capture/extension.zip`.
