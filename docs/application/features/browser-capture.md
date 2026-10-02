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

## Authenticated requests

The extension observes Cookie and User-Agent on the matching media request through `webRequest` with `extraHeaders`. Cookie stays in short-lived service-worker memory and goes only in the device-authenticated submission. It is absent from local captures, popup messages, and logs. A failed offline submission loses that context; capture the request again after reconnecting.

The API validates the allowlisted request context and stores it encrypted for Remote Import. Resource and import responses report header presence as booleans. Cookie is forwarded only to the exact origin of the original import URL, including its scheme and port.
