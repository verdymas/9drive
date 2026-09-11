# Feature: WebDAV and SMB

## WebDAV

Backend mount: `/webdav`.

- `GET /webdav/status` does not require WebDAV authentication and only reports whether a password is configured.
- Other requests use the WebDAV authentication middleware.
- The virtual filesystem is read-only: GET/HEAD/PROPFIND are supported; write methods such as PUT/MKCOL/DELETE/MOVE/COPY/PROPPATCH/LOCK/UNLOCK return 403.
- `req.baseUrl` is used as the WebDAV root so PROPFIND `href` values remain correct for clients such as rclone and Jellyfin.
- WebDAV always uses provider proxy streams. It never redirects a client to a
  provider URL, so its authentication, Jellyfin/rclone range behavior, and
  virtual filesystem semantics remain independent of optional future S3 direct
  delivery.
- Provider streams preserve range/status metadata and are torn down when the
  WebDAV client disconnects, preventing abandoned playback seeks from holding
  upstream work open.
- Path resolution uses exact folder/file predicates (`parentId`/`folderId`,
  active/deleted state, and display name) instead of loading all siblings and
  scanning them in JavaScript. Directory enumeration remains a separate
  metadata-only projection path for PROPFIND.
- WebDAV metadata lookups use a bounded process-local TTL cache by default.
  `WEBDAV_METADATA_CACHE_TTL_MS=0` disables it; the default 1-second TTL is
  the maximum documented stale window for rename/move/delete visibility. The
  cache stores metadata only, never provider bytes or decrypted credentials.
- Cache diagnostics use structured `[webdav-metadata]` lookup logs with
  hit/miss/bypass/error outcomes and lookup duration. Cache keys include the
  WebDAV namespace and immutable row/parent identities. The current shared
  password endpoint intentionally uses one shared namespace because its
  existing contract exposes the instance-wide tree to trusted deployments.
- In the optional split deployment, `/webdav` is one of the prefixes the media
  plane serves (the same mounted router, unchanged semantics and path); it
  keeps working inside the default all-in-one process either way. See
  `docs/runbooks/media-plane.md`.

Files:

- `backend/src/modules/webdav/webdav.routes.ts`
- `backend/src/modules/webdav/webdav-virtual-fs.ts`
- `backend/src/modules/webdav/webdav-auth.middleware.ts`

## SMB

9Drive **does not implement an SMB server**. `SambaService` manages an external Samba service through CLI/configuration files.

Base `/smb` uses bearer authentication and supports share CRUD, reload, health/status, and user management.

Files:

- `backend/src/modules/smb/smb.routes.ts`
- `backend/src/modules/smb/samba.service.ts`
- `backend/src/modules/smb/samba-cli.ts`
- `backend/src/modules/storage/storage-protocol.ts`
- `frontend/src/pages/SmbPage.tsx`
- `frontend/src/pages/WebDavPage.tsx`
