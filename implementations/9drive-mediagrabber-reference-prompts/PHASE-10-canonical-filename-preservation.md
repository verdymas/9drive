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

# Phase 10 — Preserve Canonical Filename End-to-End

Target:

```text
detected metadata
→ suggestedFilename
→ optional customFilename
→ Remote Import canonical filename
→ download/remux
→ provider upload
→ File.name
```

Once custom/canonical filename exists, do not replace it with manifest basename, URL basename, temp output name, or UUID.

For HLS/DASH only adjust the final extension/container when required.

Audit queue payload, retry, FFmpeg output, Google Drive, S3, and final File registration.
