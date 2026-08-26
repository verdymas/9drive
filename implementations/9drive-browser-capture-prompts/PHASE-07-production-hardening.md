# Phase 07 — Production Hardening

Harden Browser Capture for real multi-user deployment.

First inspect and plan the complete Browser Capture implementation and existing application security/operations.

Audit:
- extension authentication
- device tokens
- authorization
- resource ownership
- URL validation
- SSRF
- header forwarding
- session/cookie storage
- rate limiting
- CORS/CSRF where applicable
- audit logs
- expiration
- revocation

Device lifecycle:
- register
- rename
- heartbeat
- revoke
- rotate credential
- last seen
- extension version

Provide a 9Drive UI for connected browser devices.

Cleanup:
- expired resources
- stale device sessions
- orphaned metadata

Never delete active Remote Import jobs.

Protect device registration, resource submission/listing, and heartbeat with appropriate rate limits.

Safe observability:
- active devices
- captured resources
- imports created
- expired resources
- failures
- relay failures

Never log secrets or complete signed URLs.

Ensure extension package:
- versioned
- reproducible
- downloadable from 9Drive
- manual installation documentation
- documented permissions

Document only browsers actually tested.

When backend is unavailable, extension retains pending resources locally with bounded retry.

Final regression:
- backend tests
- frontend tests
- extension tests
- lint
- typecheck
- build
- migrations
- integration tests

Verify:
Remote Import
Cloudflare Worker
HLS
FFmpeg/remux
Storage
WebDAV
Jellyfin integration

Do not use Playwright.

Finish with a production-readiness report and remaining limitations.
