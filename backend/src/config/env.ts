import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

/**
 * Boolean env-var parser. `z.coerce.boolean()` is NOT used for these flags
 * because zod v4 coerces the STRING "false" to true (JS truthiness) — a
 * silent footgun for security toggles. Only explicit true-ish values enable.
 */
function booleanEnv(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue
      return ['true', '1', 'yes', 'on'].includes(value.toLowerCase())
    })
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
  RECAPTCHA_SECRET_KEY: z.string().optional(),
  WEBDAV_PASSWORD: z.string().optional(),
  SMB_ENABLED: z.coerce.boolean().default(false),
  SMB_CONFIG_PATH: z.string().optional(),
  SMB_ALLOWED_ROOT: z.string().optional(),
  // Remote import (URL → storage) feature.
  REMOTE_IMPORT_ENABLED: z.coerce.boolean().default(true),
  REMOTE_IMPORT_MAX_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
  REMOTE_IMPORT_GLOBAL_CONCURRENCY: z.coerce.number().default(4),
  REMOTE_IMPORT_PER_USER_CONCURRENCY: z.coerce.number().default(2),
  REMOTE_IMPORT_MAX_REDIRECTS: z.coerce.number().default(5),
  REMOTE_IMPORT_CONNECT_TIMEOUT_SECONDS: z.coerce.number().default(15),
  REMOTE_IMPORT_IDLE_TIMEOUT_SECONDS: z.coerce.number().default(60),
  REMOTE_IMPORT_JOB_TIMEOUT_HOURS: z.coerce.number().default(12),
  REMOTE_IMPORT_DOWNLOAD_ATTEMPTS: z.coerce.number().default(3),
  REMOTE_IMPORT_UPLOAD_ATTEMPTS: z.coerce.number().default(2),
  REMOTE_IMPORT_TEMP_RETENTION_HOURS: z.coerce.number().default(24),
  REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS: z.coerce.number().default(1000),
  // Max time a `queued` import may sit without evidence of a valid waiting/
  // delayed queue job before the reconcile sweep starts checking queue state.
  REMOTE_IMPORT_QUEUE_START_TIMEOUT_SECONDS: z.coerce.number().default(300),
  // Max time a `processing` import may go without a worker heartbeat before it
  // is considered stalled.
  REMOTE_IMPORT_WORKER_HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().default(120),
  REMOTE_IMPORT_TEMP_DIR: z.string().default('./data/remote-import-tmp'),
  REDIS_URL: z.string().default('redis://redis:6379'),
  // HLS/M3U8 remote import support (worker-side FFmpeg remux).
  REMOTE_IMPORT_HLS_ENABLED: z.coerce.boolean().default(true),
  REMOTE_IMPORT_HLS_MAX_MANIFEST_BYTES: z.coerce.number().default(1024 * 1024),
  REMOTE_IMPORT_HLS_MAX_PLAYLIST_DEPTH: z.coerce.number().default(4),
  REMOTE_IMPORT_HLS_MAX_VARIANTS: z.coerce.number().default(50),
  REMOTE_IMPORT_HLS_MAX_SEGMENTS: z.coerce.number().default(50000),
  // Per-segment byte cap; the total is enforced by REMOTE_IMPORT_MAX_BYTES.
  REMOTE_IMPORT_HLS_MAX_SEGMENT_BYTES: z.coerce.number().default(256 * 1024 * 1024),
  REMOTE_IMPORT_HLS_SEGMENT_CONCURRENCY: z.coerce.number().default(6),
  REMOTE_IMPORT_HLS_SEGMENT_ATTEMPTS: z.coerce.number().default(4),
  REMOTE_IMPORT_HLS_LIVE_ENABLED: z.coerce.boolean().default(true),
  REMOTE_IMPORT_HLS_MIN_RECORD_SECONDS: z.coerce.number().default(60),
  REMOTE_IMPORT_HLS_MAX_RECORD_SECONDS: z.coerce.number().default(21600),
  REMOTE_IMPORT_HLS_DEFAULT_CONTAINER: z.string().default('mkv'),
  REMOTE_IMPORT_FFMPEG_PATH: z.string().default('/usr/bin/ffmpeg'),
  REMOTE_IMPORT_FFPROBE_PATH: z.string().default('/usr/bin/ffprobe'),
  REMOTE_IMPORT_FFMPEG_TIMEOUT_SECONDS: z.coerce.number().default(3600),
  REMOTE_IMPORT_HLS_MAX_HEIGHT: z.coerce.number().default(2160),
  REMOTE_IMPORT_HLS_MAX_BANDWIDTH: z.coerce.number().default(0),
  REMOTE_IMPORT_HLS_MAX_KEY_BYTES: z.coerce.number().default(65536),
  // Request context (Referer/Origin/User-Agent/Cookie) for protected sources.
  // When disabled, context-bearing probe/create requests are REJECTED (403) —
  // never silently dropped, which would break the download.
  REMOTE_IMPORT_REQUEST_CONTEXT_ENABLED: z.coerce.boolean().default(true),
  // Paste-as-cURL input mode. Same fail-closed semantics when disabled.
  REMOTE_IMPORT_CURL_INPUT_ENABLED: z.coerce.boolean().default(true),
  REMOTE_IMPORT_REQUEST_CONTEXT_MAX_CURL_BYTES: z.coerce.number().default(65536),
  REMOTE_IMPORT_REQUEST_CONTEXT_MAX_COOKIE_BYTES: z.coerce.number().default(16384),
  REMOTE_IMPORT_REQUEST_CONTEXT_COOKIE_SCOPE: z.enum(['source-host']).default('source-host'),
  // Storage Sync (Provider → Virtual reconciliation). Account-level and
  // within-account folder-listing concurrency are bounded separately so Sync
  // All never launches unlimited provider scans simultaneously.
  SYNC_ACCOUNT_CONCURRENCY: z.coerce.number().default(2),
  SYNC_FOLDER_LIST_CONCURRENCY: z.coerce.number().default(2),
  SYNC_MAX_DEPTH: z.coerce.number().default(40),
  SYNC_DRIVE_MAX_RETRIES: z.coerce.number().default(3),
  // Remote Fetch Worker registry (network relays for Remote Imports).
  // Test-connection timeout for driver health checks (matches the connect
  // timeout default of 15s).
  WORKER_TEST_TIMEOUT_SECONDS: z.coerce.number().default(10),
  // Allows http://localhost endpoints in dev (e.g. a local relay stub). Never
  // true in production — remote relays must use HTTPS.
  WORKER_ALLOW_LOCALHOST_HTTP: z.coerce.boolean().default(false),
  // Managed Cloudflare driver provisioning.
  // Provider API base — tests point this at a local fake Cloudflare API.
  CLOUDFLARE_API_BASE: z.string().url().default('https://api.cloudflare.com/client/v4'),
  // Timeout for each Cloudflare Workers API call during provision/deprovision.
  CLOUDFLARE_DEPLOY_TIMEOUT_SECONDS: z.coerce.number().default(30),
  // Browser Capture (extension device + captured resources).
  BROWSER_CAPTURE_ENABLED: z.coerce.boolean().default(true),
  BROWSER_CAPTURE_EXTENSION_DIR: z.string().optional(),
  // Telegram Drive storage provider.
  // Per-file document size cap for Telegram uploads (Telegram free accounts
  // allow documents up to ~2 GiB; premium up to 4 GiB). Enforced in placement.
  TELEGRAM_MAX_FILE_BYTES: z.coerce.number().default(2 * 1024 * 1024 * 1024),
  // Title of the private channel used as Telegram blob storage per account.
  TELEGRAM_STORAGE_CHANNEL: z.string().default('9drive'),
  // ── Telegram Synchronization (channel ↔ 9Drive reconciliation) ─────────
  // Master switch for the periodic sweep. Manual `POST /telegram/sync` is
  // always allowed; this only gates the setInterval-driven auto sync.
  TELEGRAM_SYNC_AUTO_ENABLED: booleanEnv(true),
  // Sweep cadence (minutes). Spec recommends 15–30; default 30 keeps load
  // bounded while still catching newly-deleted / uploaded files quickly.
  TELEGRAM_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(15).max(720).default(30),
  // Page size for `client.iterMessages`. Telegram returns ≤100/page; we keep
  // this configurable for tests / smaller channels.
  TELEGRAM_SYNC_PAGE_SIZE: z.coerce.number().int().min(10).max(200).default(100),
  // Maximum pages processed in parallel. Spec §21 — bounded concurrency.
  TELEGRAM_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  // Maximum retries per page on FloodWait. FloodWait itself waits the
  // requested seconds; this caps how many times we re-enter on a row.
  TELEGRAM_SYNC_FLOOD_WAIT_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  // Cadence for the periodic FULL scan. Pass 2 (deleted-message
  // detection) is full-scan only, so this is what makes background
  // detection work. Must be >= TELEGRAM_SYNC_INTERVAL_MINUTES. The
  // scheduler clamps to the higher of the two.
  TELEGRAM_SYNC_FULL_EVERY_MINUTES: z.coerce.number().int().min(15).max(10080).default(360),
  // Soft-delete (trash) a 9Drive row when its Telegram message disappeared
  // and a FULL scan detected it (Pass 2). Default false — the spec's rule is
  // that Telegram deletion never removes a 9Drive row (telegram-drive.md:87).
  // When true, rows are moved to Trash (recoverable), never hard-deleted.
  TELEGRAM_SYNC_TRASH_MISSING: booleanEnv(false),
  // ── Telegram metadata protection (encrypted captions + opaque filenames) ──
  // Master switch for encrypting `9drive:meta` caption metadata on Telegram
  // storage documents. When enabled, TELEGRAM_METADATA_MASTER_KEY MUST be set
  // (≥32 chars) or protected writes fail safely — never auto-generate, never
  // silently fall back to plaintext for new protected uploads.
  TELEGRAM_METADATA_ENCRYPTION_ENABLED: booleanEnv(false),
  // Cryptographically secure master secret. Never commit the real value;
  // losing it makes encrypted Telegram metadata unrecoverable.
  TELEGRAM_METADATA_MASTER_KEY: z.string().optional(),
  // Non-secret HKDF salt/context label. Not a substitute for the master key.
  TELEGRAM_CRYPTO_SALT: z.string().min(1).default('9drive-telegram-v1'),
  // Obfuscate physical Telegram filenames (`tg_<opaque>.bin`).
  TELEGRAM_OBFUSCATE_FILENAME_ENABLED: booleanEnv(false),
  // Hide the original file extension on the physical Telegram filename.
  TELEGRAM_OBFUSCATE_FILE_EXTENSION: booleanEnv(true),
  // Temp dir for chunked (non-Google) resumable upload staging. Bytes are
  // streamed here before the provider upload commits; removed after commit.
  UPLOAD_TEMP_DIR: z.string().default('./data/upload-tmp'),
  // ── Telegram Stream (internal byte-range service) ───────────────────────
  // Internal DNS URL of the telegram-stream service. Empty = service disabled
  // (Telegram reads fall back to the legacy full-GET path).
  TELEGRAM_STREAM_NODE_URL: z.string().default(''),
  // HMAC shared secret with telegram-stream. Required when the URL is set.
  // Never logged. Never sent in query strings.
  TELEGRAM_STREAM_INTERNAL_SECRET: z.string().default(''),
  // HMAC clock-skew window. Must match telegram-stream's setting.
  TELEGRAM_STREAM_SIGNATURE_MAX_SKEW_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
})

export const env = envSchema.parse(process.env)
