import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText } from '../../utils/crypto.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES } from '../remote-fetch-workers/errors.js'
import {
  RELAY_WARMUP_PATH,
  RelayWarmupRequestSchema,
  RelayWarmupResponseSchema,
  opTraceId,
  urlFingerprintForLog,
} from '../remote-fetch-workers/relay-protocol.js'
import {
  buildWarmupAuthHeaders,
  displayPageUrl,
  pageUrlFingerprint,
  parseWarmupMode,
  sanitizeSourcePageUrl,
  warmupIdempotencyKey,
  workerSupportsWarmup,
  type WarmupMode,
} from '../remote-fetch-workers/browser-warmup.js'

export type WarmupDecision = {
  warmed: boolean
  skipped: boolean
  skipReason?: string
  traceId?: string
}

/** In-memory single-flight: one warmup per idempotency key at a time. */
const inflightWarmups = new Map<string, Promise<WarmupDecision>>()

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return ''
  }
}

/**
 * Ensure VPS Browser Warmup runs ONCE per import attempt, BEFORE the first
 * media probe. VPS-only, capability-gated, no fallback.
 *
 * - mode `off` → skip silently.
 * - mode `auto` (default) → warmup iff VPS + page URL present + relay
 *   advertises support + master switch on; otherwise skip (legacy behavior).
 * - mode `required` → same, but missing URL / unsupported relay / warmup
 *   failure throws a typed error; never silently fetches without warmup and
 *   never switches to Direct/another worker.
 */
export async function maybeWarmupBeforeProbe(input: {
  importId?: string | null
  attempt?: number | null
  workerId: string | null | undefined
  sourcePageUrl: string | null | undefined
  warmupMode?: unknown
  traceBase?: string | null
}): Promise<WarmupDecision> {
  const mode: WarmupMode = parseWarmupMode(input.warmupMode ?? 'auto')
  if (mode === 'off') return { warmed: false, skipped: true, skipReason: 'disabled' }
  if (!input.workerId) {
    if (mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_REQUIRED_MISSING, 'Browser warmup requires a Virtual Private Server worker.', 400)
    return { warmed: false, skipped: true, skipReason: 'direct-route' }
  }
  const rawPage = (input.sourcePageUrl ?? '').trim()
  if (!rawPage) {
    if (mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_REQUIRED_MISSING, 'Browser warmup is required but no page URL was provided.', 400)
    return { warmed: false, skipped: true, skipReason: 'missing-page-url' }
  }
  let pageUrl: string
  try {
    const sanitized = sanitizeSourcePageUrl(rawPage)
    if (!sanitized) {
      if (mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_REQUIRED_MISSING, 'Browser warmup is required but no page URL was provided.', 400)
      return { warmed: false, skipped: true, skipReason: 'missing-page-url' }
    }
    pageUrl = sanitized
  } catch {
    if (mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_SECURITY_REJECTED, 'The warmup page URL was rejected.', 400)
    return { warmed: false, skipped: true, skipReason: 'invalid-page-url' }
  }

  const worker = await prisma.remoteFetchWorker.findFirst({ where: { id: input.workerId, deletedAt: null } })
  if (!worker) {
    if (mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_UNAVAILABLE, 'The selected network worker is no longer available.', 409)
    return { warmed: false, skipped: true, skipReason: 'worker-missing' }
  }
  if (worker.driver !== 'vps') {
    if (mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_NOT_SUPPORTED, 'Browser warmup is only supported for Virtual Private Server.', 400)
    return { warmed: false, skipped: true, skipReason: 'non-vps-driver' }
  }
  if (!env.VPS_BROWSER_WARMUP_ENABLED) {
    if (mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_NOT_SUPPORTED, 'Browser warmup is disabled on this server.', 400)
    return { warmed: false, skipped: true, skipReason: 'master-disabled' }
  }
  let capabilities: unknown = null
  const rawCaps = (worker as { capabilitiesJson?: unknown }).capabilitiesJson ?? null
  if (rawCaps && typeof rawCaps === 'object') {
    capabilities = rawCaps
  } else if (typeof rawCaps === 'string' && rawCaps) {
    try {
      capabilities = JSON.parse(rawCaps)
    } catch {
      capabilities = null
    }
  }
  if (!workerSupportsWarmup(capabilities)) {
    if (mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_NOT_SUPPORTED, 'The selected worker does not support browser warmup. Update the relay or disable warmup.', 400)
    return { warmed: false, skipped: true, skipReason: 'relay-no-capability' }
  }

  const attempt = input.attempt ?? 1
  const importId = input.importId ?? 'probe'
  const key = warmupIdempotencyKey(importId, attempt, pageUrl)
  const existing = inflightWarmups.get(key)
  if (existing) return existing

  const task = runWarmupOnce({ importId: input.importId ?? null, attempt, worker, pageUrl, mode, traceBase: input.traceBase ?? importId })
  inflightWarmups.set(key, task)
  try {
    return await task
  } finally {
    inflightWarmups.delete(key)
  }
}

async function runWarmupOnce(input: {
  importId: string | null
  attempt: number
  worker: { id: string; endpointUrl: string | null; secretEncrypted: string | null }
  pageUrl: string
  mode: WarmupMode
  traceBase: string | null | undefined
}): Promise<WarmupDecision> {
  const traceId = opTraceId(input.traceBase ?? input.importId, 'warmup')
  const pageFp = pageUrlFingerprint(input.pageUrl)
  const pageHost = safeHost(input.pageUrl)
  const pageLabel = displayPageUrl(input.pageUrl) ?? pageHost
  console.log(`[remote-import:warmup] event=warmup.requested traceId=${traceId} workerId=${input.worker.id} pageHost=${pageHost} pageFp=${pageFp} pageLabel=${pageLabel} attempt=${input.attempt}`)

  if (!input.worker.endpointUrl || !input.worker.secretEncrypted) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, 'The worker is missing its endpoint or secret.', 400)
  }
  let secret: string
  try {
    secret = decryptText(input.worker.secretEncrypted)
  } catch {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, 'The worker secret could not be read.', 400)
  }
  const endpoint = input.worker.endpointUrl.replace(/\/$/, '')
  const url = `${endpoint}${RELAY_WARMUP_PATH}`
  const bodyObj = RelayWarmupRequestSchema.parse({
    protocolVersion: '9drive-relay-v1',
    pageUrl: input.pageUrl,
    traceId,
    idempotencyKey: input.importId ? warmupIdempotencyKey(input.importId, input.attempt, input.pageUrl) : undefined,
    timeoutMs: Math.min(Math.max(env.VPS_BROWSER_WARMUP_TIMEOUT_MS, 5000), 60000),
  })
  const body = JSON.stringify(bodyObj)
  const auth = buildWarmupAuthHeaders(secret, body)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-9drive-signature': auth.signature,
    'x-9drive-timestamp': auth.timestamp,
    'x-9drive-nonce': auth.nonce,
  }

  if (input.importId) {
    await prisma.remoteImport.updateMany({
      where: { id: input.importId },
      data: { warmupStatus: 'requested', warmupRequestedAt: new Date(), warmupTraceId: traceId },
    }).catch(() => undefined)
  }
  console.log(`[remote-import:warmup] event=browser.launch-requested traceId=${traceId} pageFp=${pageFp}`)

  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(env.VPS_BROWSER_WARMUP_TIMEOUT_MS + 10000) })
  } catch (error) {
    const msg = String((error as Error)?.message ?? '').toLowerCase()
    await markWarmup(input.importId, 'failed', traceId)
    if (input.mode === 'required') {
      if (msg.includes('timeout') || msg.includes('abort')) throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_TIMEOUT, 'Browser warmup timed out.', 504)
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_FAILED, 'Browser warmup failed before the probe.', 502)
    }
    console.log(`[remote-import:warmup] event=browser.closed traceId=${traceId} pageFp=${pageFp} outcome=fetch-failed-skipped`)
    return { warmed: false, skipped: true, skipReason: 'warmup-fetch-failed', traceId }
  }

  if (res.status === 401 || res.status === 403) {
    await markWarmup(input.importId, 'failed', traceId)
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, 'The worker rejected the warmup authentication.', 401)
  }
  if (res.status === 429) {
    await markWarmup(input.importId, 'failed', traceId)
    if (input.mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_BUSY, 'The relay is already running a browser warmup.', 429)
    console.log(`[remote-import:warmup] event=browser.closed traceId=${traceId} pageFp=${pageFp} outcome=busy-skipped`)
    return { warmed: false, skipped: true, skipReason: 'relay-busy', traceId }
  }
  if (res.status === 400) {
    await markWarmup(input.importId, 'failed', traceId)
    if (input.mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_SECURITY_REJECTED, 'The warmup page URL was rejected.', 400)
    return { warmed: false, skipped: true, skipReason: 'security-rejected', traceId }
  }
  if (res.status === 501) {
    await markWarmup(input.importId, 'failed', traceId)
    if (input.mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_NOT_SUPPORTED, 'The relay does not support browser warmup.', 400)
    return { warmed: false, skipped: true, skipReason: 'relay-no-capability', traceId }
  }
  if (!res.ok) {
    await markWarmup(input.importId, 'failed', traceId)
    if (input.mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_FAILED, 'Browser warmup failed before the probe.', 502)
    return { warmed: false, skipped: true, skipReason: `relay-${res.status}`, traceId }
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    await markWarmup(input.importId, 'failed', traceId)
    if (input.mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_FAILED, 'Browser warmup returned an invalid response.', 502)
    return { warmed: false, skipped: true, skipReason: 'invalid-response', traceId }
  }
  const parsed = RelayWarmupResponseSchema.safeParse(json)
  if (!parsed.success) {
    await markWarmup(input.importId, 'failed', traceId)
    if (input.mode === 'required') throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_FAILED, 'Browser warmup returned an invalid response.', 502)
    return { warmed: false, skipped: true, skipReason: 'invalid-response', traceId }
  }
  const data = parsed.data
  console.log(
    `[remote-import:warmup] event=browser.closed traceId=${traceId} pageFp=${pageFp} navigationStatus=${data.navigationStatus ?? 'none'} mediaObserved=${data.mediaObserved ?? 0} browserMedia206=${data.browserMedia206 === true} status=${data.status}`,
  )
  if (data.status !== 'warmed') {
    await markWarmup(input.importId, 'failed', traceId)
    if (input.mode === 'required') {
      const code = data.errorCategory === 'TIMEOUT' ? REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_TIMEOUT : REMOTE_FETCH_WORKER_ERROR_CODES.WARMUP_FAILED
      throw new AppError(code, 'Browser warmup failed before the probe.', data.errorCategory === 'TIMEOUT' ? 504 : 502)
    }
    return { warmed: false, skipped: true, skipReason: data.errorCategory?.toLowerCase() ?? 'warmup-failed', traceId }
  }
  // Warmup navigated + closed. The subsequent probe/download still uses the
  // normal relay /fetch path — warmup never returns media bytes itself.
  console.log(`[remote-import:warmup] event=warmup.completed traceId=${traceId} pageFp=${pageFp} probe=pending`)
  await markWarmup(input.importId, 'warmed', traceId)
  return { warmed: true, skipped: false, traceId }
}

async function markWarmup(importId: string | null, status: string, _traceId: string): Promise<void> {
  if (!importId || importId === 'probe') return
  await prisma.remoteImport.updateMany({ where: { id: importId }, data: { warmupStatus: status } }).catch(() => undefined)
}

/** Test-only: clear the in-memory single-flight map. */
export function __clearWarmupInflightForTests(): void {
  inflightWarmups.clear()
}

/** Stable nonce helper for tests (avoids crypto randomness assertions). */
export function __warmupBodyHashForTests(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex')
}
