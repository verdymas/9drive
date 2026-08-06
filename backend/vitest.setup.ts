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
