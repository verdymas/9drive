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

# Phase 14 — Final Cleanup and Validation

Ensure:
- no production imports reference `references/MediaGrabber`
- no dependency points to it
- no Docker/build/runtime path references it
- no tests require it at runtime
- no files inside it were modified

Run relevant:

```text
typecheck
lint
unit tests
integration tests
build
```

Final report:
1. MediaGrabber architecture studied
2. key behavior learned
3. gaps found
4. concepts adapted
5. production files changed
6. tests added
7. remaining limitations
8. confirmation reference folder remained read-only/removable
