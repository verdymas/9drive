# Integration: WebDAV and Samba

## WebDAV
The `webdav-server` package exposes a read-only virtual filesystem inside Express. Authentication uses a dedicated WebDAV password rather than the dashboard JWT.

WebDAV path resolution uses indexed exact child lookups. PROPFIND directory
rows select only resource metadata; provider-account credentials are loaded
only when a file stream starts. A small bounded process-local metadata cache is
available for repeated lookups and emits structured `[webdav-metadata]` logs.
It never caches byte streams or decrypted provider credentials.

## Samba
Samba is an external daemon. The backend edits/validates its configuration and executes CLI/service operations through `SambaService`.

## Generic Protocol Contract
`backend/src/modules/storage/storage-protocol.ts` defines health/share/user/reload abstractions that can be extended for other storage protocols.
