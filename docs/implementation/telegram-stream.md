# Telegram Stream — manual curl examples

These are read-only smoke tests against an existing 9Drive deployment with
`telegram-stream` running as a compose service. **No secrets appear here.**

## Environment

```bash
# From your 9Drive .env (or .env.docker.example).
WEBDAV_USER=alice
WEBDAV_PASSWORD=****         # the operator-controlled WebDAV password
BACKEND=http://localhost:4000
```

## Head (no Telegram call)

```bash
curl -sI -u "$WEBDAV_USER:$WEBDAV_PASSWORD" \
  "$BACKEND/webdav/Movies/movie.mp4"
```

Expected: `200`, `Content-Type: video/mp4`, `Content-Length: <db.size>`,
`Accept-Ranges: bytes`, `ETag`, `Last-Modified`. The body is **not** read;
no Telegram call is made.

## Full GET

```bash
curl -u "$WEBDAV_USER:$WEBDAV_PASSWORD" \
  -o /tmp/movie.mp4 \
  "$BACKEND/webdav/Movies/movie.mp4"
```

Expected: `200`, `Content-Length` matches the DB size, file bytes match
`/tmp/movie.mp4`. This goes through the telegram-stream gateway (Phase 06+).

## Range GET (first 1 MiB)

```bash
curl -u "$WEBDAV_USER:$WEBDAV_PASSWORD" \
  -H 'Range: bytes=0-1048575' \
  -D - -o /tmp/head.bin \
  "$BACKEND/webdav/Movies/movie.mp4"
```

Expected headers:

```
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1048575/<total>
Content-Length: 1048576
Accept-Ranges: bytes
```

`/tmp/head.bin` must be exactly 1 MiB.

## Mid-file Range GET

```bash
curl -u "$WEBDAV_USER:$WEBDAV_PASSWORD" \
  -H 'Range: bytes=10485760-10485823' \
  -D - -o /tmp/mid.bin \
  "$BACKEND/webdav/Movies/movie.mp4"
```

Expected: `206`, `Content-Range: bytes 10485760-10485823/<total>`,
`Content-Length: 64`, `/tmp/mid.bin` exactly 64 bytes.

## Open-ended Range GET

```bash
curl -u "$WEBDAV_USER:$WEBDAV_PASSWORD" \
  -H 'Range: bytes=1048576-' \
  -o /tmp/tail.mp4 \
  "$BACKEND/webdav/Movies/movie.mp4"
```

Expected: `206`, `Content-Range: bytes 1048576-<total-1>/<total>`.

## Invalid Range

```bash
curl -u "$WEBDAV_USER:$WEBDAV_PASSWORD" \
  -H 'Range: bytes=99999999-' \
  -D - -o /dev/null \
  "$BACKEND/webdav/Movies/movie.mp4"
```

Expected: `416`, `Content-Range: bytes */<total>`.

## PROPFIND (unchanged)

```bash
curl -u "$WEBDAV_USER:$WEBDAV_PASSWORD" -X PROPFIND \
  -H 'Depth: 1' \
  "$BACKEND/webdav/Movies/"
```

Expected: 207 multi-status XML listing the file with its 9Drive logical
name `movie.mp4`. **No Telegram call is made here.**

## Google regression

```bash
curl -u "$WEBDAV_USER:$WEBDAV_PASSWORD" \
  -H 'Range: bytes=0-1023' \
  -D - -o /tmp/google-head.bin \
  "$BACKEND/webdav/Drive/some-google-file.bin"
```

Expected: `206`, `Content-Range: bytes 0-1023/<total>`, body 1024 bytes.
Google is **not** routed through telegram-stream.

## When the service is down

```bash
docker compose stop telegram-stream
curl -u "$WEBDAV_USER:$WEBDAV_PASSWORD" \
  -D - -o /dev/null \
  "$BACKEND/webdav/Movies/movie.mp4"
```

Expected: `502` with `{"code":"UPSTREAM_UNAVAILABLE",...}`. Google WebDAV
**must still work** while telegram-stream is offline.
