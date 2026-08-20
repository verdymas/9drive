import dotenv from 'dotenv'
import path from 'node:path'

// The routes import `env.ts`, which parses the environment at import time.
// Load the root .env (or backend .env) so the env schema is satisfiable in
// tests; the SMB tests never touch real Samba binaries.
dotenv.config({ path: path.resolve(process.cwd(), '../.env') })
dotenv.config()

// Guarantee the env schema can parse even when no .env is present.
process.env.DATABASE_URL ??= 'mysql://root@localhost:3306/9drive_test'
process.env.FRONTEND_URL ??= 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET ??= 'test-jwt-secret-that-is-long-enough-1234'
process.env.TOKEN_ENCRYPTION_KEY ??= 'test-encryption-key-32bytes!!!'

// Fast idle timeout so downloader tests that exercise the abort path don't
// wait the full production default (60s).
process.env.REMOTE_IMPORT_IDLE_TIMEOUT_SECONDS ??= '1'

// Remote Fetch Worker integration tests stand up a local http relay (127.0.0.1),
// so allow http://localhost in the test environment only.
process.env.WORKER_ALLOW_LOCALHOST_HTTP ??= 'true'

// On Windows dev hosts the FFmpeg defaults are Linux paths (/usr/bin/ffmpeg).
// Point the env at the winget-installed binaries so the real-FFmpeg HLS
// integration tests execute instead of silently skipping (the worker container
// still uses the Docker defaults).
if (process.platform === 'win32') {
  const wingetLinks = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links')
  process.env.REMOTE_IMPORT_FFMPEG_PATH ??= path.join(wingetLinks, 'ffmpeg.exe')
  process.env.REMOTE_IMPORT_FFPROBE_PATH ??= path.join(wingetLinks, 'ffprobe.exe')
}
