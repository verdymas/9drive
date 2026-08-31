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

# Phase 09 — Preserve Remote Import Architecture

Keep the extension as a capture client.

Target:

```text
Browser Extension
→ capture URL + metadata/context
→ Browser Capture backend
→ Remote Import
→ Direct or selected Worker
→ HLS/DASH/direct downloader
→ FFmpeg if needed
→ Drive/S3
```

Requirements:
- no full HLS downloader in extension
- preserve workerId
- preserve secure request-context handling
- no silent direct fallback when a Worker is selected
- keep live-HLS behavior aligned with existing Remote Import rules
