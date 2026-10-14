import crypto from 'node:crypto'
import { RELAY_WARMUP_NONCE_HEADER, RELAY_WARMUP_PATH, RELAY_WARMUP_TIMESTAMP_HEADER, urlFingerprintForLog } from './relay-protocol.js'

/**
 * VPS Browser Warmup — shared backend helpers (no network I/O here).
 *
 * - `sourcePageUrl` is the originating page for Chromium navigation.
 *   It is NEVER a fetch header (unlike `referer`) and NEVER logged raw.
 * - Warmup runs once per import attempt, before the first media probe,
 *   VPS-only, with capability gating. No VPS→Direct fallback.
 */

export type WarmupMode = 'off' | 'auto' | 'required'

export const WARMUP_ERROR_CATEGORIES = [
  'NOT_SUPPORTED',
  'MISSING_PAGE_URL',
  'SECURITY_REJECTED',
  'NAVIGATION_FAILED',
  'TIMEOUT',
  'BUSY',
  'AUTH_FAILED',
  'REPLAY_REJECTED',
  'BROWSER_LAUNCH_FAILED',
  'UPSTREAM_ERROR',
] as const

export type WarmupErrorCategory = (typeof WARMUP_ERROR_CATEGORIES)[number]

const MAX_PAGE_URL_LEN = 4096

/** Normalize + validate a source page URL (http/https only, no creds, no fragment echo). */
export function sanitizeSourcePageUrl(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw !== 'string') throw new Error('Invalid page URL.')
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.length > MAX_PAGE_URL_LEN) throw new Error('Page URL is too long.')
  if (/[\r\n]/.test(trimmed)) throw new Error('Page URL is invalid.')
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    throw new Error('Page URL is invalid.')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Page URL must be http(s).')
  if (u.username || u.password) throw new Error('Page URL must not contain credentials.')
  u.hash = ''
  return u.href.slice(0, MAX_PAGE_URL_LEN)
}

/** Safe display form: host + truncated path (never query values / fragments). */
export function displayPageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    const path = u.pathname.length > 48 ? `${u.pathname.slice(0, 47)}…` : u.pathname
    return `${u.hostname}${path}`
  } catch {
    return null
  }
}

export function pageUrlFingerprint(raw: string): string {
  return urlFingerprintForLog(raw)
}

/** Idempotency key per import attempt — binds warmup-once semantics. */
export function warmupIdempotencyKey(importId: string, attempt: number, pageUrl: string): string {
  const fp = pageUrlFingerprint(pageUrl)
  return `${importId}~${attempt}:${fp}`.slice(0, 128)
}

/** Parse + validate a warmup mode value (default `auto`). */
export function parseWarmupMode(raw: unknown): WarmupMode {
  if (raw == null || raw === '') return 'auto'
  if (raw === 'off' || raw === 'auto' || raw === 'required') return raw
  throw new Error('Invalid warmup mode.')
}

// ── Payload-bound HMAC for POST /warmup ──────────────────────────────────────
// Binds method + path + sha256(canonical body) + timestamp + nonce.
// Legacy /fetch keeps bare `METHOD path` semantics untouched.

export function canonicalWarmupBody(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex')
}

export function signWarmupRequest(secret: string, body: string, timestamp: string, nonce: string): string {
  const bodyHash = canonicalWarmupBody(body)
  return crypto.createHmac('sha256', secret).update(`POST ${RELAY_WARMUP_PATH}\n${bodyHash}\n${timestamp}\n${nonce}`, 'utf8').digest('hex')
}

export function buildWarmupAuthHeaders(secret: string, body: string): { signature: string; timestamp: string; nonce: string } {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = crypto.randomBytes(16).toString('hex')
  return { signature: signWarmupRequest(secret, body, timestamp, nonce), timestamp, nonce }
}

export function warmupAuthHeadersToRecord(auth: { signature: string; timestamp: string; nonce: string }): Record<string, string> {
  return {
    'x-9drive-signature': auth.signature,
    [RELAY_WARMUP_TIMESTAMP_HEADER]: auth.timestamp,
    [RELAY_WARMUP_NONCE_HEADER]: auth.nonce,
  }
}

/** True when the persisted capabilities advertise warmup support. */
export function workerSupportsWarmup(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false
  const caps = capabilities as Record<string, unknown>
  const warmup = caps.browserWarmup
  if (!warmup || typeof warmup !== 'object') return false
  return (warmup as Record<string, unknown>).supported === true
}
