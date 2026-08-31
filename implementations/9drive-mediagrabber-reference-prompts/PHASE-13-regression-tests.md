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

# Phase 13 — Regression Tests

Cover at minimum:

```text
Content-Disposition Movie Final.mp4
→ Movie Final.mp4
```

```text
/download?id=123
→ CDN /files/movie.mp4
→ movie.mp4
```

```text
/1080/index.m3u8 + og:title Big Buck Bunny + 1080p
→ Big Buck Bunny 1080p.mkv
```

```text
/master.m3u8 + page title Movie Name
→ Movie Name.mkv
```

```text
/manifest.mpd + media title Movie Name
→ Movie Name.mkv
```

Also test:
- HLS grouping
- custom filename persistence
- Unicode
- badge
- Clear All
- device pairing
- Direct import
- Worker import
- retry
