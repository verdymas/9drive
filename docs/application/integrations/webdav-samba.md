# Integration: WebDAV and Samba

## WebDAV
The `webdav-server` package exposes a read-only virtual filesystem inside Express. Authentication uses a dedicated WebDAV password rather than the dashboard JWT.

## Samba
Samba is an external daemon. The backend edits/validates its configuration and executes CLI/service operations through `SambaService`.

## Generic Protocol Contract
`backend/src/modules/storage/storage-protocol.ts` defines health/share/user/reload abstractions that can be extended for other storage protocols.
