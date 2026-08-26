# 9Drive Browser Capture — Claude Code `/goal` Prompts

Run the phases sequentially with Claude Code `/goal`.

Rules:
1. Inspect the existing 9Drive architecture and create a plan before implementation.
2. Execute only the current phase.
3. Preserve existing Remote Import, Worker/relay, HLS/remux, storage, and Jellyfin functionality.
4. Reuse existing services, repositories, DTOs, policies, queues, and UI patterns.
5. Keep provider-specific logic behind adapters/drivers.
6. Do not use Playwright.
7. Never commit credentials, cookies, device tokens, signed URLs, or secrets.
8. Run relevant tests, typecheck, lint/build, and migration checks.
9. End each phase with changed files, migrations, APIs, tests, risks, and manual verification.

Architecture target:

User Browser
→ 9Drive Browser Capture Extension
→ 9Drive Backend
→ existing Remote Import pipeline
→ Direct / Cloudflare Worker / future relay
→ Download → HLS remux → Storage

The extension is a capture client, not a downloader or FFmpeg runtime.
