# Server Browser (Remote Chromium) — Stage 1 MVP

An authenticated **Tools → Server Browser** page embeds a real Chromium
browser running on the server. This stage delivers browser access and session
lifecycle only — no download detection or Remote Import integration (those are
Stage 2/3, see `implementations/9drive-remote-browser/`).

## Architecture

- **Session metadata** (`ServerBrowserSession` rows): opaque uuid id, owning
  user, `starting | ready | stopped | expired | failed` status, container
  correlation name, hashed one-time view token, creation/expiry timestamps.
  Every operation re-checks ownership; unknown, malformed, and foreign ids all
  return the same `BROWSER_SESSION_NOT_FOUND`.
- **Browser backend**: one `kasmweb/chromium:1.19.0` (pinned KasmVNC) container
  per session, launched by the backend through the Docker CLI (`execFile` with
  argument arrays — never shell strings, never user input). KasmVNC was chosen
  over alternatives because it ships a complete remote-display web UI over
  HTTP+WebSocket (no custom streaming protocol to build) and runs unprivileged
  with per-container resource bounds.
- **Isolation**: `--cap-drop ALL`, `no-new-privileges`, `--pids-limit`,
  memory/CPU caps, per-session named profile volume (wiped on stop/expire),
  no published ports, no Docker socket inside browser containers.
- **Display gateway**: the backend proxies HTTP (`undici`, self-signed-OK only
  on the private browser network) and WebSocket (`upgrade` relay over TLS) to
  the owning session's own container display port (`6901`) only. The iframe
  embeds a short-lived one-time view token (minted via an authenticated call),
  so the app access/refresh tokens never travel in a URL. DevTools (`9222`) is
  never mapped and no route can reach it.
- **Egress**: browser containers live on the `internal: true` `browser_net`
  with no internet route; the sole egress is the pinned
  `ubuntu/squid:5.2-22.04_beta` forward proxy (`services/browser-egress/`),
  which denies loopback, private ranges, link-local/cloud-metadata
  (`169.254.169.254`), and other non-public space and allows only HTTP plus
  `CONNECT` to 443. Squid re-resolves DNS per request, so redirects and DNS
  rebinding are re-checked — application URL validation alone is not relied on.

## API

Bearer-authenticated control routes plus a token-bound display gateway:

- `POST /server-browser/sessions` → `201 { session }`
  (`503 BROWSER_UNAVAILABLE` when disabled/unavailable,
  `409 BROWSER_SESSION_LIMIT` when per-user/global caps hit).
- `GET /server-browser/sessions` → `{ sessions }` (caller's own, newest 10).
- `GET /server-browser/sessions/:id` → `{ session }` (opportunistically
  promotes `starting` → `ready` once the container is up).
- `DELETE /server-browser/sessions/:id` → `{ session }` stopped; container and
  profile volume removed (idempotent).
- `POST /server-browser/sessions/:id/view-token` → `{ token, expiresAt }`.
- `GET /server-browser/sessions/:id/display/*?token=` → proxied KasmVNC UI.
- `upgrade /server-browser/sessions/:id/display/*?token=` → WS relay.

Safe error codes: `BROWSER_UNAVAILABLE`, `BROWSER_SESSION_LIMIT`,
`BROWSER_SESSION_NOT_FOUND`, `BROWSER_SESSION_EXPIRED`,
`BROWSER_SESSION_NOT_ACTIVE`, `DISPLAY_TOKEN_REQUIRED/INVALID/EXPIRED`,
`BROWSER_DISPLAY_UNAVAILABLE`. Daemon internals, cookies, credentials, and
full URLs are never logged or returned.

## Lifecycle and cleanup

- Sessions expire after `SERVER_BROWSER_SESSION_TTL_MINUTES` (default 60).
- Startups hanging past `SERVER_BROWSER_STARTUP_TIMEOUT_SECONDS` fail.
- A sweeper (`SERVER_BROWSER_SWEEP_INTERVAL_SECONDS`, default 60s) expires
  timed-out sessions, fails hung/crashed ones, and removes their containers
  and profile volumes. Cleanup is idempotent and ownership-scoped.

## Deployment

1. `docker pull kasmweb/chromium:1.19.0` on the Docker host.
2. Set `SERVER_BROWSER_ENABLED=true` (and `SERVER_BROWSER_VNC_PASSWORD` in
   production) in the backend environment.
3. The `backend` service mounts `/var/run/docker.sock` in
   `docker-compose.yml` (required only for this feature; the socket is never
   mounted into browser containers). Comment it out — and keep the feature
   disabled — when not in use.
4. `docker compose up -d --build`.
5. Restart behavior: `docker compose restart backend browser-egress-proxy`.
   Sessions are DB rows — a backend restart keeps them; the sweeper reaps any
   whose containers did not survive. `docker compose down -v` is NOT required
   and would delete the database.

## UI

`Tools → Server Browser` (`/server-browser`, inside `DriveLayout`):
start/view/stop, `starting | ready | stopped | expired | failed` states, plus
loading, connection-error, reconnect, and expiration handling. On first
connect the embedded KasmVNC UI asks for its own login: user `kasm_user` with
the one-time browser password shown in the 9Drive page at session creation
(`SERVER_BROWSER_VNC_PASSWORD` when the operator fixes one globally). The
gateway forwards only that Basic credential — never the 9Drive bearer token.
The 9Drive login is never entered into the remote browser by this page.

## Tests

- `browser-runner.test.ts` — pinned image, limits, no privileged/published
  ports/socket mounts, proxy env, safe launch errors.
- `server-browser.service.test.ts` — disabled/limit gates, ownership and id
  validation, stop idempotency and cleanup, token issue/verify, sweep
  expiry/crash handling.
- `server-browser.routes.test.ts` — `requireAuth` on every control route,
  display mount present, token rejection, safe 502 mapping.
- `server-browser.gateway.test.ts` — upstream path validation (no open
  proxy), display-port-only targeting, upgrade parsing, no DevTools/port
  exposure in code or compose.
- Existing auth/navigation behavior: unchanged — full backend suite and both
  builds must stay green.

## Known limits (Stage 1)

- Requires the Docker socket in the backend container when enabled — a
  privileged mount. It is opt-in (commented by default), used only through
  fixed `docker` argv, and documented here. A filtered socket proxy is a
  possible follow-up.
- One container per session: per-user default cap is 1, global default cap is
  5. Raise caps only with host headroom for `2g`/2-CPU slots.
- The KasmVNC login (VNC password) is the remote browser's own auth, separate
  from 9Drive auth; operators must distribute it out of band.
