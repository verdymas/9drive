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

# Phase 02 — Reverse Engineer MediaGrabber

Inspect `references/MediaGrabber` as a real implementation.

Focus on:
- background/service worker
- content scripts
- HLS/DASH/direct media detection
- media/player metadata
- page title extraction
- quality/resolution
- duration/thumbnail
- grouping
- popup data model
- filename generation
- download preparation

Trace the actual flow and identify:
- important files
- detection architecture
- media identity model
- metadata propagation
- grouping behavior
- title/filename behavior
- useful concepts to adapt
- concepts that should not be copied

Do not modify the reference repository.
