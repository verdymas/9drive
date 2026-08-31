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

# Phase 05 — Improve Metadata Collection

Collect safe page/media identity where available:

```text
pageUrl
pageTitle
ogTitle
twitterTitle
mediaTitle
thumbnail
duration
quality
resolution
```

Collect response metadata where possible:

```text
originalUrl
finalUrl
contentType
contentLength
contentDisposition
```

Requirements:
- collect metadata early
- preserve original/final URL separately
- do not expose signed query values
- do not log Cookie/Authorization/tokens
- do not duplicate sensitive headers into generic capture metadata
- reuse existing schemas where practical
