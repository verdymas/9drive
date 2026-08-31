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

# Phase 04 — Target Detection Architecture

Refactor only where justified by the gap analysis.

Prefer:

```text
Resource Detection
→ Resource Classification
→ Metadata Enrichment
→ Logical Media Grouping
→ Filename Resolution
→ CapturedResource Store
```

Suggested responsibilities:

```text
ResourceDetector
ResourceClassifier
MediaMetadataCollector
MediaGrouper
FilenameResolver
CapturedResourceStore
```

Reuse existing equivalents where possible. Popup must not own detection logic. Do not import code from the reference folder.
