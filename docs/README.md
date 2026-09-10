# 9Drive — Agent Documentation Index

This documentation is a **knowledge base for coding agents**. Its purpose is not to replace the source code, but to provide the minimum context needed before an agent modifies the codebase.

> **Primary rule:** do not read the entire `docs/` directory for every task. Start with this file, choose the relevant area, then inspect only the source paths referenced by the selected documentation.

## Project Snapshot

9Drive is a storage gateway with an **Express + TypeScript + Prisma/MySQL** backend and a **React + Vite** frontend. It unifies multiple storage providers into one logical virtual filesystem, primarily **Google Drive, S3-compatible storage, and Telegram**. Other capabilities include direct uploads, URL/HLS remote imports, a browser-capture extension, provider-to-virtual synchronization, read-only WebDAV, Samba/SMB management, sharing, API keys, and remote fetch workers.

Additional runtime components:

- Redis + BullMQ for Remote Import and Telegram Sync queues.
- FFmpeg/ffprobe for HLS Remote Import processing.
- A Cloudflare Worker can be used as a remote fetch relay.
- WebDAV is served directly by the backend; SMB is managed through an external Samba service.

## Agent Reading Protocol

1. Read **this file only** first.
2. Select one or two documents from the task-routing table below.
3. Read the selected folder's `README.md` only if you do not yet know the exact document.
4. Inspect the source code listed under `Related Files` in the relevant document.
5. Do not scan the whole repository unless the documentation is demonstrably insufficient.
6. After implementation, update affected docs whenever behavior, contracts, state, routes, schema, architecture, or workflows change.

## Task → Minimum Docs

| Task | Start with |
|---|---|
| Understand overall architecture | `reference/architecture.md` |
| Change auth/login/Google sign-in | `application/features/authentication.md` |
| Add/change a storage provider | `application/domain/storage-account.md` + `application/features/connected-storage.md` |
| Change virtual files/folders | `application/domain/virtual-filesystem.md` + `application/features/files-and-folders.md` |
| Change upload placement/routing | `application/domain/upload-routing.md` + `application/workflows/direct-upload.md` |
| Change Remote Import | `application/features/remote-imports.md` + `application/workflows/remote-import.md` |
| Change HLS/FFmpeg processing | `application/integrations/ffmpeg-hls.md` + `application/features/remote-imports.md` |
| Change provider sync | `application/features/provider-sync.md` + `application/workflows/provider-sync.md` |
| Change Telegram storage/sync | `application/features/telegram-storage.md` + `application/workflows/telegram-reconciliation.md` |
| Change browser extension/capture | `application/features/browser-capture.md` + `application/workflows/browser-capture-to-import.md` |
| Change Remote Fetch Workers | `application/features/remote-fetch-workers.md` |
| Change WebDAV/SMB | `application/features/webdav-and-smb.md` |
| Look up API endpoints/routes | `reference/backend-routes.md` |
| Look up database models | `reference/database-schema.md` |
| Look up environment/config | `reference/environment.md` |
| Run the project | `runbooks/local-development.md` or `runbooks/docker.md` |
| Troubleshoot runtime issues | `runbooks/README.md` |

## Documentation Map

```text
docs/
┣ adr/                         # important architectural decisions
┣ application/
┃ ┣ domain/                    # mental model + business invariants
┃ ┣ features/                  # capabilities by feature
┃ ┣ integrations/              # external providers/services
┃ ┗ workflows/                 # end-to-end flows across modules
┣ reference/                   # fast technical lookup
┣ runbooks/                    # operations and troubleshooting
┗ README.md                    # agent entry point
```

## Source-of-Truth Rule

When information conflicts, use this authority order:

1. **Current source code + Prisma schema + latest migrations**.
2. Documentation in this knowledge base.
3. Older repository documentation such as `docs/REMOTE_IMPORTS.md`, `docs/SYNC.md`, `docs/WORKERS.md`, and `docs/implementation/*`.
4. Root `README.md`.

This knowledge base was generated from the current codebase snapshot. If code changes without a corresponding documentation update, the source code wins.
