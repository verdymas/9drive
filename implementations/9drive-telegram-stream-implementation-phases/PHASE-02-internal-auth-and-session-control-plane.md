# Phase 02 — Internal Authentication and Telegram Session Control Plane

## Goal

Secure backend → `telegram-stream` requests and implement the session strategy decided in Phase 00.

## Workflow

PLAN FIRST, then implement and test.

## Signed Internal Requests

Use a shared secret and HMAC-signed internal requests.

Signature input should cover the security-relevant request fields, such as:

```text
timestamp
method
path
providerId
channelId
messageId
Range
```

Requirements:

- constant-time comparison
- expiration window
- malformed request rejection
- reasonable replay resistance
- no secrets in query strings/logs

## Backend Config

Add to `.env.example` using project conventions:

```env
TELEGRAM_STREAM_NODE_URL=http://telegram-stream:8081
TELEGRAM_STREAM_INTERNAL_SECRET=
```

## Session Strategy

Use Phase 00 findings.

Requirements:

- Do not give stream service direct Prisma/MySQL access unless proven necessary.
- Scope session material to the configured Telegram storage provider/account.
- Never log session strings/API hash/OTP/password.
- Cache reusable client/session config safely.
- Support invalidation and reconnect.
- If existing 9Drive session format is not PyroFork-compatible, create a clean streaming-session provisioning flow instead of unsafe format conversion guesses.

## Authorization Boundary

`telegram-stream` must not become an arbitrary Telegram file proxy.

Every request must be bound to an authorized known provider/session.

## Tests

Cover valid/invalid/expired signatures, provider mismatch, session unavailable, secret leakage, session resolution, and invalidation.
