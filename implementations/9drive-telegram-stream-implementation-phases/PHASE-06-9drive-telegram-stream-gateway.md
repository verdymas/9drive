# Phase 06 — Add 9Drive `TelegramStreamGateway` and Generic Read Routing

## Goal

Integrate `telegram-stream` into the 9Drive backend through a clean streaming abstraction. Do not route production WebDAV yet beyond isolated tests.

## Workflow

Audit existing storage/download/read abstractions first. Reuse them.

## Gateway

Create a service conceptually equivalent to:

```text
TelegramStreamGateway
```

Responsibilities:

```text
build signed internal request
forward Range
call telegram-stream
stream response
surface status/range headers
map errors
abort upstream when downstream aborts
```

Do not buffer the response.

## Generic Read Routing

Prefer/reuse a generic router:

```text
StorageReadRouter
  ├── Google → existing flow
  └── Telegram → TelegramStreamGateway
```

Avoid scattered `provider === telegram` checks.

## True Streaming Proxy

Use streaming piping/backpressure.

Never use full-body `arrayBuffer()`/Buffer accumulation for media.

## Header Ownership

Define clearly:

`telegram-stream` owns byte-range mechanics:

```text
status
Content-Range
range Content-Length
Accept-Ranges
```

9Drive owns logical metadata when already available:

```text
Content-Type
Content-Disposition
ETag
Last-Modified
```

Adapt to existing WebDAV behavior.

## Tests

Mock `telegram-stream` and test full stream, 206, 416, abort propagation, no buffering, and unchanged Google path.
