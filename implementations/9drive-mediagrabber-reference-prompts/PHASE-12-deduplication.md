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

# Phase 12 — Deduplication

Improve duplicate detection without over-grouping.

Consider:

```text
page identity
logical media title
master/variant relationship
normalized URL
resource type
quality
manifest relationship
```

Requirements:
- repeated detection should not create duplicate cards
- quality variants should be grouped, not discarded
- unrelated videos on same page remain separate
- imported/removed resources should not unexpectedly reappear without a new detection event
