# Telegram Stream — Live Validation Runbook (Phase 11)

This runbook executes the **Jellyfin + rclone E2E** validation that
the Phase 11 spec requires. It must be run by the operator against a
real 9Drive deployment with a real Telegram user account and a real
storage channel. **There are no live credentials in this repo.**

## Pre-flight

1. The stack is up and the streaming service is healthy.

   ```bash
   docker compose ps telegram-stream
   docker compose logs --tail=20 telegram-stream | grep stream_start
   curl -s http://localhost:8081/health    # 200 {"status":"ok",...}
   ```

2. A Telegram storage account is connected (account status
   `connected`, not `reauth_required`).

3. No session provisioning step exists. `telegram-stream` fetches
   `{apiId, apiHash, session}` from the backend on first use
   (`GET /telegram/stream/credentials/:connectedAccountId`, HMAC-signed,
   internal network only) and keeps them in memory. A connected 9Drive
   Telegram account is a streamable one.

   If playback returns `503 TELEGRAM_REAUTH_REQUIRED`, the stored session
   has been revoked by Telegram — reconnect the account in the 9Drive UI.
   The account is flipped to `reauth_required` automatically on the first
   such failure, so the UI prompts for it. To confirm independently:

   ```bash
   # Prints only booleans; never echo a session string.
   docker compose exec -T telegram-stream python - <<'PY'
   import asyncio, hashlib, hmac, json, os, time, urllib.request
   from telethon import TelegramClient
   from telethon.sessions import StringSession
   acct = os.environ["ACCT"]           # connected account id
   secret = os.environ["TELEGRAM_STREAM_INTERNAL_SECRET"]
   path = f"/telegram/stream/credentials/{acct}"
   ts = int(time.time())
   sig = hmac.new(secret.encode(), f"{ts}\nGET\n{path}\n".encode(), hashlib.sha256).hexdigest()
   req = urllib.request.Request(
       os.environ["TELEGRAM_STREAM_BACKEND_URL"].rstrip("/") + path,
       headers={"X-Stream-Timestamp": str(ts), "X-Stream-Signature": sig})
   c = json.loads(urllib.request.urlopen(req, timeout=15).read())
   async def main():
       client = TelegramClient(StringSession(c["session"]), c["apiId"], c["apiHash"])
       await client.connect()
       print("authorized =", await client.is_user_authorized())
       await client.disconnect()
   asyncio.run(main())
   PY
   ```

## WebDAV contract (read this if anything else is unclear)

See `docs/implementation/telegram-stream.md` for the exact curl
commands. Every command there uses the operator's existing WebDAV
credentials — **no secrets appear in the doc**.

## Jellyfin validation

1. **Add a library** pointing at the 9Drive WebDAV endpoint
   (`http://backend:4000/webdav`) with the existing WebDAV
   credentials.
2. **Scan** the library. Telegram-backed files must appear with their
   **9Drive logical name** (the file name, not the Telegram physical
   filename).
3. **Play** a Telegram-backed video. The first frame must appear
   within a few seconds (TTFB target: < 5 s).
4. **Seek forward and backward** repeatedly. Every seek must:
   - Open a new range request (visible in `docker compose logs
     backend | grep "telegram-stream"` as a new `requestId`).
   - Cancel the old range (a new `stream_end` line with
     `cancelled=true` for the old request).
   - Cause no full-file re-download.
5. **Resume** after pause. Same as seek; new range, no re-login.
6. **Larger file** (a multi-GB Telegram video). Verify the playback
   remains stable for 5+ minutes. Watch `active_streams` in `/ready` —
   it must return to 0 after the last seek, not climb.
7. **Google regression**: play a Google Drive-backed file in the same
   Jellyfin instance. The WebDAV Google path must still work.

## rclone validation

1. List the WebDAV root:

   ```bash
   rclone ls :webdav: --webdav-url=http://localhost:4000/webdav \
     --webdav-user=$WEBDAV_USER --webdav-pass=$WEBDAV_PASSWORD
   ```

2. Copy a Telegram-backed file:

   ```bash
   rclone copy :webdav:Movies/movie.mp4 /tmp/ --progress
   ```

3. Checksum (if practical):

   ```bash
   sha256sum /tmp/movie.mp4
   ```

4. Verify the rclone output bytes match the size in the 9Drive DB.

## Metrics to capture

Pull these into `docs/audits/telegram-stream-benchmark.md` (§10) once you
have numbers.

- TTFB (first byte after seek) — from `ttfb_ms` in the `stream_end` JSON line.
- Average Mbps — from `avg_mbps` in the same line.
- FloodWait count — `total_flood_waits` in `/ready`.
- FILE_REFERENCE refresh count — `total_file_reference_refreshes` in `/ready`.
- Cancellation count — `total_cancellations` in `/ready`.
- Memory peak — RSS of the `telegram-stream` container, via
  `docker stats telegram-stream`.

## If buffering remains

**Do not blindly add parallelism.** Reads are sequential by design (one
512 KiB Telethon request in flight); adding concurrency is an upgrade to
justify with numbers, not a first response. Classify first:

| Metric that points to… | Symptom |
|---|---|
| Slow Telegram | `ttfb_ms` fine but `avg_mbps` low across the whole stream |
| Slow internal proxy | High `ttfb_ms` while `avg_mbps` is healthy once flowing |
| Wrong range | Many `416` responses, or `Content-Range` mismatches in logs |
| Sequential ceiling | `avg_mbps` ≈ 512 KiB / round-trip time — this is when prefetch is worth adding |
| Reconnect per seek | A `TELEGRAM_REAUTH_REQUIRED` or a new client build per range; the client cache is not being reused |
| Client abort issues | `cancelled=true` on ranges that were not seeked away from |
| Rate limits | `total_flood_waits > 0`; lower the chunk size before anything else |

## Deliverable

Append a "Live validation" section to
`docs/audits/telegram-stream-benchmark.md` with the captured numbers
and any bottleneck classification. If a real fix is needed, file an
issue and link it from the doc.
