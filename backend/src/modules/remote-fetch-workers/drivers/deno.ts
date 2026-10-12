import crypto from 'node:crypto'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import type {
  RemoteFetchWorkerAuthType,
  RemoteFetchWorkerDriver,
  WorkerDriverMetadata,
  WorkerHealthProbe,
} from '../types.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from '../errors.js'
import { DenoRemoteFetchTransport } from '../transports/deno-transport.js'
import { DENO_CAPABILITIES, PROVIDER_SAFETY_BUDGETS } from '../provider-capabilities.js'
import { RELAY_PROTOCOL_VERSION as CANONICAL_RELAY_PROTOCOL_VERSION } from '../relay-protocol.js'

/**
 * Deno Deploy relay driver (manual-endpoint, this phase).
 *
 * 9Drive does NOT provision Deno apps in this phase (managed provisioning
 * deferred by operator decision). The user deploys
 * `drivers/deno-relay/worker.ts` on Deno Deploy, sets `RELAY_SECRET`, and
 * registers the app URL + secret here. Transport, protocol, streaming, Range,
 * SSRF, header-allowlist and error semantics match Cloudflare exactly.
 */

export const DENO_RELAY_SERVICE_IDENTITY = '9drive-relay'
const SUPPORTED_PROTOCOLS = new Set<string>([CANONICAL_RELAY_PROTOCOL_VERSION])

function normalizeEndpointUrl(raw: string): string {
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
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

export function signDenoHealthRequest(secret: string, method: string, pathWithQuery: string): string {
  return crypto.createHmac('sha256', secret).update(`${method} ${pathWithQuery}`, 'utf8').digest('hex')
}

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

export function validateDenoHealthPayload(body: unknown): WorkerHealthProbe {
  if (!body || typeof body !== 'object') {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
  }
  const record = body as Record<string, unknown>
  if (record.service !== DENO_RELAY_SERVICE_IDENTITY) {
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

async function validateConfig(input: {
  endpointUrl?: string | null
  authType?: RemoteFetchWorkerAuthType
  secret?: string | null
  config?: Record<string, string> | null
  correlationId?: string
}): Promise<{ endpointUrl?: string | null; configEncryptedInput?: unknown }> {
  const authType = input.authType ?? 'hmac'
  if (!['hmac', 'bearer', 'none'].includes(authType)) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DRIVER_CONFIG_INVALID, 400)
  }
  if (!input.endpointUrl) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  }
  const endpointUrl = normalizeEndpointUrl(input.endpointUrl)
  if ((authType === 'hmac' || authType === 'bearer') && !input.secret) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, 'A relay secret is required for this auth type.', 400)
  }
  return { endpointUrl, configEncryptedInput: { manual: true, provider: 'deno' } }
}

async function testConnection(input: { endpointUrl: string; authType: RemoteFetchWorkerAuthType; secret?: string | null; correlationId?: string }): Promise<WorkerHealthProbe> {
  const endpoint = normalizeEndpointUrl(input.endpointUrl)
  const url = `${endpoint.replace(/\/$/, '')}/health`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (input.authType === 'hmac') {
    if (!input.secret) throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
    headers['x-9drive-signature'] = signDenoHealthRequest(input.secret, 'GET', '/health')
  } else if (input.authType === 'bearer') {
    if (!input.secret) throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
    headers.authorization = `Bearer ${input.secret}`
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(env.WORKER_TEST_TIMEOUT_SECONDS * 1000),
    })
  } catch (error) {
    const msg = String((error as Error)?.message ?? '').toLowerCase()
    if (msg.includes('timeout') || msg.includes('abort')) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CONNECTION_TIMEOUT, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CONNECTION_TIMEOUT, 400)
    }
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CONNECTION_REFUSED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CONNECTION_REFUSED, 400)
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
  }
  if (!res.ok) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_UNHEALTHY, 400)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
  }
  return validateDenoHealthPayload(body)
}

function createTransport(worker: { endpointUrl: string; authType: RemoteFetchWorkerAuthType; secretDecrypted?: string | null }): import('../types.js').RemoteFetchTransport {
  const normalized = normalizeEndpointUrl(worker.endpointUrl)
  if (worker.authType === 'hmac') {
    if (!worker.secretDecrypted) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
    }
    return new DenoRemoteFetchTransport({ endpointUrl: normalized, secret: worker.secretDecrypted })
  }
  if (worker.authType === 'bearer' || worker.authType === 'none') {
    // Bearer/none manual relays share the same v1 wire; HMAC secret empty is
    // only valid for `none`. Reuse the Deno transport with an empty secret —
    // the relay verifies accordingly (none = no signature required only when
    // the deployment is configured that way; default templates require HMAC).
    return new DenoRemoteFetchTransport({ endpointUrl: normalized, secret: worker.secretDecrypted ?? '' })
  }
  throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
}

const metadata: WorkerDriverMetadata = {
  key: 'deno',
  displayName: 'Deno Relay (manual)',
  managed: false,
  authTypes: ['hmac', 'bearer', 'none'],
  fields: [],
  provider: DENO_CAPABILITIES,
  safetyBudgets: PROVIDER_SAFETY_BUDGETS.deno,
}

export const denoWorkerDriver: RemoteFetchWorkerDriver = {
  key: 'deno',
  displayName: 'Deno Relay (manual)',
  validateConfig,
  testConnection,
  createTransport,
  getMetadata: () => metadata,
  getCapabilities: () => DENO_CAPABILITIES,
}
