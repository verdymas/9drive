# Phase 01 — Extension MVP

Build the first manual-install 9Drive Browser Capture Extension.

First inspect and plan the existing 9Drive authentication, API, frontend/build conventions, Remote Import, validation, and security architecture.

Implement:
- Manifest V3 Chromium extension
- manual-install package/download
- first-run 9Drive domain connection
- device registration handshake
- configurable capture filters
- basic network/resource detection
- local pending capture storage
- badge count

Default filters:
- Video: m3u8, mpd, mp4, webm, m4v, relevant MIME types
- Documents: PDF and common document MIME types

For HLS/DASH, prefer capturing the manifest rather than flooding storage with media segments.

Store locally:
- local ID
- URL
- type
- page URL
- filename
- status
- timestamp

Statuses:
- detected
- selected
- submitted
- expired

Badge shows pending detected resources only.

Do not implement Remote Import creation yet.

Do not store passwords. Do not log cookies, Authorization, tokens, signed URLs, or secrets. Request the minimum browser permissions necessary.

Testing:
- resource classification
- filename detection
- manifest validation
- extension build/package validation
- manual browser verification

Do not use Playwright.

Acceptance:
- extension builds and can be manually installed
- user can connect it to 9Drive
- capture preferences persist
- m3u8/mp4/mpd/PDF can be detected
- HLS segments do not flood the capture list
- badge count works
- existing 9Drive features remain unaffected
