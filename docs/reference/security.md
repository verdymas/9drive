# Security Reference

## Authentication Boundaries

- Dashboard REST: bearer JWT via `requireAuth`.
- External Upload API: hashed API key + scope via `requireApiKey`.
- Browser extension: hashed device token via `requireDevice`; pairing codes are one-time and expiring.
- WebDAV: dedicated WebDAV authentication, not the dashboard JWT.
- Public file/preview: capability token plus expiry/status checks.

## Secrets at Rest
`backend/src/utils/crypto.ts` is used for reversibly encrypted data. Hashing is used for verifier-only secrets.

## Remote URL Security
Remote Import includes SSRF validation, redirect/timeout/size bounds, and protected request-context scoping. Never replace the secure fetch path with unrestricted `fetch(url)`.

## Logging
Never log:

- source URLs containing token/query secrets;
- cookies or authorization headers;
- Google/S3/Telegram credentials;
- Telegram sessions/API hashes;
- worker secrets/configuration;
- raw refresh-token/API-key values.

Use IDs, sanitized display URLs, safe error codes, and non-secret metadata.

## CORS
The backend grants CORS only to the configured frontend origin and allowed browser-extension schemes defined in `app.ts`.
