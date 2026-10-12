# Stage 1 — Implement Server Browser MVP in 9Drive

## Objective

Implement an authenticated Server Browser feature in 9Drive. Users must be able to open and interact with a real Chromium browser running on the server, displayed inside the existing 9Drive interface.

The server browser is a remote interactive browser session, not an iframe that attempts to load arbitrary websites directly. Use Chromium with KasmVNC or a compatible, maintainable remote-browser display solution, choosing the smallest architecture that fits the existing repository and deployment setup.

This stage delivers browser access and session lifecycle only. Do not implement download detection or Remote Import integration yet.

## Read First — Keep Scope Narrow

1. Read `AGENTS.md` and the relevant documentation index if present.
2. Inspect the existing authentication flow, frontend routing/layout, backend API conventions, Docker deployment configuration, reverse-proxy setup, and focused tests.
3. Inspect only files directly involved in those areas.

Do not perform a repository-wide audit. Do not replace the existing application architecture, framework, authentication, routing, or UI conventions.

Before implementing, briefly state the proposed architecture, the relevant files, and any deployment assumptions. Then implement the feature.

## Functional Requirements

### 1. Server Browser page

Add a page under the existing authenticated application with a clear navigation entry such as **Tools → Server Browser**.

Users must be able to:
- Start a browser session.
- View the actual remote Chromium browser in the page.
- Interact with pages, browser controls, and websites normally.
- End the session explicitly.
- See session states such as starting, ready, stopped, expired, or failed.

Use the browser's actual navigation interface unless an existing supported embedding approach requires a separate control bar. Do not attempt to bypass third-party `X-Frame-Options` or CSP restrictions to display ordinary websites in a local iframe.

Provide loading, connection-error, reconnect, and session-expiration states consistent with the existing UI.

### 2. Backend session management

Follow the existing backend patterns. Add the minimal persistent metadata or session-management mechanism required by the project.

A session must be associated with the authenticated user and have:
- An opaque, unguessable session identifier.
- An explicit lifecycle state.
- Creation and expiration timestamps.
- A way to stop the session and clean up its resources.

Enforce ownership on every operation. One user must never be able to access, control, inspect, or terminate another user's session.

Support configurable limits for concurrent sessions, session lifetime, and startup timeouts. Return safe error messages without leaking internal container or service details.

### 3. Isolated browser service

Run the browser as a separate, maintainable service using the repository's existing Docker conventions.

Requirements:
- Pin container image versions; avoid floating `latest` tags.
- Run without privileged mode and with the least permissions practical.
- Isolate browser profiles, cookies, local storage, and temporary files between users and sessions.
- Apply CPU, memory, process, and storage limits.
- Do not expose Chromium DevTools Protocol or raw internal browser-service ports publicly.
- Route browser display traffic through an authenticated gateway or reverse proxy.
- Support WebSocket traffic where the display technology requires it.
- Keep secrets and deployment configuration out of source control.

Do not expose the Docker socket to the browser container.

If KasmVNC is incompatible with the project's deployment model, explain why and choose the smallest viable alternative. Do not build a custom streaming protocol.

### 4. Network security

A remote browser is capable of making arbitrary network requests, so enforce outbound-network restrictions.

Prevent access to:
- Loopback and private IP ranges.
- Link-local addresses and cloud metadata endpoints.
- Docker service networks and internal administrative services.
- Internal 9Drive endpoints that are not explicitly authorized.

Account for redirects and DNS rebinding. Apply network-level egress restrictions where possible; application-level URL validation alone is insufficient.

Do not weaken existing infrastructure security to make the browser work.

### 5. Cleanup and operational behavior

- Stop and clean up expired or abandoned sessions.
- Handle browser crashes and container termination.
- Avoid leaving orphan containers or temporary volumes.
- Add only the operational logging needed for lifecycle diagnosis.
- Never log browser cookies, credentials, or full sensitive URLs.

Document the minimum required environment variables, Docker services, reverse-proxy configuration, and deployment/restart steps. Update the existing documentation structure instead of creating an unrelated documentation system.

## Tests

Add focused tests for:
1. Authentication is required to create or access a session.
2. Session ownership is enforced.
3. Invalid or expired session IDs are rejected.
4. Session creation, stop, expiration, and cleanup work.
5. Session limits are enforced.
6. Browser service ports and DevTools endpoints are not publicly exposed through application routes.
7. Existing authentication and navigation behavior remains unchanged.

Run focused tests and relevant existing regression tests. Report any integration tests that could not run and why.

## Non-Goals

- Do not implement media-request capture.
- Do not implement an import queue or provider uploads.
- Do not change the existing Remote Import routing behavior.
- Do not add a general-purpose proxy endpoint.
- Do not refactor unrelated modules.

## Definition of Done

The authenticated user can start, use, and stop an isolated remote Chromium browser from 9Drive. Session ownership, resource limits, egress restrictions, and cleanup are enforced. The deployment instructions and focused test results are documented.

## Final Report

Summarize the architecture, files changed, new environment/deployment requirements, security controls, tests, and any unresolved issues.