# 9Drive Bottleneck Remediation Pack

This package contains a static bottleneck analysis of the current 9Drive codebase and implementation prompts designed for AI coding agents.

## Contents

- `BOTTLENECK_REPORT.md` — technical report covering the seven main bottlenecks, their impact, evidence, recommended architecture, and validation targets.
- `IMPLEMENTATION_ROADMAP.md` — recommended execution order and dependency notes.
- `prompts/` — standalone implementation prompts, split by bottleneck and phase.

## Language

All documentation and prompts are written in English so they can be used consistently by global AI coding agents.

## How to Use

1. Put this package next to the 9Drive repository or copy the desired prompt into your coding agent.
2. Execute **one phase at a time for the same bottleneck**.
3. Ask the agent to finish tests and documentation updates before moving to the next phase.
4. Do not run two phases that edit the same core files concurrently.
5. Keep `docs/` synchronized with implementation changes.

## Non-Negotiable Product Constraint

Every remediation in this pack is designed to preserve the current 9Drive product surface:

- Google Drive storage
- S3-compatible storage
- Telegram storage
- automatic storage routing
- multipart API upload
- resumable upload
- remote import
- HLS import / FFmpeg pipeline
- WebDAV
- SMB
- Jellyfin-compatible range streaming
- sync and reconciliation
- browser capture / remote fetch workflows
- existing logical filesystem semantics

The goal is to improve efficiency, scalability, isolation, and maintainability **without removing existing capabilities**.

## Important

This report is based on static source-code analysis. Before and after each optimization, collect runtime measurements in the target deployment environment. Do not treat projected improvements as benchmark results.
