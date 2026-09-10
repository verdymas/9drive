# Feature: WebDAV and SMB

## WebDAV

Backend mount: `/webdav`.

- `GET /webdav/status` does not require WebDAV authentication and only reports whether a password is configured.
- Other requests use the WebDAV authentication middleware.
- The virtual filesystem is read-only: GET/HEAD/PROPFIND are supported; write methods such as PUT/MKCOL/DELETE/MOVE/COPY/PROPPATCH/LOCK/UNLOCK return 403.
- `req.baseUrl` is used as the WebDAV root so PROPFIND `href` values remain correct for clients such as rclone and Jellyfin.

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
