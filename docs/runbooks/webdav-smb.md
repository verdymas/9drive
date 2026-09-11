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

For metadata latency or stale listings, inspect structured `[webdav-metadata]`
logs. They report lookup kind, hit/miss/bypass/error outcome, duration, and
current entry count without logging paths or credentials. The default cache
TTL is 1 second, so a rename, move, or delete becomes visible after at most
that window; set `WEBDAV_METADATA_CACHE_TTL_MS=0` to diagnose the uncached
query path.

## SMB
SMB requires Samba to be available in the relevant host/container environment. Check `/smb/status`, the configuration path/allowed root, then use `/smb/reload` after changing shares or users.

`SMB_ENABLED`, `SMB_CONFIG_PATH`, and `SMB_ALLOWED_ROOT` control environment behavior.
