# 9Drive Telegram Stream — Phase-by-Phase `/goal` Prompts

> **Implementation deviation from this spec:** the shipped service uses
> **Telethon**, not PyroFork, and there is **no session provisioning
> subsystem** (Phase 02's second half). Telethon's `StringSession` carries
> the same four fields as the GramJS/teleproto session 9Drive already
> stores (`dc_id | ip | port | auth_key`), so the stored credential is
> repacked on the fly and no second login exists. This spec is kept
> verbatim as the original requirement; the reasoning and the verification
> are in `docs/audits/telegram-stream-architecture-audit.md` §7.

Target service name: `telegram-stream`.

Architecture:

```text
Jellyfin / rclone
      ↓
Existing 9Drive WebDAV
      ↓
9Drive virtual filesystem
      ↓
Storage read routing
      ├── Google Drive → existing flow
      └── Telegram → telegram-stream
                        ↓
                  FastAPI / Python
                        ↓
                     Telethon
                        ↓
               Telegram MTProto
```

Read-only references:

```text
references/telegram-stremio
references/tgfs
references/telegram-drive-webdav
references/teledrive
```

If missing, clone from:

```text
https://github.com/weebzone/Telegram-Stremio
https://github.com/TheodoreKrypton/tgfs
https://github.com/caamer20/Telegram-Drive
https://github.com/99apps-id/teledrive
```

Rules for every phase:

- Use `/goal` one phase at a time.
- PLAN FIRST → report plan → implement → test → report.
- Do not use Playwright.
- Do not modify reference repositories.
- Do not add reference repositories as dependencies.
- Do not blindly copy their source code.
- Keep 9Drive DB as source of truth for virtual files/folders.
- Do not create a second WebDAV server.
- Do not break Google Drive WebDAV.
- `telegram-stream` is only a specialized Telegram byte-serving service.

Execution order:

1. PHASE-00-audit-and-final-plan.md
2. PHASE-01-service-skeleton-and-contract.md
3. PHASE-02-internal-auth-and-session-control-plane.md
4. PHASE-03-telegram-client-media-session-lifecycle.md
5. PHASE-04-range-byte-stream-engine.md
6. PHASE-05-prefetch-parallelism-backpressure-cancellation.md
7. PHASE-06-9drive-telegram-stream-gateway.md
8. PHASE-07-webdav-telegram-routing.md
9. PHASE-08-observability-health-metrics.md
10. PHASE-09-docker-compose-runtime.md
11. PHASE-10-tests-benchmarks.md
12. PHASE-11-jellyfin-rclone-validation.md
13. PHASE-12-hardening-docs-cleanup.md
