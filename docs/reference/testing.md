# Testing Reference

## Backend

Framework: Vitest.

```bash
cd backend
npm test
npm run test:watch
```

Tests are colocated with modules (`*.test.ts`) and cover routing, storage placement, sync reconciliation, Telegram, Remote Import/HLS/SSRF/request context, remote-worker transport, SMB, Browser Capture, and related behavior.

## Frontend

Vitest + Testing Library + jsdom.

```bash
cd frontend
npm test
npm run test:watch
```

Important tests cover `UploadContext`, quota tracking, remote imports, workers, and drive components.

## Browser Extension
Tests are Node `.mjs` files under `extensions/browser-capture/tests/`, covering classification, filtering, filename resolution, media identity, metadata, and storage behavior.

## Change Rule
When changing stateful behavior such as routing, synchronization, retry logic, Telegram metadata, SSRF handling, or filename resolution, update/add tests at that boundary. Do not rely only on manual UI testing.
