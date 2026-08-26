# Phase 06 — Context Menu and Advanced Capture

Add advanced optional capture workflows.

First inspect and plan extension permissions and capture architecture.

Add context menu:
9Drive
- Import this link
- Capture page media
- Open 9Drive Capture

Import this link should route supported PDF/MP4/M3U8/MPD/document links through the existing captured-resource/import pipeline. The extension must not download directly.

Capture page media should scan known resources from the current page, deduplicate, and show them in the popup.

Default scope is current tab. Do not capture unrelated tabs unless explicitly enabled.

Improve filename detection using:
1. safe Content-Disposition metadata
2. URL path
3. page title
4. appropriate DOM metadata

Never use signed query strings as filenames.

Group HLS variants under one logical capture when possible. Do not create one import per segment/variant unless explicitly chosen.

Control storage writes and duplicate detection with throttling/debouncing.

Do not expand permissions unnecessarily or collect unrelated browsing history.

Do not use Playwright.
