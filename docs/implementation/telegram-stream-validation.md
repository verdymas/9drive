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

3. The `telegram-stream` service has a PyroFork session provisioned.
   This is the **first-time** column write. After a real PyroFork login
   in the streaming service, the control plane
   (`PUT /telegram/stream/session`) is hit and the column is populated.
   For the very first run, this happens lazily: the first stream
   request triggers a 404 from the control plane, the streaming service
   surfaces a `STREAM_SESSION_UNAVAILABLE` to the gateway, and the
   gateway returns 503. **That is expected** for the first run.

   To seed a session out-of-band (operator flow):

   ```bash
   # 1) Export the PyroFork session string from your local Python:
   python - <<'PY'
   from pyrogram import Client
   # Replace with your api_id/api_hash from my.telegram.org.
   api_id, api_hash = 12345, "0123456789abcdef0123456789abcdef"
   with Client("session", api_id=api_id, api_hash=api_hash) as app:
       print(app.export_session_string())
   PY

   # 2) Push it to the control plane (signed):
   SECRET=$TELEGRAM_STREAM_INTERNAL_SECRET
   TS=$(date +%s)
   SIG=$(printf '%s\n%s\n%s\n%s' \
     "$TS" "PUT" "/telegram/stream/session" "$QUERY" \
     | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

   curl -X PUT http://localhost:4000/telegram/stream/session \
     -H "X-Stream-Timestamp: $TS" \
     -H "X-Stream-Signature: $SIG" \
     -H 'Content-Type: application/json' \
     -d '{"connectedAccountId":"<acct-id>","session":"<pyrofork-session>"}'
   ```

   The control plane responds `{"connectedAccountId":"...","stored":true}`.

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
   remains stable for 5+ minutes. Watch the queue depth and parallel
   chunks in `/ready` on the streaming service.
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

Pull these into `docs/audits/telegram-stream-benchmark.md` (Phase 10
deliverable) once you have numbers.

- TTFB (first byte after seek) — measured by the streaming service's
  `ttfb_ms` in the `stream_end` JSON line.
- First chunk latency (Telegram-side).
- Average Mbps.
- Peak Mbps.
- FloodWait count.
- FILE_REFERENCE refresh count.
- Cancellation count (after seeks, after pause).
- Memory peak (RSS of the `telegram-stream` container, via
  `docker stats telegram-stream`).

## If buffering remains

**Do not blindly increase parallelism.** Use the metrics to classify
the bottleneck:

| Metric that points to… | Symptom |
|---|---|
| Slow Telegram | High `first_chunk_latency` AND low `bytes/sec` after the first chunk |
| Slow internal proxy | High `ttfb_ms` but Telegram-side metrics look fine |
| Wrong range | Many `416` responses, or `Content-Range` mismatches in logs |
| Low throughput | Mbps far below the configured `TELEGRAM_STREAM_PARALLELISM × chunk_size` |
| Reconnect per seek | `login_count` or `reconnect_count` increases per range; client manager is not being reused |
| Client abort issues | `cancelled=true` count spikes during normal playback; old range not stopped |
| Rate limits | `total_flood_waits > 0`; consider lowering parallelism |

## Deliverable

Append a "Live validation" section to
`docs/audits/telegram-stream-benchmark.md` with the captured numbers
and any bottleneck classification. If a real fix is needed, file an
issue and link it from the doc.
