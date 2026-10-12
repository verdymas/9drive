# 9Drive Remote Browser — Progress Tracker

Status key: tick `- [x]` only after code + focused tests + relevant regression + docs for that item pass. Complete Stage 1 first; Stage 2/3 are deferred (see note at bottom).

## Stage 1 — Server Browser MVP (`stage-1.md`) — implemented (2026-10-11)

### 1. Server Browser page (Tools → Server Browser)
- [x] Authenticated page + nav entry under existing layout/routing
- [x] Start / view real remote Chromium / interact / explicit end
- [x] Session states: starting, ready, stopped, expired, failed
- [x] Loading, connection-error, reconnect, expiration states in existing UI style
- [x] No local-iframe workaround for X-Frame-Options/CSP sites

### 2. Backend session management
- [x] Opaque unguessable session ID + lifecycle state + created/expires timestamps
- [x] Ownership enforced on every operation (no cross-user access/control/terminate)
- [x] Configurable concurrent-session, lifetime, startup-timeout limits
- [x] Safe errors without leaking container/service internals

### 3. Isolated browser service (Docker conventions)
- [x] Separate service, pinned image, non-privileged, least-privilege
- [x] Per-user/session profile isolation (cookies, storage, temp files)
- [x] CPU/mem/process/storage limits; no Docker-socket exposure
- [x] CDP / raw browser ports not public; display via authenticated gateway/proxy + WebSocket support
- [x] Secrets/config out of source control

### 4. Network security
- [x] Egress deny: loopback, private ranges, link-local/metadata, Docker nets, unauthorized internal 9Drive endpoints
- [x] Redirect + DNS-rebinding handling; network-level enforcement (not URL-validation only)
- [x] No weakening of existing infra security

### 5. Cleanup + operational behavior + docs
- [x] Expired/abandoned session sweeper; crash/container-termination handling; no orphans
- [x] Minimal lifecycle logging; never log cookies/credentials/sensitive URLs
- [x] Docs: env vars, Docker services, reverse-proxy, restart steps (update existing docs structure)

### 6. Tests (stage-1.md §Tests)
- [x] 1. Auth required to create/access session
- [x] 2. Ownership enforced
- [x] 3. Invalid/expired IDs rejected
- [x] 4. Create/stop/expire/cleanup works
- [x] 5. Limits enforced
- [x] 6. Browser/CDP ports not publicly exposed
- [x] 7. Existing auth + navigation unchanged
- [x] Focused + relevant regression suites run; un-runnable integration tests reported

### 7. Definition of Done + Final Report
- [x] User can start/use/stop isolated Chromium; ownership/limits/egress/cleanup enforced; docs + test results recorded
- [x] Final Report: architecture, files changed, env/deploy, security, tests, unresolved issues

## Note for later phases — explicitly deferred, do NOT implement in Stage 1

Stage 2 (`stage-2.md` — Detect Browser Downloads and Import into 9Drive) and Stage 3 (`stage-3.md` — Browser Download Fallback via isolated temp storage → provider upload) require Stage 1 done first. Per Stage 1 Non-Goals, no media-request capture, import queue/provider uploads, Remote Import routing changes, general proxy endpoints, or unrelated refactors were made while completing the checklist above. Track them in separate Stage 2/3 checklists when those stages start.

## Verification record

- Focused: `cd backend && npx vitest run src/modules/server-browser` → 4 files / 62 tests passed (2026-10-11).
- Backend full suite: `cd backend && npm test` → 122 files / 1325 tests passed (2026-10-11, after fixes below).
- Frontend suite: `cd frontend && npm test` → 13 files / 127 tests passed (2026-10-11).
- Builds: `cd backend && npm run build` → passed (tsc + relay asset + extension zip); `cd frontend && npm run build` → passed (2026-10-11).
- Compose: `docker compose config` → valid, additive-only diff (2026-10-11).
- Prisma: `npx prisma generate` → client regenerated with `ServerBrowserSession` (2026-10-11).
- NOT run (no Docker daemon / live MySQL on this workstation):
  - `npm run prisma:migrate` / `db:migrate:deploy` — migration `20261011000000_server_browser` is hand-written (matches schema) and must be applied through the normal deploy flow before use.
  - Real container launch, KasmVNC UI load, WS relay end-to-end, and Squid egress behavior — covered by unit-tested arg/policy/gateway logic only; needs one `docker compose up` with `SERVER_BROWSER_ENABLED=true` on a Docker host.
  - `docker build` of the backend image with the added `docker-cli` package.
- Live deploy verification (2026-10-11, Docker host):
  - `BROWSER_UNAVAILABLE` root causes fixed: backend lacked the Docker socket mount (compose volume was commented) and Squid crash-looped on `access_log stdio:/dev/stdout` (unwritable by the `proxy` user) — config now logs to the image default dir; socket volume mounted with warning comment.
  - `docker compose config` valid; `browser-egress-proxy` stable (RestartCount 0, listening on 3128); `kasmweb/chromium:1.19.0` pulled.
  - Egress filter proven live from the backend netns: public HTTP → 200, `169.254.169.254` → 403, `10.0.0.5` → 403.
  - Live-debugged startup failures (all fixed, all covered by new tests):
    - Kasm entrypoint aborted under `--cap-drop ALL` + plain `--tmpfs /run` (PulseAudio EPERM) and staticx services died on default noexec `/tmp` → tmpfs now `uid/gid/mode`-owned with `exec` on `/tmp`.
    - Gateway stripped `Authorization`, looping Kasm's Basic login on 401 → Basic is now forwarded, Bearer still stripped.
    - `ready` was container-running instead of display-serving → TLS readiness probe gates promotion (fixes gateway 502 race).
    - Failed launches and timed-out starts leaked profile volumes → both paths now clean up container + volume (3 orphans removed).
    - undici low-level `request()` throws on tuple header arrays → `toUndiciHeaders` record shaping (was every-display 502).
    - undici v7 bodies are Node `BodyReadable`, not WHATWG → `pipeUpstreamBody` pipes directly (was every-display 500).
  - Full live E2E with throwaway user (removed afterward, cascade verified): register → create → starting → ready → view-token → display `401 Basic realm="Websockify"` → stop; zero leftover containers/volumes.
  - WebSocket relay proven live (`101 Switching Protocols` direct AND via nginx): relay bugs fixed were upstream path prefix (`/display/websockify` → `/websockify`, confirmed against the image's noVNC default), head written pre-TLS-handshake (`connect` → `secureConnect`), and missing Host rewrite; nginx `location /api/` gained WebSocket upgrade mapping (without it the Kasm UI loads but never connects through :5178).
  - Kasm auth findings (docs + UI updated): VNC user is `kasm_user` (underscore); empty `VNC_PW` sets an empty password (unusable from login dialogs), so creation now reveals a per-session password once (operator-fixed value wins when set); Basic is forwarded by the gateway, Bearer stripped.
  - Sweeper now also reaps containers with no live row (proven: reaped 2 orphans automatically, volumes included); egress proxy untouched by name-pattern guard.
