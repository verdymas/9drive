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

# Phase 07 — Logical Media Grouping

Study MediaGrabber's grouping behavior and adapt the concept conservatively.

Example:

```text
master.m3u8
1080.m3u8
720.m3u8
480.m3u8
audio.m3u8
```

may become:

```text
Big Buck Bunny
HLS Stream

Variants:
- 1080p
- 720p
- 480p
```

Requirements:
- preserve original URLs
- keep specific variant import possible
- do not over-group unrelated media
- represent master/variant/audio relationships explicitly when derivable
