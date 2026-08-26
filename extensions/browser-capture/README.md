# 9Drive Browser Capture (Extension)

MV3 Chromium extension that detects video/HLS/DASH/document resources while you
browse and sends them to your 9Drive as **Remote Imports**. The extension never
downloads file bytes and never runs FFmpeg — it is a capture client only.

## Manual install

1. Build/serve your 9Drive backend and log in to the dashboard.
2. Go to **Settings → Browser Capture** and click **Pair a device** — copy the
   one-time code.
3. In Chrome/Edge: open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, select this folder (`extensions/browser-capture`).
4. Click the 9Drive Capture icon, paste your backend URL + pairing code, and
   click **Connect**.
5. Browse. Detected media shows up in the popup with a badge count; click
   **Import** to send it to 9Drive (choose folder / storage account /
   Direct-or-Worker in the dialog).

## Permissions & privacy

- `storage` — local capture list + device token (never synced elsewhere).
- `alarms` — periodic heartbeat/sync every 5 minutes.
- `contextMenus` — reserved for the Phase 06 context-menu actions.
- `host_permissions (http/https)` — required by `chrome.webRequest` to observe
  response headers for media detection on any page. The extension reads
  **headers only** (Content-Type), never bodies, cookies, or Authorization
  values, and never logs URLs' query strings.

## Tests

```bash
node tests/classify.test.mjs
```

## Layout

```
manifest.json      MV3 manifest (minimum Chrome 114)
src/background.js  service worker: detection, store sync, badge, pairing
src/classify.js    pure classification/filename logic (Node-testable)
src/store.js       chrome.storage.local capture list
src/api.js         backend API client
popup/             compact popup UI with import dialog
```
