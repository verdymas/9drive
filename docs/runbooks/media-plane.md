# Runbook: Optional Media Plane

By default 9Drive runs **one** backend process that serves every route,
including long file streams and WebDAV. The optional media plane is a second
process that serves ONLY the stream-heavy routes, so long transfers cannot
starve short API requests. It is entirely opt-in and reversible; nothing here
changes when it is not deployed.

The media app and the all-in-one app are assembled from the same factories in
`backend/src/app-composition.ts` (`createControlPlaneApp()` /
`createMediaPlaneApp()`), binding the same router and handler instances —
auth, API keys, public tokens, range semantics, and WebDAV behavior are
shared code, not re-implementations.

## Routes classified as media

| Prefix | Why |
|---|---|
| `GET /files/preview/:token` | token-scoped byte stream (proxy path) |
| `GET /files/:id/download` | authenticated attachment/inline byte stream |
| `POST /files/batch-download` | zip archive stream |
| `GET /public/files/:token`, `/download`, `/preview` | share-streamed bytes + metadata JSON |
| `GET /webdav` (+ all WebDAV methods) | PROPFIND/GET streaming |
| `GET /health` | readiness for this process only (no queue probe) |

Everything else (auth, uploads, folders, files metadata, admin) stays on the
control plane. `GET /health` on the media plane returns
`{ status: 'ok', plane: 'media' }`; use it for the proxy's health checks on
routed paths — it intentionally does not open Redis/BullMQ.

## Running it (Docker)

The compose `backend` block is a YAML anchor (`&backend-env`), so the media
service inherits the same required environment by definition.

```bash
docker compose --profile media up -d
docker compose --profile media logs -f media
curl http://localhost:4001/health   # {"status":"ok","plane":"media"}
```

## Running it (bare process)

```bash
cd backend && npm run build
MEDIA_SERVER_ENABLED=true MEDIA_SERVER_PORT=4001 npm run start:media
```

With `MEDIA_SERVER_ENABLED` unset the entry process exits 0 immediately — the
image can host both modes.

## Reverse-proxy routing (public URLs do not change)

Route ONLY the media prefixes to the media process; everything else keeps
going to `backend:4000`. Example nginx block (placed above the generic API
`location /api/`):

```nginx
location ^~ /files/preview/ { proxy_pass http://media:4001; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; proxy_buffering off; }
location ^~ /public/files/  { proxy_pass http://media:4001; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; proxy_buffering off; }
location ^~ /webdav         { proxy_pass http://media:4001; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; proxy_buffering off; }
```

Notes:
- `GET /files/:id/download` and `POST /files/batch-download` are
  id/method-specific paths under the same prefix as metadata APIs
  (`GET/PATCH/DELETE /files/...`). Simple path prefixes cannot single them out
  — use an exact matcher or regex `location` (`~* ^/files/[^/]+/download$`) if
  you want them on the media plane; otherwise leave them on the control plane.
  Leaving ANY media route on the control plane is always safe — that process
  serves every path in every mode.
- `app.set('trust proxy', true)` is active on both planes, so client-IP and
  protocol behavior (rate/session metadata) survives proxying.

## Graceful shutdown / draining

Both processes use `attachHttpLifecycle` (`backend/src/server-lifecycle.ts`):
on `SIGTERM`/`SIGINT` the listener stops accepting connections, active
requests (including in-flight streams) get a bounded window set by
`MEDIA_SERVER_SHUTDOWN_DRAIN_TIMEOUT_MS` (default 30 s, capped at 120 s) to
finish, and only after that are remaining sockets destroyed. The media plane
then disconnects Prisma; the all-in-one server additionally closes its queue
connections as before. Draining never mutates application state — file
registration only happens on fully completed control-plane requests.

## Rollback

Stop the media service (`docker compose --profile media down` or remove the
proxy rules). No schema, config, or client change is involved: the all-in-one
backend already serves every media prefix, so external URLs keep working
unchanged the instant the proxy stops routing to `media`.

## Health expectations

- Control plane `GET /health`: `{ status: "ok", remoteImportQueue: { redis, worker } }`.
- Media plane `GET /health`: `{ status: "ok", plane: "media" }` (synchronous, no Redis).
- During a drain (both planes) the listener is already closed, so health probes
  fail fast — that is the readiness signal; keep draining bounded short.
