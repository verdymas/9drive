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
import { VpsRemoteFetchTransport } from '../transports/vps-transport.js'
import { VPS_CAPABILITIES, PROVIDER_SAFETY_BUDGETS } from '../provider-capabilities.js'
import { RELAY_PROTOCOL_VERSION as CANONICAL_RELAY_PROTOCOL_VERSION } from '../relay-protocol.js'

/**
 * Virtual Private Server relay driver (manual-endpoint, self-hosted).
 *
 * The operator deploys `drivers/vps-relay/server.js` on a 1 vCPU / 1 GB VPS
 * via the Upload-ZIP → Dockerfile workflow, sets `RELAY_SECRET`, and registers
 * the HTTPS endpoint URL + secret here. Transport, protocol, streaming, Range,
 * header-allowlist and error semantics match Cloudflare/Deno exactly; only the
 * driver key/label and capability note differ.
 *
 * Auth is HMAC-only: every URL-fetching operation requires the shared secret.
 */

export const VPS_RELAY_SERVICE_IDENTITY = '9drive-relay'
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
  // Preserve any configured sub-path (e.g. https://host/relay); only strip trailing slashes.
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

export function signVpsHealthRequest(secret: string, method: string, pathWithQuery: string): string {
  return crypto.createHmac('sha256', secret).update(`${method} ${pathWithQuery}`, 'utf8').digest('hex')
}

function sanitizeCapabilities(record: Record<string, unknown>): WorkerHealthProbe['capabilities'] {
  const raw = record.capabilities
  if (!raw || typeof raw !== 'object') return undefined
  const caps = raw as Record<string, unknown>
  const warmupRaw = caps.browserWarmup && typeof caps.browserWarmup === 'object' ? (caps.browserWarmup as Record<string, unknown>) : undefined
  return {
    streaming: caps.streaming === true,
    rangeRequests: caps.rangeRequests === true,
    requestContext: caps.requestContext === true,
    hls: caps.hls === true,
    maxBodyBytes: typeof caps.maxBodyBytes === 'number' ? caps.maxBodyBytes : null,
    protocolVersion: typeof caps.protocolVersion === 'string' ? caps.protocolVersion : undefined,
    ...(warmupRaw ? { browserWarmup: { supported: warmupRaw.supported === true, configured: warmupRaw.configured === true ? true : undefined } } : {}),
  }
}

export function validateVpsHealthPayload(body: unknown): WorkerHealthProbe {
  if (!body || typeof body !== 'object') {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
  }
  const record = body as Record<string, unknown>
  if (record.service !== VPS_RELAY_SERVICE_IDENTITY) {
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
  if (authType !== 'hmac') {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, 'Virtual Private Server requires HMAC authentication.', 400)
  }
  if (!input.endpointUrl) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_ENDPOINT_INVALID, 400)
  }
  const endpointUrl = normalizeEndpointUrl(input.endpointUrl)
  if (!input.secret) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, 'A relay secret is required for HMAC authentication.', 400)
  }
  return { endpointUrl, configEncryptedInput: { manual: true, provider: 'vps' } }
}

async function testConnection(input: { endpointUrl: string; authType: RemoteFetchWorkerAuthType; secret?: string | null; correlationId?: string }): Promise<WorkerHealthProbe> {
  if (input.authType !== 'hmac') {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, 'Virtual Private Server requires HMAC authentication.', 400)
  }
  const endpoint = normalizeEndpointUrl(input.endpointUrl)
  const url = `${endpoint.replace(/\/$/, '')}/health`
  if (!input.secret) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-9drive-signature': signVpsHealthRequest(input.secret, 'GET', '/health'),
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
  return validateVpsHealthPayload(body)
}

function createTransport(worker: { endpointUrl: string; authType: RemoteFetchWorkerAuthType; secretDecrypted?: string | null }): import('../types.js').RemoteFetchTransport {
  const normalized = normalizeEndpointUrl(worker.endpointUrl)
  if (worker.authType !== 'hmac' || !worker.secretDecrypted) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
  }
  return new VpsRemoteFetchTransport({ endpointUrl: normalized, secret: worker.secretDecrypted })
}

const metadata: WorkerDriverMetadata = {
  key: 'vps',
  displayName: 'Virtual Private Server',
  managed: false,
  authTypes: ['hmac'],
  fields: [],
  provider: VPS_CAPABILITIES,
  safetyBudgets: PROVIDER_SAFETY_BUDGETS.vps,
}

export const vpsWorkerDriver: RemoteFetchWorkerDriver = {
  key: 'vps',
  displayName: 'Virtual Private Server',
  validateConfig,
  testConnection,
  createTransport,
  getMetadata: () => metadata,
  getCapabilities: () => VPS_CAPABILITIES,
}
