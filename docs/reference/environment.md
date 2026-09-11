# Environment Reference

Sources of truth: `backend/src/config/env.ts`, `docker-compose.yml`, and frontend Vite environment configuration.

## Core Backend

- `DATABASE_URL`
- `APP_PORT`
- `FRONTEND_URL`
- `JWT_ACCESS_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `ACCESS_TOKEN_TTL_SECONDS`
- `REFRESH_TOKEN_TTL_DAYS`
- `MAX_UPLOAD_BYTES`
- `RECAPTCHA_SECRET_KEY`

## Optional S3 Direct Delivery

- `S3_DIRECT_DOWNLOAD_ENABLED` — defaults to `false`. Enables only eligible,
  ordinary authenticated S3 attachment-download redirects; proxy delivery
  remains the fallback and is always used by WebDAV, previews, archives, and
  range requests.
- `S3_DIRECT_DOWNLOAD_TTL_SECONDS` — signed URL lifetime in seconds; default
  `300`, allowed range `30`–`900`.
- `S3_DIRECT_UPLOAD_ENABLED` — defaults to `false`. Allows browser → S3 direct
  multipart uploads (payload bytes bypass the backend) via the
  `/uploads/direct-s3/*` flow when placement resolves to an S3 account; every
  provider keeps the server-relayed resumable upload as fallback. See
  `docs/application/features/uploads.md`.
- `S3_DIRECT_UPLOAD_SESSION_TTL_SECONDS` — direct upload session lifetime in
  seconds before the sweeper aborts it; default `900`, allowed range
  `300`–`3600`.
- `S3_DIRECT_UPLOAD_PART_SIZE_BYTES` — fixed browser part size; default
  `8388608` (8 MiB), allowed range `5242880` (5 MiB, the S3 multipart minimum)
  to `67108864` (64 MiB).
- `S3_DIRECT_UPLOAD_PART_URL_TTL_SECONDS` — presigned part PUT lifetime;
  default `300`, allowed range `30`–`900`.

## Optional Media Plane (Split Deployment)

- `MEDIA_SERVER_ENABLED` — defaults to `false`. Optional split deployment:
  when true, the `media-server` entry process serves file media routes
  (preview/download/batch archive), `/public/files/*` streams, and `/webdav`
  with the all-in-one server still serving everything (see
  `docs/runbooks/media-plane.md`).
- `MEDIA_SERVER_PORT` — media process listen port; default `4001`.
- `MEDIA_SERVER_SHUTDOWN_DRAIN_TIMEOUT_MS` — bounded graceful-drain window
  for in-flight streams on SIGTERM/SIGINT in BOTH processes; default `30000`,
  maximum `120000`.

## Google OAuth / WebDAV / SMB

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` are used by setup/seed/compose; runtime also supports database-backed configuration.
- `WEBDAV_PASSWORD`
- `SMB_ENABLED`
- `SMB_CONFIG_PATH`
- `SMB_ALLOWED_ROOT`

## Redis / Remote Import

- `REDIS_URL`
- `REMOTE_IMPORT_ENABLED`
- `REMOTE_IMPORT_MAX_BYTES`
- `REMOTE_IMPORT_GLOBAL_CONCURRENCY`
- `REMOTE_IMPORT_DIRECT_CONCURRENCY` — direct HTTP import worker slots. When
  unset, defaults to `REMOTE_IMPORT_GLOBAL_CONCURRENCY` for compatibility.
- `REMOTE_IMPORT_HLS_JOB_CONCURRENCY` — HLS job worker slots. When unset,
  defaults to `REMOTE_IMPORT_GLOBAL_CONCURRENCY` for compatibility.
- `REMOTE_IMPORT_PER_USER_CONCURRENCY`
- `REMOTE_IMPORT_MAX_REDIRECTS`
- `REMOTE_IMPORT_CONNECT_TIMEOUT_SECONDS`
- `REMOTE_IMPORT_IDLE_TIMEOUT_SECONDS`
- `REMOTE_IMPORT_JOB_TIMEOUT_HOURS`
- `REMOTE_IMPORT_DOWNLOAD_ATTEMPTS`
- `REMOTE_IMPORT_UPLOAD_ATTEMPTS`
- `REMOTE_IMPORT_TEMP_RETENTION_HOURS`
- `REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS`
- `REMOTE_IMPORT_TEMP_FREE_SPACE_RESERVE_BYTES` — bytes that Remote Import
  must leave free on the `REMOTE_IMPORT_TEMP_DIR` volume; default `2147483648`
  (2 GiB).
- `REMOTE_IMPORT_TEMP_UNKNOWN_RESERVATION_BYTES` — conservative temporary-disk
  reservation for a direct source whose size cannot be determined; default
  `5368709120` (5 GiB).
- `REMOTE_IMPORT_TEMP_HLS_RESERVATION_BYTES` — conservative temporary-disk
  reservation for an HLS job, covering materialized segments and conversion
  output; default `10737418240` (10 GiB).
- `REMOTE_IMPORT_STREAM_THROUGH_CHUNK_BYTES` — bounded source-read and
  provider-upload chunk size for eligible direct stream-through imports;
  default `8388608` (8 MiB), allowed range 5–64 MiB.
- `REMOTE_IMPORT_QUEUE_START_TIMEOUT_SECONDS`
- `REMOTE_IMPORT_WORKER_HEARTBEAT_TIMEOUT_SECONDS`
- `REMOTE_IMPORT_TEMP_DIR`

## HLS / FFmpeg

- `REMOTE_IMPORT_HLS_ENABLED`
- `REMOTE_IMPORT_HLS_MAX_MANIFEST_BYTES`
- `REMOTE_IMPORT_HLS_MAX_PLAYLIST_DEPTH`
- `REMOTE_IMPORT_HLS_MAX_VARIANTS`
- `REMOTE_IMPORT_HLS_MAX_SEGMENTS`
- `REMOTE_IMPORT_HLS_MAX_SEGMENT_BYTES`
- `REMOTE_IMPORT_HLS_SEGMENT_CONCURRENCY`
- `REMOTE_IMPORT_HLS_GLOBAL_SEGMENT_CONCURRENCY` — process-wide cap across
  every HLS job's segment fetches; default `12`. This works in addition to
  the per-job segment concurrency limit.
- `REMOTE_IMPORT_HLS_SEGMENT_ATTEMPTS`
- `REMOTE_IMPORT_HLS_LIVE_ENABLED`
- `REMOTE_IMPORT_HLS_MIN_RECORD_SECONDS`
- `REMOTE_IMPORT_HLS_MAX_RECORD_SECONDS`
- `REMOTE_IMPORT_HLS_DEFAULT_CONTAINER`
- `REMOTE_IMPORT_FFMPEG_PATH`
- `REMOTE_IMPORT_FFPROBE_PATH`
- `REMOTE_IMPORT_FFMPEG_TIMEOUT_SECONDS`
- `REMOTE_IMPORT_HLS_FFMPEG_CONCURRENCY` — process-wide number of active
  FFmpeg processes for HLS remux, retry, concat-copy, and re-encode; default
  `2`.
- `REMOTE_IMPORT_HLS_MAX_HEIGHT`
- `REMOTE_IMPORT_HLS_MAX_BANDWIDTH`
- `REMOTE_IMPORT_HLS_MAX_KEY_BYTES`

## Protected Source Request Context

- `REMOTE_IMPORT_REQUEST_CONTEXT_ENABLED`
- `REMOTE_IMPORT_CURL_INPUT_ENABLED`
- `REMOTE_IMPORT_REQUEST_CONTEXT_MAX_CURL_BYTES`
- `REMOTE_IMPORT_REQUEST_CONTEXT_MAX_COOKIE_BYTES`
- `REMOTE_IMPORT_REQUEST_CONTEXT_COOKIE_SCOPE` (`source-host`)

## Provider Sync

- `SYNC_ACCOUNT_CONCURRENCY`
- `SYNC_FOLDER_LIST_CONCURRENCY`
- `SYNC_MAX_DEPTH`
- `SYNC_DRIVE_MAX_RETRIES`

## Remote Fetch Workers

- `WORKER_TEST_TIMEOUT_SECONDS`
- `WORKER_ALLOW_LOCALHOST_HTTP` — development only; production remote relays must use HTTPS.
- `CLOUDFLARE_API_BASE`
- `CLOUDFLARE_DEPLOY_TIMEOUT_SECONDS`

## Browser Capture

- `BROWSER_CAPTURE_ENABLED`
- `BROWSER_CAPTURE_EXTENSION_DIR`

## Telegram

- `TELEGRAM_MAX_FILE_BYTES`
- `TELEGRAM_STORAGE_CHANNEL`
- `TELEGRAM_SYNC_AUTO_ENABLED`
- `TELEGRAM_SYNC_INTERVAL_MINUTES`
- `TELEGRAM_SYNC_PAGE_SIZE`
- `TELEGRAM_SYNC_CONCURRENCY` — BullMQ worker job concurrency (default `2`, allowed range `1`–`8`). Sets the number of independent Telegram connected accounts processed concurrently per worker process while per-account single-flight safety remains guarded by `TelegramSyncState`.
- `TELEGRAM_SYNC_CAPTION_CONCURRENCY` — Concurrency cap for caption-resolving operations within each Telegram sync page scan (default `4`, allowed range `1`–`16`).
- Additional Telegram Sync retry/rate environment parameters: check `env.ts` before changing scheduler behavior.

## Frontend Build

- `VITE_API_URL`
- `VITE_RECAPTCHA_SITE_KEY`

## Secret Rule
Never commit production secret/token/password values. Documentation may reference variable names and behavior only.
