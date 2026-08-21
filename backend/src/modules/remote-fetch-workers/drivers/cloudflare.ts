import crypto from 'node:crypto'
import { z } from 'zod'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import type {
  RemoteFetchWorkerDriver,
  RemoteFetchWorkerAuthType,
  WorkerDeprovisionInput,
  WorkerDeprovisionResult,
  WorkerHealthProbe,
  WorkerProvisionInput,
  WorkerProvisionResult,
  WorkerUpdateInput,
  WorkerUpdateResult,
  WorkerDriverMetadata,
} from '../types.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from '../errors.js'
import {
  RELAY_MODULE_NAME,
  RELAY_SECRET_BINDING,
  RELAY_COMPATIBILITY_DATE,
  RELAY_MODULE_CONTENT_TYPE,
  buildCloudflareRelay,
  buildCloudflareRelayWithoutSecret,
  validateRelaySource,
  relaySourceSha256,
  dumpRelayArtifacts as dumpRelayArtifactsToDisk,
} from './cloudflare-relay.js'
import { CloudflareRemoteFetchTransport } from '../transports/cloudflare-transport.js'
import { RELAY_PROTOCOL_VERSION as CANONICAL_RELAY_PROTOCOL_VERSION } from '../relay-protocol.js'

/**
 * Cloudflare Worker relay driver.
 *
 * MANAGED driver: 9Drive provisions and manages the relay through the
 * Cloudflare Workers API (deploy script, configure the generated secret
 * binding, discover the workers.dev endpoint, health-check). The user only
 * supplies Account ID, API Token and Worker Name. The driver never parses HLS,
 * never remuxes, never touches temp files or uploads — it is a network relay
 * and deployment manager only.
 */

/** Relay protocol identity the health endpoint must report. */
export const RELAY_SERVICE_IDENTITY = '9drive-relay'
// Canonical protocol version — single source of truth is relay-protocol.ts
export const RELAY_PROTOCOL_VERSION = CANONICAL_RELAY_PROTOCOL_VERSION

/** Cloudflare binding name that carries the relay secret to the deployed script. */
export { RELAY_SECRET_BINDING }

const SUPPORTED_PROTOCOLS = new Set<string>([RELAY_PROTOCOL_VERSION])

/** Blocked URI schemes — never allowed as a relay target. */
const BLOCKED_SCHEMES = new Set(['javascript:', 'file:', 'ftp:', 'data:'])

/** Worker name rules: 1-63 chars, letters/digits/_/-. */
const WORKER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,63}$/

const registrationSchema = z.object({
  accountId: z.string().min(1).max(64),
  apiToken: z.string().min(1).max(256),
  workerName: z.string().regex(WORKER_NAME_PATTERN, 'Worker Name must be 1-63 characters: letters, digits, _ or -.'),
})

/** Workers.dev account subdomain rules: 1-63 chars, lower alphanum and hyphen, cannot start/end with hyphen. */
export const WORKERS_SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const ACCOUNT_SUBDOMAIN_MAX = 63

/** Deterministic candidate for accounts lacking a workers.dev subdomain. Avoids exposing raw accountId. */
export function generateCandidateSubdomain(accountId: string): string {
  const hash = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 8).toLowerCase()
  const candidate = `9drive-${hash}`
  // Ensure candidate respects pattern and length (always does: 9drive- + 8 hex)
  if (!WORKERS_SUBDOMAIN_PATTERN.test(candidate) || candidate.length > ACCOUNT_SUBDOMAIN_MAX) {
    // Fallback: short random suffix if hash edge-case fails (should never happen)
    return `9drive-${crypto.randomUUID().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`
  }
  return candidate
}

export function isValidWorkersSubdomain(subdomain: string): boolean {
  return WORKERS_SUBDOMAIN_PATTERN.test(subdomain) && subdomain.length >= 1 && subdomain.length <= ACCOUNT_SUBDOMAIN_MAX
}

// Zod schemas for robust Cloudflare response parsing
const scriptSubdomainStateSchema = z.object({
  success: z.boolean().optional(),
  result: z
    .object({
      enabled: z.boolean(),
      previews_enabled: z.boolean().optional(),
    })
    .optional()
    .nullable(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string().optional() })).optional(),
})

const accountSubdomainResponseSchema = z.object({
  success: z.boolean().optional(),
  result: z
    .object({
      subdomain: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string().optional() })).optional(),
})

// ────────────────────────────────────────────────────────────────────────────
// Correlation + staged logging
// ────────────────────────────────────────────────────────────────────────────

/** Generate a short correlationId for one provisioning attempt. */
export function generateCorrelationId(): string {
  return crypto.randomUUID().slice(0, 8)
}

function logStage(correlationId: string, step: string, status: 'started' | 'success' | 'failure', extra?: string) {
  const suffix = extra ? ` ${extra}` : ''
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=${step} ${status}${suffix}`)
}

function logStepStarted(correlationId: string, step: string, extra?: string) {
  logStage(correlationId, step, 'started', extra)
}
function logStepSuccess(correlationId: string, step: string, extra?: string) {
  logStage(correlationId, step, 'success', extra)
}
function logStepFailure(correlationId: string, step: string, extra?: string) {
  console.error(`[worker:cloudflare] correlationId=${correlationId} step=${step} failure${extra ? ` ${extra}` : ''}`)
}

// ────────────────────────────────────────────────────────────────────────────
// Typed provisioning error preserving provider diagnostics
// ────────────────────────────────────────────────────────────────────────────

/**
 * Typed error preserving full provider diagnostics. Public API still returns
 * WORKER_PROVISION_FAILED with a generic message + correlationId, but backend
 * logs MUST preserve driver/step/HTTP status/provider code/message.
 */
export class WorkerProvisionError extends AppError {
  driver: string
  step: string
  providerStatus: number | null
  providerCode: number | null
  providerMessage: string | null
  correlationId: string
  cause?: unknown

  constructor(opts: {
    driver?: string
    step: string
    providerStatus?: number | null
    providerCode?: number | null
    providerMessage?: string | null
    correlationId: string
    code?: string
    message?: string
    cause?: unknown
  }) {
    const code = opts.code ?? REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED
    const message = opts.message ?? REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED
    super(code, message, 400)
    this.driver = opts.driver ?? 'cloudflare'
    this.step = opts.step
    this.providerStatus = opts.providerStatus ?? null
    this.providerCode = opts.providerCode ?? null
    this.providerMessage = opts.providerMessage ?? null
    this.correlationId = opts.correlationId
    this.cause = opts.cause
  }
}

/**
 * Build the HMAC-SHA256 signature header value for a health probe.
 *
 * Canonical target: `METHOD SPACE path` (path including query string). The
 * secret is the worker's generated relay secret; signing happens ONLY in the
 * 9Drive backend — the secret never reaches the frontend.
 */
export function signHealthRequest(secret: string, method: string, pathWithQuery: string) {
  const canonical = `${method} ${pathWithQuery}`
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
}

/** HTTP header carrying the HMAC signature. */
export const HMAC_SIGNATURE_HEADER = 'x-9drive-signature'

/**
 * Normalize a worker endpoint URL:
 * - must be http/https (other schemes rejected)
 * - CRLF-safe: reject CR/LF
 * - reject embedded credentials (user:pass@)
 * - HTTPS required except http://localhost when WORKER_ALLOW_LOCALHOST_HTTP
 * - strip a single trailing slash for a canonical form
 */
export function normalizeEndpointUrl(raw: string): string {
  if (!raw) throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  if (/[\r\n]/.test(raw)) throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  if (raw.includes('@') && raw.includes('://')) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  }
  const scheme = url.protocol.toLowerCase()
  if (BLOCKED_SCHEMES.has(scheme)) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  }
  if (url.username || url.password) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  }
  if (scheme === 'http:') {
    const isLocalhost = /^(localhost|127\.0\.0\.1|::1)$/i.test(url.hostname)
    if (!(isLocalhost && env.WORKER_ALLOW_LOCALHOST_HTTP)) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
    }
  }
  // Canonical form: drop trailing slashes so `https://x.y`, `https://x.y/`
  // and `https://x.y///` are the same endpoint, and appending `/health` later
  // never produces a doubled slash.
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

/** Map an undici/global-fetch failure to a stable WORKER_* code. */
export function mapFetchFailure(error: unknown): AppError {
  const cause = (error as Error)?.cause ?? error
  const name = cause instanceof Error ? cause.name : ''
  const message = cause instanceof Error ? cause.message : String(cause)
  const lower = message.toLowerCase()
  if (name === 'TimeoutError' || lower.includes('timeout') || lower.includes('aborted')) {
    return new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CONNECTION_TIMEOUT, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CONNECTION_TIMEOUT, 400)
  }
  if (lower.includes('self-signed') || lower.includes('certificate') || lower.includes('tls')) {
    return new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_TLS_ERROR, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_TLS_ERROR, 400)
  }
  if (lower.includes('refused') || lower.includes('econnrefused') || lower.includes('socket') || lower.includes('network')) {
    return new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CONNECTION_REFUSED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CONNECTION_REFUSED, 400)
  }
  return new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CONNECTION_REFUSED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CONNECTION_REFUSED, 400)
}

/** Validate the relay's health response identity + protocol. */
export function validateHealthPayload(body: unknown): WorkerHealthProbe {
  if (!body || typeof body !== 'object') {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
  }
  const record = body as Record<string, unknown>
  if (record.service !== RELAY_SERVICE_IDENTITY) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
  }
  const protocolVersion = typeof record.protocolVersion === 'string' ? record.protocolVersion : undefined
  if (protocolVersion && !SUPPORTED_PROTOCOLS.has(protocolVersion)) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_UNSUPPORTED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_UNSUPPORTED, 400)
  }
  if (record.status === 'ok' || record.status === 'healthy') {
    return { status: 'healthy', protocolVersion, capabilities: sanitizeCapabilities(record) }
  }
  throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_UNHEALTHY, 400)
}

/** Extract only safe capability fields from the health payload. */
function sanitizeCapabilities(record: Record<string, unknown>): WorkerHealthProbe['capabilities'] {
  const raw = record.capabilities
  if (!raw || typeof raw !== 'object') return undefined
  const caps = raw as Record<string, unknown>
  return {
    streaming: caps.streaming === true,
    rangeRequests: caps.rangeRequests === true,
    requestContext: caps.requestContext === true,
    hls: caps.hls === true,
    maxBodyBytes: typeof caps.maxBodyBytes === 'number' ? caps.maxBodyBytes : null,
    protocolVersion: typeof caps.protocolVersion === 'string' ? caps.protocolVersion : undefined,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cloudflare Workers API client (managed provisioning)
// ────────────────────────────────────────────────────────────────────────────

function apiBase() {
  return env.CLOUDFLARE_API_BASE.replace(/\/$/, '')
}

function apiTimeout() {
  return env.CLOUDFLARE_DEPLOY_TIMEOUT_SECONDS * 1000
}

/**
 * Reported HTTP status from a Cloudflare API call. The numeric CF error code
 * (when present in the body) is safe to surface — it is just an integer that
 * Cloudflare documents publicly, never sensitive request data.
 */
export function parseCfErrorCode(bodyText: string): number | null {
  try {
    const parsed = JSON.parse(bodyText) as { errors?: Array<{ code?: number }> }
    return parsed.errors?.[0]?.code ?? null
  } catch {
    return null
  }
}

export function parseCfErrorMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { errors?: Array<{ message?: string }> }
    const msg = parsed.errors?.[0]?.message
    return typeof msg === 'string' && msg.length > 0 ? msg : null
  } catch {
    return null
  }
}

/**
 * Known CF error codes for Worker script deploy/upload failures → safe short
 * reason. NEVER free-form provider text: the provider can echo arbitrary
 * request data (tokens, URLs) in messages. The numeric code alone is what we
 * trust, mapped to our own static description.
 */
const CF_KNOWN_ERRORS: Record<number, string> = {
  10021: 'script content could not be parsed (syntax or format error)',
  10022: 'script validation failed',
  10051: 'script name is not valid',
  10053: 'script already exists',
  10058: 'script not found',
  10061: 'script is not a valid module',
  11005: 'worker already exists',
}

function safeCfReason(bodyText: string): string | null {
  const code = parseCfErrorCode(bodyText)
  if (code === null) return null
  return CF_KNOWN_ERRORS[code] ?? null
}

/**
 * True when Cloudflare says the script is already gone — either an HTTP 404 or
 * an error envelope whose code/message identifies "script not found" even on a
 * different HTTP status. Deletion treats this as success (idempotent).
 * Cloudflare has reported this as 10058 (stable) and 10090 (older API family);
 * the message-phrase check is a fallback for unnumbered envelopes.
 */
export function isScriptNotFoundEnvelope(status: number, bodyText: string): boolean {
  if (status === 404) return true
  const code = parseCfErrorCode(bodyText)
  if (code === 10058 || code === 10090) return true
  const msg = parseCfErrorMessage(bodyText)
  return Boolean(msg && /script[_ ]?not[_ ]?found/i.test(msg))
}

/**
 * True when a normal DELETE is refused because the script has active
 * dependencies (routes / workers.dev subdomain / instances). Cloudflare's
 * documented remedy is DELETE with `?force=true` — applied ONLY for this class
 * of error, never unconditionally.
 */
export function isDeleteBlockedByDependencies(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 409 && status !== 422) return false
  const code = parseCfErrorCode(bodyText)
  if (code === 10056) return true
  const msg = parseCfErrorMessage(bodyText)
  return Boolean(
    msg && /cannot delete|cannot be deleted|instances_detected|dependency|has a subdomain|has .*rout(?:e|es)/i.test(msg),
  )
}

/** A Cloudflare API failure with enough non-sensitive detail to act on. */
export class CloudflareApiError extends WorkerProvisionError {
  /** Short safe description for diagnosis (e.g. "script content invalid").
   * Stripped of anything that could echo request data. */
  reason: string | null

  constructor(step: string, httpStatus: number, cfCode: number | null, reason: string | null, correlationId: string) {
    super({
      driver: 'cloudflare',
      step,
      providerStatus: httpStatus,
      providerCode: cfCode,
      providerMessage: reason,
      correlationId,
      message: `The relay could not be provisioned by the provider. (step: ${step})${cfCode !== null ? ` (Cloudflare error ${cfCode})` : ''}${reason ? ` — ${reason}` : ''} correlationId=${correlationId}`,
    })
    this.reason = reason
  }
}

/**
 * Redacted error mapping for Cloudflare API failures. The provider can echo
 * request details (including tokens) in error bodies — only the safe code and
 * message ever reach the caller. The numeric CF error code (when present) is
 * safe: surfaced as `Cloudflare error <n>` (e.g. 10053 = script already exists).
 */
export function mapCloudflareApiError(step: string, status: number, bodyText: string, correlationId = 'unknown'): AppError {
  // Deprovision (delete) failures are a distinct class: the local row must be
  // preserved and the user is told the relay could not be removed — never
  // "already exists" even when Cloudflare reports the same HTTP codes.
  if (step === 'deprovision' && status !== 401 && status !== 403) {
    return new WorkerProvisionError({
      driver: 'cloudflare',
      step,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      correlationId,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DEPROVISION_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DEPROVISION_FAILED} (step: deprovision)${status === 409 || status === 400 ? ' — the script may be in use (routes/subdomain). A provider-supported force delete was already attempted or is not applicable.' : ''} correlationId=${correlationId}`,
    })
  }
  if (status === 401 || status === 403) {
    return new WorkerProvisionError({
      driver: 'cloudflare',
      step,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      correlationId,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CREDENTIAL_INVALID,
      message: REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CREDENTIAL_INVALID + ` (correlationId=${correlationId})`,
    })
  }
  if (status === 409) {
    return new WorkerProvisionError({
      driver: 'cloudflare',
      step,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      correlationId,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_CONFLICT,
      message: REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_CONFLICT + ` (correlationId=${correlationId})`,
    })
  }
  // CF error codes for an already-existing script (from a 400 too — the API
  // returns 400 with code 10053 rather than 409 for duplicate names).
  if (status === 400) {
    const code = parseCfErrorCode(bodyText)
    if (code === 10053 || code === 10058 || code === 11005) {
      return new WorkerProvisionError({
        driver: 'cloudflare',
        step,
        providerStatus: status,
        providerCode: code,
        providerMessage: safeCfReason(bodyText),
        correlationId,
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_CONFLICT,
        message: REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_CONFLICT + ` (correlationId=${correlationId})`,
      })
    }
  }
  return new CloudflareApiError(step, status, parseCfErrorCode(bodyText), safeCfReason(bodyText), correlationId)
}

async function cloudflareApi(
  path: string,
  options: { method?: string; apiToken: string; body?: BodyInit | null; contentType?: string; correlationId?: string; step?: string },
): Promise<{ status: number; bodyText: string }> {
  const correlationId = options.correlationId ?? 'unknown'
  const step = options.step ?? 'unknown'
  const url = `${apiBase()}${path}`
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=${step} request_started ${options.method ?? 'GET'} ${path}`)
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        // FormData bodies compute their own multipart boundary: omitting the
        // content-type lets the runtime generate `multipart/form-data;
        // boundary=...` correctly. Explicit string bodies keep their content-type.
        ...(options.body instanceof FormData ? {} : options.contentType ? { 'content-type': options.contentType } : {}),
      },
      body: options.body,
      signal: AbortSignal.timeout(apiTimeout()),
    })
  } catch (error) {
    console.error(`[worker:cloudflare] correlationId=${correlationId} step=${step} transport_error ${String((error as Error)?.message ?? error)}`)
    throw mapFetchFailure(error)
  }
  const bodyText = await response.text()
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=${step} response_received status=${response.status}`)
  const cfCode = parseCfErrorCode(bodyText)
  const cfMsg = safeCfReason(bodyText)
  if (response.status >= 300) {
    console.error(
      `[worker:cloudflare] correlationId=${correlationId} step=${step} rejected providerCode=${cfCode ?? 'null'} providerMessage="${cfMsg ?? 'null'}" httpStatus=${response.status}`,
    )
  } else {
    console.log(`[worker:cloudflare] correlationId=${correlationId} step=${step} success status=${response.status}`)
  }
  return { status: response.status, bodyText }
}

/** Verify the API token works at all (GET /user/tokens/verify). Any non-2xx
 * (401 typical, 400 for a malformed token) means the credential is invalid. */
async function validateApiToken(apiToken: string, correlationId: string) {
  logStepStarted(correlationId, 'validate_credentials')
  const { status, bodyText } = await cloudflareApi('/user/tokens/verify', { apiToken, correlationId, step: 'validate_credentials' })
  if (status >= 300) {
    logStepFailure(correlationId, 'validate_credentials', `status=${status}`)
    throw mapCloudflareApiError('validate_credentials', status, bodyText, correlationId)
  }
  logStepSuccess(correlationId, 'validate_credentials')
}

// ────────────────────────────────────────────────────────────────────────────
// Relay artifact helpers
// ────────────────────────────────────────────────────────────────────────────

export interface BuiltRelayArtifact {
  source: string
  moduleName: string
  metadata: string
  moduleBytes: number
  moduleSha256: string
}

/**
 * Build relay artifact WITHOUT secret (initial upload). Validates locally,
 * dumps debug artifacts, and returns safe metadata for logging.
 */
export async function buildRelayArtifact(correlationId: string): Promise<BuiltRelayArtifact> {
  logStepStarted(correlationId, 'build_relay')
  let artifact: BuiltRelayArtifact
  try {
    const { source, moduleName, metadata } = buildCloudflareRelayWithoutSecret()
    const moduleBytes = Buffer.byteLength(source, 'utf8')
    const moduleSha256 = relaySourceSha256(source)
    artifact = { source, moduleName, metadata, moduleBytes, moduleSha256 }
    console.log(
      `[worker:cloudflare] correlationId=${correlationId} step=build_relay success moduleBytes=${moduleBytes} moduleSha256=${moduleSha256} module=${moduleName} mainModule=${moduleName} contentType=${RELAY_MODULE_CONTENT_TYPE}`,
    )
    logStepSuccess(correlationId, 'build_relay', `moduleBytes=${moduleBytes}`)
  } catch (error) {
    logStepFailure(correlationId, 'build_relay', String((error as Error)?.message ?? error))
    if (error instanceof AppError) throw error
    throw new WorkerProvisionError({
      step: 'build_relay',
      correlationId,
      providerMessage: String((error as Error)?.message ?? error),
    })
  }
  // Dump artifacts (non-production only)
  await dumpRelayStage(artifact.source, artifact.metadata, correlationId)
  // Preflight validation
  await preflightRelay(artifact.source, correlationId)
  return artifact
}

/**
 * Build relay artifact WITH secret (for configure_secret step). The source is
 * identical — secret travels only in metadata bindings.
 */
export function buildRelayArtifactWithSecret(relaySecret: string): BuiltRelayArtifact {
  const { source, moduleName, metadata } = buildCloudflareRelay(relaySecret)
  const moduleBytes = Buffer.byteLength(source, 'utf8')
  const moduleSha256 = relaySourceSha256(source)
  return { source, moduleName, metadata, moduleBytes, moduleSha256 }
}

async function dumpRelayStage(source: string, metadata: string, correlationId: string): Promise<void> {
  logStepStarted(correlationId, 'dump_artifacts')
  try {
    await dumpRelayArtifactsToDisk(source, metadata)
    logStepSuccess(correlationId, 'dump_artifacts')
  } catch (error) {
    logStepFailure(correlationId, 'dump_artifacts', String((error as Error)?.message ?? error))
    // Dump failures are non-fatal (the artifact is still valid); log only.
  }
}

async function preflightRelay(source: string, correlationId: string): Promise<void> {
  logStepStarted(correlationId, 'preflight_relay')
  try {
    await validateRelaySource(source)
    logStepSuccess(correlationId, 'preflight_relay')
  } catch (error) {
    logStepFailure(correlationId, 'preflight_relay', String((error as Error)?.message ?? error))
    throw error
  }
}

/**
 * Build the multipart/form-data upload payload for a Worker script deploy.
 *
 * Cloudflare's Workers Scripts multipart API resolves the ES module entry by
 * matching part NAMES to `metadata.main_module` — each module is uploaded as a
 * part named after its file. The entry module part therefore MUST be named
 * `worker.mjs` (== filename == main_module) or the API cannot resolve the
 * declared entry module and rejects with parse error 10021. The module part's
 * Content-Type is `application/javascript+module`, per the API contract.
 *
 * Built with native FormData/Blob (not manual string framing) so the runtime
 * generates the multipart container, boundary and per-part framing correctly.
 */
export function multipartScriptUpload(script: string, metadata: string): { body: FormData; contentType: undefined } {
  // Assertion: main_module must match the actual part name.
  const parsed = JSON.parse(metadata) as { main_module?: string }
  if (parsed.main_module !== RELAY_MODULE_NAME) {
    throw new AppError(
      REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_BUILD_FAILED,
      `metadata.main_module must be ${RELAY_MODULE_NAME}`,
      400,
    )
  }
  const form = new FormData()
  const metadataPart = new Blob([metadata], { type: 'application/json' })
  const modulePart = new Blob([script], { type: RELAY_MODULE_CONTENT_TYPE })
  form.append('metadata', metadataPart)
  form.append(RELAY_MODULE_NAME, modulePart, RELAY_MODULE_NAME)
  return { body: form, contentType: undefined }
}

/**
 * Upload the relay script WITHOUT secret binding. This makes failures
 * unambiguous: if upload still returns 10021, the problem is module/multipart
 * not secret binding.
 */
export async function uploadWorkerScript(
  accountId: string,
  workerName: string,
  apiToken: string,
  correlationId: string,
): Promise<void> {
  logStepStarted(correlationId, 'upload_script')
  // Build artifact without secret for initial upload
  const artifact = await buildRelayArtifact(correlationId)
  console.log(
    `[worker:cloudflare] correlationId=${correlationId} step=upload_script worker=${workerName} module=${artifact.moduleName} mainModule=${artifact.moduleName} ` +
      `contentType=${RELAY_MODULE_CONTENT_TYPE} moduleBytes=${artifact.moduleBytes} ` +
      `moduleSha256=${artifact.moduleSha256} compatibilityDate=${RELAY_COMPATIBILITY_DATE} bindings=none`,
  )
  const { body, contentType } = multipartScriptUpload(artifact.source, artifact.metadata)
  const { status, bodyText } = await cloudflareApi(
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
    { method: 'PUT', apiToken, body, contentType, correlationId, step: 'upload_script' },
  )
  if (status >= 300) {
    const code = parseCfErrorCode(bodyText)
    console.error(`[worker:cloudflare] correlationId=${correlationId} step=upload_script status=${status}${code !== null ? ` cloudflareCode=${code}` : ''}`)
    logStepFailure(correlationId, 'upload_script', `status=${status} providerCode=${code ?? 'null'}`)
    throw mapCloudflareApiError('upload_script', status, bodyText, correlationId)
  }
  logStepSuccess(correlationId, 'upload_script')
}

/**
 * Configure the relay secret as a secret_text binding via a second multipart
 * PUT that includes the binding. This is a distinct traceable step after
 * upload_script so secret-binding issues are isolated from module parse issues.
 */
export async function configureRelaySecret(
  accountId: string,
  workerName: string,
  apiToken: string,
  relaySecret: string,
  correlationId: string,
): Promise<void> {
  logStepStarted(correlationId, 'configure_secret')
  const artifact = buildRelayArtifactWithSecret(relaySecret)
  // Re-validate before second upload (cheap, ensures artifact still valid)
  await validateRelaySource(artifact.source)
  // Dump the WITH-secret metadata for debugging (bindingNames only, no values)
  if (process.env.NODE_ENV !== 'production') {
    // The dump helper already writes module + metadata; for secret step we
    // ensure the metadata written reflects the WITH-secret binding names.
    await dumpRelayArtifactsToDisk(artifact.source, artifact.metadata)
  }
  console.log(
    `[worker:cloudflare] correlationId=${correlationId} step=configure_secret worker=${workerName} module=${artifact.moduleName} ` +
      `bindings=${RELAY_SECRET_BINDING} moduleBytes=${artifact.moduleBytes} sha256=${artifact.moduleSha256}`,
  )
  const { body, contentType } = multipartScriptUpload(artifact.source, artifact.metadata)
  const { status, bodyText } = await cloudflareApi(
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
    { method: 'PUT', apiToken, body, contentType, correlationId, step: 'configure_secret' },
  )
  if (status >= 300) {
    const code = parseCfErrorCode(bodyText)
    console.error(`[worker:cloudflare] correlationId=${correlationId} step=configure_secret status=${status}${code !== null ? ` cloudflareCode=${code}` : ''}`)
    logStepFailure(correlationId, 'configure_secret', `status=${status} providerCode=${code ?? 'null'}`)
    throw mapCloudflareApiError('configure_secret', status, bodyText, correlationId)
  }
  logStepSuccess(correlationId, 'configure_secret')
}

// ────────────────────────────────────────────────────────────────────────────
// Explicit endpoint-discovery steps (replaces ambiguous discover_endpoint)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A. Script-level workers.dev state: GET /accounts/{accountId}/workers/scripts/{workerName}/subdomain
 * Returns { enabled, previews_enabled } — NEVER the account subdomain string.
 */
export async function getScriptSubdomainState(
  accountId: string,
  workerName: string,
  apiToken: string,
  correlationId: string,
): Promise<{ enabled: boolean; previews_enabled?: boolean }> {
  logStepStarted(correlationId, 'get_script_subdomain_state')
  const { status, bodyText } = await cloudflareApi(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, {
    apiToken,
    correlationId,
    step: 'get_script_subdomain_state',
  })
  if (status === 401 || status === 403) {
    logStepFailure(correlationId, 'get_script_subdomain_state', `status=${status}`)
    throw mapCloudflareApiError('get_script_subdomain_state', status, bodyText, correlationId)
  }
  if (status >= 300) {
    logStepFailure(correlationId, 'get_script_subdomain_state', `status=${status}`)
    throw new WorkerProvisionError({
      step: 'get_script_subdomain_state',
      correlationId,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_SUBDOMAIN_STATE_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_SUBDOMAIN_STATE_FAILED} (step: get_script_subdomain_state) correlationId=${correlationId}`,
    })
  }
  // Robust parsing: verify HTTP success, Cloudflare success flag, result shape
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    logStepFailure(correlationId, 'get_script_subdomain_state', 'invalid json')
    throw new WorkerProvisionError({
      step: 'get_script_subdomain_state',
      correlationId,
      providerStatus: status,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_SUBDOMAIN_STATE_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_SUBDOMAIN_STATE_FAILED} (unexpected provider response) correlationId=${correlationId}`,
    })
  }
  const validation = scriptSubdomainStateSchema.safeParse(parsed)
  if (!validation.success) {
    logStepFailure(correlationId, 'get_script_subdomain_state', 'unexpected provider response shape')
    throw new WorkerProvisionError({
      step: 'get_script_subdomain_state',
      correlationId,
      providerStatus: status,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_SUBDOMAIN_STATE_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_SUBDOMAIN_STATE_FAILED} (unexpected provider response) correlationId=${correlationId}`,
    })
  }
  const data = validation.data
  if (data.success === false) {
    logStepFailure(correlationId, 'get_script_subdomain_state', 'provider success=false')
    throw new WorkerProvisionError({
      step: 'get_script_subdomain_state',
      correlationId,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_SUBDOMAIN_STATE_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_SUBDOMAIN_STATE_FAILED} correlationId=${correlationId}`,
    })
  }
  if (!data.result || typeof data.result.enabled !== 'boolean') {
    logStepFailure(correlationId, 'get_script_subdomain_state', 'missing enabled field')
    throw new WorkerProvisionError({
      step: 'get_script_subdomain_state',
      correlationId,
      providerStatus: status,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_SUBDOMAIN_STATE_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_SUBDOMAIN_STATE_FAILED} (missing enabled) correlationId=${correlationId}`,
    })
  }
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=get_script_subdomain_state response_received status=${status} enabled=${data.result.enabled}`)
  logStepSuccess(correlationId, 'get_script_subdomain_state', `enabled=${data.result.enabled}`)
  return { enabled: data.result.enabled, previews_enabled: data.result.previews_enabled }
}

/** Enable workers.dev for the deployed script if disabled. */
export async function enableScriptSubdomain(accountId: string, workerName: string, apiToken: string, correlationId: string): Promise<void> {
  logStepStarted(correlationId, 'enable_script_subdomain')
  const body = JSON.stringify({ enabled: true, previews_enabled: false })
  const { status, bodyText } = await cloudflareApi(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, {
    method: 'POST',
    apiToken,
    body,
    contentType: 'application/json',
    correlationId,
    step: 'enable_script_subdomain',
  })
  if (status === 401 || status === 403) {
    logStepFailure(correlationId, 'enable_script_subdomain', `status=${status}`)
    throw mapCloudflareApiError('enable_script_subdomain', status, bodyText, correlationId)
  }
  if (status >= 300) {
    logStepFailure(correlationId, 'enable_script_subdomain', `status=${status}`)
    throw new WorkerProvisionError({
      step: 'enable_script_subdomain',
      correlationId,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_SUBDOMAIN_ENABLE_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_SUBDOMAIN_ENABLE_FAILED} (step: enable_script_subdomain) correlationId=${correlationId}`,
    })
  }
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=enable_script_subdomain response_received status=${status} enabled=true`)
  logStepSuccess(correlationId, 'enable_script_subdomain')
}

/**
 * B. Account-level workers.dev subdomain: GET /accounts/{accountId}/workers/subdomain
 * Returns { subdomain: "example-name" } — this is the account workers.dev subdomain.
 */
export async function getAccountSubdomain(accountId: string, apiToken: string, correlationId: string): Promise<string | null> {
  logStepStarted(correlationId, 'get_account_subdomain')
  const { status, bodyText } = await cloudflareApi(`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`, {
    apiToken,
    correlationId,
    step: 'get_account_subdomain',
  })
  // 404 = account has no workers.dev subdomain provisioned — not an error yet, triggers create path
  if (status === 404) {
    console.log(`[worker:cloudflare] correlationId=${correlationId} step=get_account_subdomain response_received status=404 hasSubdomain=false`)
    logStepSuccess(correlationId, 'get_account_subdomain', 'hasSubdomain=false')
    return null
  }
  if (status === 401 || status === 403) {
    logStepFailure(correlationId, 'get_account_subdomain', `status=${status}`)
    throw mapCloudflareApiError('get_account_subdomain', status, bodyText, correlationId)
  }
  if (status >= 300) {
    logStepFailure(correlationId, 'get_account_subdomain', `status=${status}`)
    throw new WorkerProvisionError({
      step: 'get_account_subdomain',
      correlationId,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND} (step: get_account_subdomain) correlationId=${correlationId}`,
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    logStepFailure(correlationId, 'get_account_subdomain', 'invalid json')
    throw new WorkerProvisionError({
      step: 'get_account_subdomain',
      correlationId,
      providerStatus: status,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND} (unexpected provider response) correlationId=${correlationId}`,
    })
  }
  const validation = accountSubdomainResponseSchema.safeParse(parsed)
  if (!validation.success) {
    logStepFailure(correlationId, 'get_account_subdomain', 'unexpected provider response shape')
    throw new WorkerProvisionError({
      step: 'get_account_subdomain',
      correlationId,
      providerStatus: status,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND} (unexpected provider response) correlationId=${correlationId}`,
    })
  }
  const data = validation.data
  if (data.success === false) {
    // Cloudflare can return success:false with errors array — treat as API error, not missing
    logStepFailure(correlationId, 'get_account_subdomain', 'provider success=false')
    throw new WorkerProvisionError({
      step: 'get_account_subdomain',
      correlationId,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND} correlationId=${correlationId}`,
    })
  }
  const subdomain = data.result?.subdomain ?? null
  // Distinguish permission error vs missing configuration: 401/403 already handled, so null here is genuine missing
  if (!subdomain || typeof subdomain !== 'string' || subdomain.trim().length === 0) {
    console.log(`[worker:cloudflare] correlationId=${correlationId} step=get_account_subdomain response_received status=${status} hasSubdomain=false`)
    logStepSuccess(correlationId, 'get_account_subdomain', 'hasSubdomain=false')
    return null
  }
  const normalized = subdomain.trim().toLowerCase()
  if (!isValidWorkersSubdomain(normalized)) {
    logStepFailure(correlationId, 'get_account_subdomain', `invalid subdomain format subdomain=${normalized}`)
    throw new WorkerProvisionError({
      step: 'get_account_subdomain',
      correlationId,
      providerStatus: status,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND} (invalid subdomain) correlationId=${correlationId}`,
    })
  }
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=get_account_subdomain response_received status=${status} hasSubdomain=true`)
  logStepSuccess(correlationId, 'get_account_subdomain', 'hasSubdomain=true')
  return normalized
}

/** Create account workers.dev subdomain via PUT: only if genuinely absent, never overwrites existing. */
export async function createAccountSubdomain(accountId: string, apiToken: string, correlationId: string, candidate?: string): Promise<string> {
  const subdomainCandidate = (candidate ?? generateCandidateSubdomain(accountId)).toLowerCase()
  if (!isValidWorkersSubdomain(subdomainCandidate)) {
    throw new WorkerProvisionError({
      step: 'create_account_subdomain',
      correlationId,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED} (invalid candidate) correlationId=${correlationId}`,
    })
  }
  logStepStarted(correlationId, 'create_account_subdomain', `candidate=${subdomainCandidate}`)
  const body = JSON.stringify({ subdomain: subdomainCandidate })
  const { status, bodyText } = await cloudflareApi(`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`, {
    method: 'PUT',
    apiToken,
    body,
    contentType: 'application/json',
    correlationId,
    step: 'create_account_subdomain',
  })
  if (status === 401 || status === 403) {
    logStepFailure(correlationId, 'create_account_subdomain', `status=${status}`)
    throw mapCloudflareApiError('create_account_subdomain', status, bodyText, correlationId)
  }
  if (status === 409) {
    logStepFailure(correlationId, 'create_account_subdomain', `conflict status=409`)
    throw new WorkerProvisionError({
      step: 'create_account_subdomain',
      correlationId,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED,
      message: `The workers.dev subdomain name is already taken or the account subdomain already exists. Please configure a subdomain manually in the Cloudflare dashboard. (correlationId=${correlationId})`,
    })
  }
  if (status >= 300) {
    logStepFailure(correlationId, 'create_account_subdomain', `status=${status}`)
    throw new WorkerProvisionError({
      step: 'create_account_subdomain',
      correlationId,
      providerStatus: status,
      providerCode: parseCfErrorCode(bodyText),
      providerMessage: safeCfReason(bodyText),
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED} (step: create_account_subdomain) correlationId=${correlationId}`,
    })
  }
  // Verify response contains the created subdomain
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    // If body not JSON but status 2xx, assume candidate was accepted
    console.log(`[worker:cloudflare] correlationId=${correlationId} step=create_account_subdomain response_received status=${status} subdomain=${subdomainCandidate}`)
    logStepSuccess(correlationId, 'create_account_subdomain', `subdomain=${subdomainCandidate}`)
    return subdomainCandidate
  }
  const validation = accountSubdomainResponseSchema.safeParse(parsed)
  const created = validation.success ? (validation.data.result?.subdomain ?? subdomainCandidate) : subdomainCandidate
  const normalized = String(created).toLowerCase()
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=create_account_subdomain response_received status=${status} subdomain=${normalized}`)
  logStepSuccess(correlationId, 'create_account_subdomain', `subdomain=${normalized}`)
  return normalized
}

/** Build endpoint only after both prerequisites are valid. */
export function buildEndpointUrl(workerName: string, accountSubdomain: string, correlationId: string): string {
  logStepStarted(correlationId, 'build_endpoint')
  if (!workerName || !accountSubdomain) {
    logStepFailure(correlationId, 'build_endpoint', 'missing workerName or subdomain')
    throw new WorkerProvisionError({
      step: 'build_endpoint',
      correlationId,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_BUILD_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_BUILD_FAILED} correlationId=${correlationId}`,
    })
  }
  const normalizedWorker = workerName.toLowerCase()
  const normalizedSub = accountSubdomain.toLowerCase()
  if (!isValidWorkersSubdomain(normalizedSub)) {
    logStepFailure(correlationId, 'build_endpoint', `invalid subdomain subdomain=${normalizedSub}`)
    throw new WorkerProvisionError({
      step: 'build_endpoint',
      correlationId,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_BUILD_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_BUILD_FAILED} (invalid subdomain) correlationId=${correlationId}`,
    })
  }
  const endpointUrl = `https://${normalizedWorker}.${normalizedSub}.workers.dev`
  let normalized: string
  try {
    normalized = normalizeEndpointUrl(endpointUrl)
  } catch (error) {
    logStepFailure(correlationId, 'build_endpoint', String((error as Error)?.message ?? error))
    throw new WorkerProvisionError({
      step: 'build_endpoint',
      correlationId,
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_BUILD_FAILED,
      message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_BUILD_FAILED} (invalid endpoint) correlationId=${correlationId}`,
      cause: error,
    })
  }
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=build_endpoint success host=${new URL(normalized).host}`)
  logStepSuccess(correlationId, 'build_endpoint', `host=${new URL(normalized).host}`)
  return normalized
}

/**
 * Discover the deployed workers.dev subdomain — legacy wrapper.
 * Uses correct separation: script state + account subdomain.
 * Kept for backward compat; new code should call explicit steps.
 */
export async function discoverEndpoint(accountId: string, workerName: string, apiToken: string, correlationId: string): Promise<string | null> {
  logStepStarted(correlationId, 'discover_endpoint')
  try {
    const state = await getScriptSubdomainState(accountId, workerName, apiToken, correlationId)
    if (!state.enabled) {
      await enableScriptSubdomain(accountId, workerName, apiToken, correlationId)
    } else {
      console.log(`[worker:cloudflare] correlationId=${correlationId} step=enable_script_subdomain skipped enabled=true`)
    }
    let accountSubdomain = await getAccountSubdomain(accountId, apiToken, correlationId)
    if (!accountSubdomain) {
      try {
        accountSubdomain = await createAccountSubdomain(accountId, apiToken, correlationId)
      } catch (createErr) {
        // If creation fails due to permission, surface actionable error rather than generic null
        if (createErr instanceof WorkerProvisionError && (createErr.providerStatus === 401 || createErr.providerStatus === 403)) {
          throw new WorkerProvisionError({
            step: 'discover_endpoint',
            correlationId,
            providerStatus: createErr.providerStatus,
            providerCode: createErr.providerCode,
            providerMessage: createErr.providerMessage,
            code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED,
            message: `The workers.dev subdomain is not configured and automatic creation is not permitted. Please create a workers.dev subdomain manually in the Cloudflare dashboard. (correlationId=${correlationId})`,
            cause: createErr,
          })
        }
        throw createErr
      }
    }
    if (!accountSubdomain) {
      logStepFailure(correlationId, 'discover_endpoint', 'subdomain null')
      return null
    }
    const endpointUrl = buildEndpointUrl(workerName, accountSubdomain, correlationId)
    logStepSuccess(correlationId, 'discover_endpoint', `subdomain=${accountSubdomain}`)
    return endpointUrl
  } catch (error) {
    if (error instanceof WorkerProvisionError) throw error
    logStepFailure(correlationId, 'discover_endpoint', String((error as Error)?.message ?? error))
    return null
  }
}

/**
 * Remove the remote script. Idempotent:
 * - 2xx → result `deleted`
 * - HTTP 404 / provider "script not found" envelope → result `already_absent` (success)
 * - dependency-blocking error (routes/subdomain attached) → ONE retry with
 *   `?force=true` (the provider-supported remedy; never force otherwise)
 * - anything else → throws mapCloudflareApiError (genuine failure, caller must
 *   preserve the local row)
 * Only the script is deleted — the account-level workers.dev subdomain is
 * shared across the account and is NEVER touched by deprovision.
 */
async function deleteWorkerScript(
  accountId: string,
  workerName: string,
  apiToken: string,
  correlationId?: string,
  opts?: { force?: boolean },
): Promise<WorkerDeprovisionResult['result']> {
  const cid = correlationId ?? 'unknown'
  const suffix = opts?.force ? '?force=true' : ''
  const path = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}${suffix}`
  logStepStarted(cid, 'deprovision', `worker=${workerName}${opts?.force ? ' force=true' : ''}`)
  const { status, bodyText } = await cloudflareApi(path, {
    method: 'DELETE',
    apiToken,
    correlationId: cid,
    step: 'deprovision',
  })

  // Already absent (HTTP 404 or provider envelope) → success, idempotent.
  if (isScriptNotFoundEnvelope(status, bodyText)) {
    logStepSuccess(cid, 'deprovision', `result=already_absent status=${status}`)
    return 'already_absent'
  }
  if (status >= 200 && status < 300) {
    logStepSuccess(cid, 'deprovision', `result=deleted status=${status}`)
    return 'deleted'
  }

  // Dependency-blocked normal delete → one provider-supported force retry.
  if (!opts?.force && isDeleteBlockedByDependencies(status, bodyText)) {
    logStepFailure(cid, 'deprovision', `dependency_blocked status=${status} retry_force=true`)
    return deleteWorkerScript(accountId, workerName, apiToken, cid, { force: true })
  }

  logStepFailure(cid, 'deprovision', `status=${status}`)
  throw mapCloudflareApiError('deprovision', status, bodyText, cid)
}

function configBlob(config: { accountId: string; workerName: string }, apiToken: string, endpointUrl: string | null | undefined): unknown {
  return {
    version: 1,
    config: { accountId: config.accountId, workerName: config.workerName },
    credentials: { apiToken },
    runtime: { endpointUrl: endpointUrl ?? null, protocolVersion: RELAY_PROTOCOL_VERSION },
  }
}

function parseConfig(raw: Record<string, string>): { accountId: string; apiToken: string; workerName: string } {
  try {
    const parsed = registrationSchema.parse(raw)
    return { accountId: parsed.accountId, apiToken: parsed.apiToken, workerName: parsed.workerName }
  } catch {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DRIVER_CONFIG_INVALID, 400)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Driver implementation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validate registration credentials (managed driver). Verifies the API token
 * against Cloudflare BEFORE any DB write, and rejects endpointUrl (the
 * endpoint is system-discovered after provisioning).
 */
async function validateConfig(input: {
  endpointUrl?: string | null
  config?: Record<string, string> | null
  correlationId?: string
}): Promise<{ endpointUrl?: string | null; configEncryptedInput?: unknown }> {
  if (input.endpointUrl) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DRIVER_CONFIG_INVALID + ' Endpoint URL is managed by 9Drive for this service.', 400)
  }
  const { accountId, apiToken, workerName } = parseConfig(input.config ?? {})
  const correlationId = input.correlationId ?? generateCorrelationId()
  await validateApiToken(apiToken, correlationId)
  return { endpointUrl: null, configEncryptedInput: configBlob({ accountId, workerName }, apiToken, null) }
}

/**
 * Provision: deploy relay script → configure secret → discover endpoint.
 * Explicit staged sequence for traceability.
 */
async function provision(input: WorkerProvisionInput): Promise<WorkerProvisionResult> {
  const correlationId = input.correlationId ?? generateCorrelationId()
  console.log(`[worker:cloudflare] correlationId=${correlationId} provision started worker=${input.config.workerName}`)
  const { accountId, apiToken, workerName } = parseConfig(input.config)
  try {
    // Stage: validate_credentials (token already validated in service, but re-validate for standalone calls)
    logStepStarted(correlationId, 'validate_credentials')
    await validateApiToken(apiToken, correlationId)
    logStepSuccess(correlationId, 'validate_credentials')

    // Stage: upload_script (includes build_relay + preflight_relay + dump)
    await uploadWorkerScript(accountId, workerName, apiToken, correlationId)

    // Stage: configure_secret (distinct)
    await configureRelaySecret(accountId, workerName, apiToken, input.secret, correlationId)

    // Stage: get_script_subdomain_state → enable_script_subdomain
    const scriptState = await getScriptSubdomainState(accountId, workerName, apiToken, correlationId)
    if (!scriptState.enabled) {
      await enableScriptSubdomain(accountId, workerName, apiToken, correlationId)
    } else {
      console.log(`[worker:cloudflare] correlationId=${correlationId} step=enable_script_subdomain skipped enabled=true`)
    }

    // Stage: get_account_subdomain → create_account_subdomain if needed
    let accountSubdomain = await getAccountSubdomain(accountId, apiToken, correlationId)
    if (!accountSubdomain) {
      try {
        accountSubdomain = await createAccountSubdomain(accountId, apiToken, correlationId)
      } catch (createErr) {
        if (createErr instanceof WorkerProvisionError && (createErr.providerStatus === 401 || createErr.providerStatus === 403)) {
          throw new WorkerProvisionError({
            step: 'create_account_subdomain',
            correlationId,
            providerStatus: createErr.providerStatus,
            providerCode: createErr.providerCode,
            providerMessage: createErr.providerMessage,
            code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED,
            message: `The workers.dev subdomain is not configured for this account and the API token lacks permission to create it. Please create a workers.dev subdomain manually in the Cloudflare dashboard, or use a token with Account Settings edit permission. (correlationId=${correlationId})`,
            cause: createErr,
          })
        }
        throw createErr
      }
    } else {
      console.log(`[worker:cloudflare] correlationId=${correlationId} step=create_account_subdomain skipped exists=true subdomain=${accountSubdomain}`)
    }

    if (!accountSubdomain) {
      logStepFailure(correlationId, 'get_account_subdomain', 'subdomain null after create attempt')
      throw new WorkerProvisionError({
        step: 'get_account_subdomain',
        correlationId,
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND,
        message: `No workers.dev subdomain is configured for this account. Please enable workers.dev in the Cloudflare dashboard (correlationId=${correlationId})`,
      })
    }

    // Stage: build_endpoint
    const endpointUrl = buildEndpointUrl(workerName, accountSubdomain, correlationId)
    logStepSuccess(correlationId, 'persist_worker', `endpoint=${endpointUrl}`)
    console.log(`[worker:cloudflare] correlationId=${correlationId} provision success endpoint=${endpointUrl}`)
    return {
      endpointUrl,
      protocolVersion: RELAY_PROTOCOL_VERSION,
      configEncryptedInput: configBlob({ accountId, workerName }, apiToken, endpointUrl),
    }
  } catch (error) {
    const safeCode = error instanceof AppError ? error.code : REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED
    const safeMessage = error instanceof AppError ? error.message : REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED
    const providerStatus = error instanceof WorkerProvisionError ? error.providerStatus : null
    const providerCode = error instanceof WorkerProvisionError ? error.providerCode : parseCfErrorCode(String((error as Error)?.message ?? ''))
    const step = error instanceof WorkerProvisionError ? error.step : 'provision'
    console.error(
      `[worker:cloudflare] correlationId=${correlationId} provision failed step=${step} httpStatus=${providerStatus ?? 'null'} providerCode=${providerCode ?? 'null'} providerMessage="${safeMessage}" correlationId=${correlationId}`,
    )
    // Enrich error with correlationId if not already
    if (error instanceof WorkerProvisionError) {
      throw error
    }
    if (error instanceof AppError) {
      // Preserve original code but wrap with correlation and step
      throw new WorkerProvisionError({
        step,
        correlationId,
        providerStatus,
        providerCode,
        providerMessage: safeMessage,
        code: safeCode,
        message: safeMessage + ` (correlationId=${correlationId})`,
        cause: error,
      })
    }
    throw new WorkerProvisionError({
      step: 'provision',
      correlationId,
      providerMessage: safeMessage,
      message: `The relay could not be provisioned by the provider. (correlationId=${correlationId})`,
      cause: error,
    })
  }
}

/**
 * Update after an edit (managed). Diffs internally:
 * - workerName changed → deploy new script (with secret binding), delete the old.
 * - accountId changed → treat as a fresh provision (old script removed
 *   best-effort).
 * - apiToken-only change → nothing to redeploy (token is API-only).
 */
async function update(input: WorkerUpdateInput): Promise<WorkerUpdateResult> {
  const correlationId = input.correlationId ?? generateCorrelationId()
  const newConfig = parseConfig({ ...input.storedConfig, ...input.config })
  const stored = parseConfig(input.storedConfig)
  const accountChanged = newConfig.accountId !== stored.accountId
  const nameChanged = newConfig.workerName !== stored.workerName
  const effectiveAccountId = accountChanged ? newConfig.accountId : stored.accountId
  const effectiveWorkerName = nameChanged ? newConfig.workerName : stored.workerName

  if (nameChanged) {
    await uploadWorkerScript(newConfig.accountId, newConfig.workerName, newConfig.apiToken, correlationId)
    await configureRelaySecret(newConfig.accountId, newConfig.workerName, newConfig.apiToken, input.secret, correlationId)
  } else if (accountChanged) {
    await uploadWorkerScript(effectiveAccountId, effectiveWorkerName, newConfig.apiToken, correlationId)
    await configureRelaySecret(effectiveAccountId, effectiveWorkerName, newConfig.apiToken, input.secret, correlationId)
  }

  if (nameChanged || accountChanged) {
    const scriptState = await getScriptSubdomainState(effectiveAccountId, effectiveWorkerName, newConfig.apiToken, correlationId)
    if (!scriptState.enabled) {
      await enableScriptSubdomain(effectiveAccountId, effectiveWorkerName, newConfig.apiToken, correlationId)
    } else {
      console.log(`[worker:cloudflare] correlationId=${correlationId} step=enable_script_subdomain skipped enabled=true`)
    }
    let accountSubdomain = await getAccountSubdomain(effectiveAccountId, newConfig.apiToken, correlationId)
    if (!accountSubdomain) {
      try {
        accountSubdomain = await createAccountSubdomain(effectiveAccountId, newConfig.apiToken, correlationId)
      } catch (createErr) {
        if (createErr instanceof WorkerProvisionError && (createErr.providerStatus === 401 || createErr.providerStatus === 403)) {
          throw new WorkerProvisionError({
            step: 'create_account_subdomain',
            correlationId,
            providerStatus: createErr.providerStatus,
            providerCode: createErr.providerCode,
            providerMessage: createErr.providerMessage,
            code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED,
            message: `The workers.dev subdomain is not configured and automatic creation is not permitted. Please create a workers.dev subdomain manually in the Cloudflare dashboard. (correlationId=${correlationId})`,
            cause: createErr,
          })
        }
        throw createErr
      }
    } else {
      console.log(`[worker:cloudflare] correlationId=${correlationId} step=create_account_subdomain skipped exists=true subdomain=${accountSubdomain}`)
    }
    if (!accountSubdomain) {
      throw new WorkerProvisionError({
        step: 'get_account_subdomain',
        correlationId,
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND,
        message: `No workers.dev subdomain is configured for this account. Please enable workers.dev in the Cloudflare dashboard (correlationId=${correlationId})`,
      })
    }
    const endpointUrl = buildEndpointUrl(effectiveWorkerName, accountSubdomain, correlationId)
    // Old script cleanup (best-effort; the rename is already live at the new name).
    if (nameChanged && (stored.accountId !== newConfig.accountId || stored.workerName !== newConfig.workerName)) {
      try {
        await deleteWorkerScript(stored.accountId, stored.workerName, stored.apiToken, correlationId)
      } catch {
        // Old script may be gone or unreachable — the new one is verified.
      }
    }
    return {
      endpointUrl,
      configEncryptedInput: configBlob({ accountId: newConfig.accountId, workerName: newConfig.workerName }, newConfig.apiToken, endpointUrl),
    }
  }
  return {
    endpointUrl: undefined,
    configEncryptedInput: configBlob({ accountId: newConfig.accountId, workerName: newConfig.workerName }, newConfig.apiToken, undefined),
  }
}

/** Remove the remote script. Idempotent (404 = already gone). */
async function deprovision(input: WorkerDeprovisionInput): Promise<WorkerDeprovisionResult> {
  const { accountId, apiToken, workerName } = parseConfig(input.config)
  const correlationId = input.correlationId ?? generateCorrelationId()
  const result = await deleteWorkerScript(accountId, workerName, apiToken, correlationId)
  return { result }
}

/** Test connection: GET {endpoint}/health with an HMAC signature. */
async function testConnection(input: {
  endpointUrl: string
  authType: RemoteFetchWorkerAuthType
  secret?: string | null
  correlationId?: string
}): Promise<WorkerHealthProbe> {
  const correlationId = input.correlationId ?? generateCorrelationId()
  logStepStarted(correlationId, 'health_check', `endpoint=${input.endpointUrl}`)
  const endpointUrl = normalizeEndpointUrl(input.endpointUrl)
  const pathWithQuery = '/health'
  const headers: Record<string, string> = { accept: 'application/json' }
  if (input.authType === 'hmac' && input.secret) {
    headers[HMAC_SIGNATURE_HEADER] = signHealthRequest(input.secret, 'GET', pathWithQuery)
  } else if (input.authType === 'bearer' && input.secret) {
    headers.authorization = `Bearer ${input.secret}`
  }
  const timeoutMs = env.WORKER_TEST_TIMEOUT_SECONDS * 1000
  let response: Response
  try {
    console.log(`[worker:cloudflare] correlationId=${correlationId} step=health_check request_started GET ${endpointUrl}${pathWithQuery}`)
    response = await fetch(endpointUrl + pathWithQuery, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
    console.log(`[worker:cloudflare] correlationId=${correlationId} step=health_check response_received status=${response.status}`)
  } catch (error) {
    logStepFailure(correlationId, 'health_check', `transport_error ${String((error as Error)?.message ?? error)}`)
    throw mapFetchFailure(error)
  }
  if (response.status === 401 || response.status === 403) {
    logStepFailure(correlationId, 'health_check', `auth_failed status=${response.status}`)
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
  }
  if (!response.ok) {
    logStepFailure(correlationId, 'health_check', `unhealthy status=${response.status}`)
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_UNHEALTHY, 400)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    logStepFailure(correlationId, 'health_check', 'protocol_invalid json parse')
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
  }
  try {
    const probe = validateHealthPayload(body)
    logStepSuccess(correlationId, 'health_check', `protocol=${probe.protocolVersion ?? 'unknown'}`)
    return probe
  } catch (error) {
    logStepFailure(correlationId, 'health_check', String((error as AppError)?.code ?? error))
    throw error
  }
}

const metadata: WorkerDriverMetadata = {
  key: 'cloudflare',
  displayName: 'Cloudflare Worker',
  managed: true,
  authTypes: ['hmac'],
  fields: [
    {
      key: 'accountId',
      label: 'Account ID',
      type: 'text',
      required: true,
      help: 'Your Cloudflare Account ID.',
    },
    {
      key: 'apiToken',
      label: 'API Token',
      type: 'password',
      secret: true,
      required: true,
      help: 'Must include "Workers Scripts: Edit" permission. Encrypted on 9Drive and never shown again; leave blank on edit to keep the stored token.',
    },
    {
      key: 'workerName',
      label: 'Worker Name',
      type: 'text',
      required: true,
      autoFillNameFrom: 'workerName',
      help: 'The name used for the deployed 9Drive relay Worker (1-63 characters: letters, digits, _ or -).',
    },
  ],
}

function createTransport(worker: { endpointUrl: string; authType: RemoteFetchWorkerAuthType; secretDecrypted?: string | null }): import('../types.js').RemoteFetchTransport {
  if (worker.authType !== 'hmac') {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
  }
  if (!worker.secretDecrypted) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
  }
  const normalized = normalizeEndpointUrl(worker.endpointUrl)
  return new CloudflareRemoteFetchTransport({
    endpointUrl: normalized,
    secret: worker.secretDecrypted,
    driver: 'cloudflare',
  })
}

export const cloudflareWorkerDriver: RemoteFetchWorkerDriver = {
  key: 'cloudflare',
  displayName: 'Cloudflare Worker',
  validateConfig,
  provision,
  update,
  deprovision,
  testConnection,
  createTransport,
  getMetadata: () => metadata,
}
