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
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppError } from '../../../utils/app-error.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from '../errors.js'

const execFileAsync = promisify(execFile)

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

/** Content-Type for the module part per Workers Scripts API contract. */
export const RELAY_MODULE_CONTENT_TYPE = 'application/javascript+module'

/** Debug artifact directory inside backend container (non-production only). */
export const RELAY_DEBUG_DIR = '/tmp/9drive-cloudflare-debug'

/** Debug artifact paths. */
export const RELAY_DEBUG_ARTIFACT_PATH = join(RELAY_DEBUG_DIR, RELAY_MODULE_NAME)
export const RELAY_DEBUG_METADATA_PATH = join(RELAY_DEBUG_DIR, 'upload-metadata.json')

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
 *
 * Additionally runs `node --check` via a temp file when available for a
 * second parser signal. Failure at this stage → WORKER_RELAY_BUILD_FAILED,
 * never a provider call.
 */
export async function validateRelaySource(source: string): Promise<void> {
  // Quick TypeScript leftover guard: the artifact must be plain JS.
  if (/\binterface\s+\w+/.test(source) || /^\s*type\s+\w+\s*=/m.test(source) || source.includes('process.env') || source.includes('require(') || source.includes('__dirname') || source.includes('__filename')) {
    const detail = 'artifact contains TypeScript or Node-only syntax'
    console.error(`[worker:cloudflare] step=preflight_relay preflight validation failed: ${detail}`)
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_BUILD_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_BUILD_FAILED, 400)
  }
  // Primary: data: import parse. Catches syntax errors, broken imports, etc.
  try {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
    if (typeof mod.default?.fetch !== 'function') {
      throw new Error('entrypoint missing: expected export default { fetch }')
    }
  } catch (error) {
    // Parse detail stays in backend logs only (the source is static and
    // contains no secrets): the user-facing error is the generic build code.
    const detail = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error)
    console.error(`[worker:cloudflare] step=preflight_relay preflight validation failed: ${detail}`)
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_BUILD_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_BUILD_FAILED, 400)
  }
  // Secondary: node --check via temp file (best-effort, never blocks on failure to spawn).
  // This mirrors what a developer would run: `node --check worker.mjs`.
  try {
    const tf = join(tmpdir(), `9drive-preflight-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`)
    const { writeFile: wf, unlink } = await import('node:fs/promises')
    await wf(tf, source, 'utf8')
    try {
      await execFileAsync(process.execPath, ['--check', tf])
    } finally {
      await unlink(tf).catch(() => {})
    }
  } catch (error) {
    const detail = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error)
    // Only treat explicit syntax failures as build failure; ENOENT / spawn
    // issues are ignored (the data: import already validated).
    if (detail.includes('SyntaxError') || detail.toLowerCase().includes('syntax')) {
      console.error(`[worker:cloudflare] step=preflight_relay node --check failed: ${detail}`)
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_BUILD_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_BUILD_FAILED, 400)
    }
    // Otherwise log but do not fail (e.g., node --check unavailable).
  }
}

/**
 * Dump the exact final artifact bytes and safe metadata to the debug directory
 * (non-production only). Uses the actual Buffer that will be sent to Cloudflare.
 * Secrets are NEVER written.
 */
export async function dumpRelayArtifacts(source: string, metadata: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') return
  try {
    const moduleBytes = Buffer.from(source, 'utf8')
    await mkdir(RELAY_DEBUG_DIR, { recursive: true })
    await writeFile(RELAY_DEBUG_ARTIFACT_PATH, moduleBytes)
    const parsedMeta = JSON.parse(metadata) as { main_module?: string; compatibility_date?: string; bindings?: Array<{ name?: string }> }
    const bindingNames = Array.isArray(parsedMeta.bindings) ? parsedMeta.bindings.map((b) => b.name).filter(Boolean) : []
    const diag = {
      moduleName: RELAY_MODULE_NAME,
      mainModule: parsedMeta.main_module ?? RELAY_MODULE_NAME,
      moduleBytes: moduleBytes.length,
      moduleSha256: relaySourceSha256(source),
      moduleContentType: RELAY_MODULE_CONTENT_TYPE,
      compatibilityDate: parsedMeta.compatibility_date ?? RELAY_COMPATIBILITY_DATE,
      bindingNames,
    }
    await writeFile(RELAY_DEBUG_METADATA_PATH, JSON.stringify(diag, null, 2), 'utf8')
    console.log(`[worker:cloudflare] debug artifacts written moduleBytes=${diag.moduleBytes} sha256=${diag.moduleSha256} path=${RELAY_DEBUG_ARTIFACT_PATH}`)
  } catch (error) {
    const detail = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error)
    console.error(`[worker:cloudflare] debug artifact dump failed: ${detail}`)
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

/**
 * Build relay artifact WITHOUT secret binding. Used for the initial
 * upload_script step so failures are unambiguously module/multipart (not secret
 * binding). Secret is configured separately via configureRelaySecret.
 */
export function buildCloudflareRelayWithoutSecret(): RelayBuild {
  const source = loadRelaySource()
  const metadata = JSON.stringify({
    main_module: RELAY_MODULE_NAME,
    compatibility_date: RELAY_COMPATIBILITY_DATE,
  })
  if (JSON.parse(metadata).main_module !== RELAY_MODULE_NAME) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_BUILD_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_BUILD_FAILED, 400)
  }
  return { source, moduleName: RELAY_MODULE_NAME, metadata }
}

/** SHA-256 hex of the module source — safe to log (no secrets in source). */
export function relaySourceSha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}
