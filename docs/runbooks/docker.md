# Runbook: Docker

## Services
`docker-compose.yml` defines:

- `mysql` — MySQL 8.4
- `redis` — Redis 7 Alpine, internal network
- `backend` — Express API, port 4000
- `remote-import-worker` — dedicated BullMQ consumer + FFmpeg pipeline
- `browser-egress-proxy` — Squid forward proxy, the sole egress for the
  isolated Server Browser network (internal-only, no host port)
- `frontend` — nginx production build, host port 5178
- (optional, profile `media`) `media` — dedicated media plane on port 4001;
  it is NOT started by a plain `docker compose up`. See
  `docs/runbooks/media-plane.md`.

Persistent/working volumes include MySQL data and Remote Import temporary/upload staging.

## Server Browser (optional)

Disabled by default. Per-session `kasmweb/chromium:1.19.0` containers run on
the `internal: true` `browser_net`; see
`docs/application/features/server-browser.md`. To enable:

```bash
docker pull kasmweb/chromium:1.19.0
```

1. Set `SERVER_BROWSER_ENABLED=true` (plus `SERVER_BROWSER_VNC_PASSWORD` in
   production) in your `.env`.
2. Uncomment the `/var/run/docker.sock` volume under the `backend` service in
   `docker-compose.yml` (required only for this feature).
3. `docker compose up -d --build`.

## Start

```bash
docker compose up -d --build
```

## Verify

```bash
docker compose ps
curl http://localhost:4000/health
```

`/health` should return API status and queue health.

## Logs

```bash
docker compose logs -f backend
docker compose logs -f remote-import-worker
docker compose logs -f redis
```

## Important
The backend and Remote Import worker must use compatible environment values, especially `DATABASE_URL`, `REDIS_URL`, the encryption key, Remote Import/HLS settings, and the temporary-volume path.
