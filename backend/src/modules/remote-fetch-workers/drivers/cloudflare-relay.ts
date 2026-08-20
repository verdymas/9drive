/**
 * Canonical Cloudflare relay artifact: static ES module source loaded from
 * `cloudflare-relay/worker.mjs`, preflight-validated locally before any
 * Cloudflare API call, and framed into the multipart Workers Scripts upload
 * payload by the Cloudflare driver.
 *
 * The source is a DETERMINISTIC static asset — no interpolated secrets, names
 * or endpoints. The relay secret travels only as a `secret_text` binding.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AppError } from '../../../utils/app-error.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from '../errors.js'

/** Canonical entry module name — multipart part name and filename MUST equal `metadata.main_module`. */
export const RELAY_MODULE_NAME = 'worker.mjs'

/** Name of the secret_text binding that carries the relay secret. */
export const RELAY_SECRET_BINDING = 'RELAY_SECRET'

/**
 * App-controlled compatibility date for the relay (tied to protocol
 * 9drive-relay-v1). Fixed constant — never derived from the current date, so
 * deploy behavior cannot silently change from day to day. Keep this a valid
 * past date; bump it deliberately with a relay feature change.
 */
export const RELAY_COMPATIBILITY_DATE = '2026-06-01'

// CommonJS build (no "type":"module"): __dirname is the module's own
// directory. tsx (dev) resolves it to src/.../cloudflare-relay/worker.mjs;
// the production build copies the asset beside dist via copy-relay-asset.mjs.
const RELAY_ASSET_PATH = join(__dirname, 'cloudflare-relay', RELAY_MODULE_NAME)

export interface RelayBuild {
  /** Canonical relay module source (static, no secrets). */
  source: string
  /** Entry module name, always RELAY_MODULE_NAME. */
  moduleName: string
  /** Multipart metadata part JSON: main_module / compatibility_date / bindings. */
  metadata: string
}

/**
 * Load the canonical relay source from disk. The `.mjs` asset is not compiled
 * by tsc — tsx (dev) reads it from src, and the production build copies it
 * next to dist via `scripts/copy-relay-asset.mjs`.
 */
export function loadRelaySource(): string {
  const source = readFileSync(RELAY_ASSET_PATH, 'utf8')
  if (source.length === 0) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_BUILD_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_BUILD_FAILED, 400)
  }
  return source
}

/**
 * Preflight: parse the relay source as a real ES module and verify the
 * expected entrypoint exists. Uses an in-memory `data:` import (Node's ESM
 * loader parses the syntax for us), so a syntax error, leftover TypeScript,
 * a broken template literal or a missing/default-less entrypoint fails BEFORE
 * any Cloudflare API request is made. The source is static and side-effect
 * free, so executing it is safe.
 */
export async function validateRelaySource(source: string): Promise<void> {
  try {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
    if (typeof mod.default?.fetch !== 'function') {
      throw new Error('entrypoint missing: expected export default { fetch }')
    }
  } catch (error) {
    // Parse detail stays in backend logs only (the source is static and
    // contains no secrets): the user-facing error is the generic build code.
    const detail = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error)
    console.error(`[worker:cloudflare] step=build relay preflight validation failed: ${detail}`)
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_BUILD_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_BUILD_FAILED, 400)
  }
}

/**
 * Build the canonical relay artifact: load the static source, assert the
 * entry module contract (metadata.main_module === uploaded module name),
 * and return the multipart `metadata` JSON with the secret_text binding.
 */
export function buildCloudflareRelay(relaySecret: string): RelayBuild {
  const source = loadRelaySource()
  const metadata = JSON.stringify({
    main_module: RELAY_MODULE_NAME,
    compatibility_date: RELAY_COMPATIBILITY_DATE,
    bindings: [{ type: 'secret_text', name: RELAY_SECRET_BINDING, text: relaySecret }],
  })
  // The uploaded multipart part is named RELAY_MODULE_NAME; main_module must
  // reference exactly that part or Cloudflare's parser cannot resolve the
  // entry module (error 10021).
  if (JSON.parse(metadata).main_module !== RELAY_MODULE_NAME) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_BUILD_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_BUILD_FAILED, 400)
  }
  return { source, moduleName: RELAY_MODULE_NAME, metadata }
}

/** SHA-256 hex of the module source — safe to log (no secrets in source). */
export function relaySourceSha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}