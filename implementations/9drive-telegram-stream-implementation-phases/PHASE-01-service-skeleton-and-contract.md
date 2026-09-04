# Phase 01 — Create `telegram-stream` Service Skeleton and Internal Streaming Contract

## Goal

Create a minimal FastAPI/Python internal service named `telegram-stream`. Do not implement optimized Telegram streaming yet.

## Workflow

PLAN FIRST. Inspect repo conventions, report plan, then implement, test, report.

## Structure

Prefer a clean service layout, adapting to repo conventions:

```text
services/telegram-stream/
├── app/
│   ├── main.py
│   ├── api/
│   │   ├── health.py
│   │   └── stream.py
│   ├── core/
│   │   ├── config.py
│   │   └── errors.py
│   ├── security/
│   │   └── internal_auth.py
│   └── telegram/
├── tests/
├── Dockerfile
└── pyproject.toml / requirements.txt
```

## Internal API

Design a minimal internal stream endpoint, for example:

```text
GET /v1/stream
```

It must identify the physical Telegram object without depending on the Telegram filename.

Potential identity fields:

```text
providerId
channelId
messageId
knownSize
```

Use standard HTTP `Range` header.

Future response semantics:

```text
200 full read
206 valid byte range
416 invalid range
```

Do not return fake 206 responses.

## Health

Add:

```text
GET /health
```

No secrets in response.

## Config

Prepare project-consistent placeholders for:

```env
TELEGRAM_STREAM_HOST=0.0.0.0
TELEGRAM_STREAM_PORT=8081
TELEGRAM_STREAM_INTERNAL_SECRET=
TELEGRAM_STREAM_CHUNK_SIZE_BYTES=1048576
TELEGRAM_STREAM_PREFETCH=3
TELEGRAM_STREAM_PARALLELISM=2
```

## Error Model

Define structured errors for invalid request/range, auth failure, unavailable provider session, file missing, Telegram stream failure, and rate limit.

## Tests

Cover app startup, health, validation, Range parser, invalid ranges, error serialization, and secret leakage.

## Constraints

- No second DB.
- No WebDAV implementation here.
- No Stremio features.
- No Playwright.
