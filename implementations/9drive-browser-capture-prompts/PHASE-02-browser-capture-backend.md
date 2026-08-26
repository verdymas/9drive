# Phase 02 — Browser Capture Backend

Add backend support for browser devices and captured resources.

First inspect and plan existing authentication, API conventions, models/repositories, authorization, encryption, rate limiting, audit logging, and Remote Import.

Add a browser device entity following existing naming conventions.

Conceptual fields:
- id
- user_id
- name
- browser
- platform
- extension_version
- securely stored device credential/hash
- last_seen_at
- created_at
- updated_at

Add captured resources:
- id
- browser_device_id
- user_id
- url
- type
- mime_type
- filename
- page_url
- page_title
- safe request context
- status
- detected_at
- expires_at
- created_at
- updated_at

Add indexes for user/device/status/time.

APIs:
- register device
- rotate/revoke credential
- heartbeat
- submit resource
- list pending resources
- mark consumed/submitted
- delete/expire resource

Enforce device ownership and user authorization.

Validate:
- URL syntax
- resource type
- URL/metadata size
- header allowlist
- header value size
- filename size

Treat captured URLs as untrusted input and preserve SSRF/security boundaries.

Add TTL/expiration. Expired resources must not be importable.

Never log cookies, Authorization values, signed URLs, device tokens, or API tokens.

Tests:
- registration
- authorization/ownership
- invalid URL/type
- oversized metadata
- expiration
- revocation
- rate limiting where applicable

Do not implement Remote Import creation yet; prepare a clean integration point.

Do not use Playwright.
