# 9Drive Browser Capture — MediaGrabber Reference

## Global Rules

Reference repository:

```text
references/MediaGrabber
```

Treat it as read-only reference-only source.

You MAY inspect, search, trace, compare, and adapt useful concepts.

You MUST NOT modify files under `references/MediaGrabber`, import runtime code directly from it, add it as a dependency, include it in builds/Docker, couple production runtime to it, or blindly copy large source blocks.

All production changes must be implemented inside the existing 9Drive codebase.

Do not use Playwright.
Do not modify unrelated features.
Preserve existing Browser Capture pairing, Remote Import, Direct/Worker transport, HLS/remux, and storage behavior unless a phase explicitly requires a compatible change.

# Phase 11 — Popup UX

Use richer logical media metadata.

Example:

```text
Big Buck Bunny
HLS Stream
1080p
Estimated size: 2.4 GB
Source: example.com

[Import]
[Remove]
```

For grouped streams expose quality selection.

Requirements:
- show logical title, not technical manifest name
- normalized type labels
- quality/filesize/source where available
- optional raw technical details
- preserve Clear All, badge, import flow, and filename editing
