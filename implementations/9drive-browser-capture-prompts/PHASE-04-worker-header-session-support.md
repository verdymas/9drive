# Phase 04 — Worker, Header, and Session Support

Make Browser Capture reliable for resources requiring browser request context while keeping security strict.

First inspect and plan existing RemoteFetchTransport, Cloudflare relay protocol, header forwarding, SSRF, secret handling, and Remote Import retry behavior.

Separate:
Safe context:
- Referer
- Origin
- User-Agent
- Range
- selected Accept headers

Sensitive context:
- Cookie
- Authorization
- signed URLs
- bearer tokens

Create/reuse a header policy/allowlist. Strip Host, Content-Length, Connection, Transfer-Encoding, internal proxy headers, and application secrets.

If session/cookie support is required, use short-lived encrypted storage:
- encrypted at rest
- TTL
- scoped to user/device/resource
- never logged
- revocable
- automatically expired

Do not build a persistent browser-cookie vault.

When a Worker is selected, all network requests must use the selected transport:
HEAD, GET, Range GET, HLS manifest, variants, segments, key/map where applicable.

Never silently fall back to Direct.

Keep errors distinct:
- WORKER_UNHEALTHY
- WORKER_RELAY_PROTOCOL_ERROR
- WORKER_UPSTREAM_FETCH_FAILED

Preserve request context across transient retries.

Tests:
- header allowlist
- forbidden headers
- session encryption/expiration
- ownership
- Worker routing
- no secret logs
- no direct fallback

Do not use Playwright.
