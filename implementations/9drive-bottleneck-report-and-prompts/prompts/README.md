# AI Agent Prompts

Each file in this directory is a standalone implementation prompt for one phase of one bottleneck.

## Usage

Give **one phase file** to the coding agent at a time.

A prompt intentionally contains enough context to work independently, but the agent must still inspect current source code before editing because earlier phases may have changed file locations or extracted helpers.

## Global Constraints Applied to Every Prompt

- Preserve all current 9Drive features.
- No destructive rewrite.
- No API/route removal unless the prompt explicitly introduces a backward-compatible replacement.
- No provider removal.
- Preserve automatic storage routing and logical filesystem semantics.
- Preserve WebDAV/SMB/Jellyfin compatibility.
- Preserve auth and user isolation.
- Add/update tests.
- Update relevant documentation under `docs/`.
- Do not implement later phases early unless required for correctness.
- Prefer small composable abstractions over new god services.
- Report changed files, test results, migrations/config changes, and remaining risks at the end.

## Recommended Order

See `../IMPLEMENTATION_ROADMAP.md`.
