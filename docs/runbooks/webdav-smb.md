# Runbook: WebDAV / Jellyfin / SMB

## WebDAV

Check configuration:

```bash
curl http://localhost:4000/webdav/status
```

If `configured=false`, set `WEBDAV_PASSWORD` and restart the backend.

The mount URL uses `/webdav`. The backend is intentionally read-only. For rclone/Jellyfin, PROPFIND `href` values are prefixed with `/webdav` through `req.baseUrl`.

If listing works but playback fails:

1. Test a normal GET request for a file.
2. Test HTTP Range/seek behavior.
3. Check provider-specific streaming (`stream-file.ts`, Telegram open-document, Google range/export).
4. Check WebDAV authentication and ensure the reverse proxy does not strip the `Range` header.

## SMB
SMB requires Samba to be available in the relevant host/container environment. Check `/smb/status`, the configuration path/allowed root, then use `/smb/reload` after changing shares or users.

`SMB_ENABLED`, `SMB_CONFIG_PATH`, and `SMB_ALLOWED_ROOT` control environment behavior.
