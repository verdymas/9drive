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

# Phase 08 — Resource Classification

Normalize types:

```text
hls
dash
video
audio
document
archive
image
unknown
```

Use multiple signals:

```text
URL extension
Content-Type
response headers
manifest content/probe
DOM media metadata
```

Recognize common HLS MIME types and proper DASH/MPD signals.

Do not classify solely from URL extension. Prefer `unknown` over aggressive guessing.
