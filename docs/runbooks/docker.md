# Runbook: Docker

## Services
`docker-compose.yml` defines:

- `mysql` — MySQL 8.4
- `redis` — Redis 7 Alpine, internal network
- `backend` — Express API, port 4000
- `remote-import-worker` — dedicated BullMQ consumer + FFmpeg pipeline
- `frontend` — nginx production build, host port 5178

Persistent/working volumes include MySQL data and Remote Import temporary/upload staging.

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
