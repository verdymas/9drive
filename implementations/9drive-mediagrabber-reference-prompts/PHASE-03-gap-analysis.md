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

# Phase 03 — Gap Analysis

Compare 9Drive against MediaGrabber for:

- request/MIME/HLS/DASH/MP4/WebM/video-element detection
- dynamic page and MSE handling where relevant
- Content-Disposition
- final URL vs request URL
- HTML download attribute
- media/player title
- og:title, twitter:title, document.title
- manifest basename behavior
- title, quality, resolution, bandwidth, duration, thumbnail
- grouping of master/variant/audio resources
- deduplication
- popup representation

For each gap classify:

```text
keep 9Drive
adapt MediaGrabber concept
needs custom 9Drive solution
defer
```

Do not start a broad refactor in this phase.
