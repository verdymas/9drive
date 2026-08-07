import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

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
})

export const env = envSchema.parse(process.env)
