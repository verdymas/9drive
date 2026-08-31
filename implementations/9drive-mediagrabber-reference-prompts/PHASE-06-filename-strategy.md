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

# Phase 06 — Filename Strategy by Resource Type

Do not rebuild the existing canonical filename pipeline from scratch.

## Direct File

Prefer:

```text
customFilename
> Content-Disposition filename*
> Content-Disposition filename
> HTML download attribute
> final URL basename
> request URL basename
> page metadata
> fallback
```

## Media Stream

For HLS/DASH/streaming media prefer:

```text
customFilename
> media/player title
> og:title
> twitter:title
> clean document.title
> meaningful stream metadata
> manifest basename only as last fallback
```

Example:

```text
manifest: /1080/index.m3u8
og:title: Big Buck Bunny
quality: 1080p
output: mkv
→ Big Buck Bunny 1080p.mkv
```

Penalize technical names such as `index`, `playlist`, `master`, `manifest`, `1080`, etc.
