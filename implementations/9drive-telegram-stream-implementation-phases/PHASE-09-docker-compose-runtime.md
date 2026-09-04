# Phase 09 — Docker Compose Integration and Runtime Configuration

## Goal

Integrate `telegram-stream` as an internal service in the existing 9Drive container stack.

## Compose

Add the service using existing conventions:

```text
frontend
backend
worker
redis
mysql
telegram-stream
```

Prefer internal exposure only, e.g. `expose: 8081`, not a public host port.

## Backend Config

Add project-consistent environment variables for the node URL and internal secret.

## Streaming Config

Expose only useful tuning values such as chunk size, prefetch, parallelism, timeouts.

Use conservative defaults.

## Healthcheck

Add Docker healthcheck to `/health`.

If `telegram-stream` is unhealthy, Telegram reads should fail clearly, but Google Drive WebDAV must remain functional.

## Resource Behavior

Document CPU/memory expectations. Do not use whole-file temp/cache storage by default.

## Development Docs

Document build/start/restart/log/health commands using the repo's existing workflow.

## Tests

Verify backend DNS connectivity, signed request, healthcheck, missing-secret behavior, and Google isolation when stream service is down.
