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

# Phase 01 — Audit Current 9Drive Browser Capture

Inspect the existing extension manifest, background/service worker, content scripts, popup, local capture storage, badge logic, device pairing, Browser Capture APIs, captured resource persistence, Remote Import integration, filename resolver, HLS/DASH handling, and Direct/Worker selection.

Trace:

```text
browser/network/DOM
→ extension detection
→ captured resource
→ popup
→ Browser Capture backend
→ Remote Import
```

Deliver:
- important files/modules
- responsibility of each
- filename mutation points
- metadata collection points
- grouping/deduplication points
- type classification points
- Remote Import payload construction
- current weak points

Do not perform a broad refactor yet.
