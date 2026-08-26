# Phase 05 — Extension Popup UX

Turn the extension into an IDM-like capture workflow.

First inspect and plan the existing extension and backend APIs.

Badge:
- detected/pending counted
- imported/expired/deleted not counted
- update on detection, import, expiration, deletion

Compact popup:

9Drive Capture
Connected

Detected Files (N)

🎬 Movie 1080p
HLS
[Import]

📄 document.pdf
PDF
[Import]

Actions:
- Import
- Remove
- Open source page

Import dialog:
- filename
- destination
- Direct or available Worker
- Start Import

Do not expose relay/provider credentials.

Handle:
- connecting
- loading
- submitting
- imported
- expired
- failed
- offline

If backend is temporarily unavailable, retain detected resources locally and retry with bounded behavior.

Deduplicate resources. Avoid listing every HLS/DASH segment; prefer manifests.

Do not show long/signed URLs by default.

Do not use Playwright.

Acceptance:
Browse → badge increases → open extension → see detected media → Import → choose Worker/Direct + filename → Remote Import created.
