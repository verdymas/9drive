import crypto from 'node:crypto'
import { z } from 'zod'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import type {
  RemoteFetchWorkerDriver,
  RemoteFetchWorkerAuthType,
  WorkerDeprovisionInput,
  WorkerHealthProbe,
  WorkerProvisionInput,
  WorkerProvisionResult,
  WorkerUpdateInput,
  WorkerUpdateResult,
  WorkerDriverMetadata,
} from '../types.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from '../errors.js'
import { RELAY_WORKER_SOURCE } from './cloudflare-relay-worker.js'

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
export const RELAY_PROTOCOL_VERSION = '9drive-relay-v1'

/** Cloudflare binding name that carries the relay secret to the deployed script. */
export const RELAY_SECRET_BINDING = 'SECRET'

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
function parseCfErrorCode(bodyText: string): number | null {
  try {
    const parsed = JSON.parse(bodyText) as { errors?: Array<{ code?: number }> }
    return parsed.errors?.[0]?.code ?? null
  } catch {
    return null
  }
}

/** A Cloudflare API failure with enough non-sensitive detail to act on. */
export class CloudflareApiError extends AppError {
  /** Which provisioning step failed: token_verify | upload | subdomain | delete. */
  step: string
  /** Safe numeric Cloudflare error code, or null. Never the provider message. */
  cfCode: number | null
  httpStatus: number

  constructor(step: string, httpStatus: number, cfCode: number | null) {
    super(
      REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED,
      `The relay could not be provisioned by the provider. (step: ${step})${cfCode !== null ? ` (Cloudflare error ${cfCode})` : ''}`,
      400,
    )
    this.step = step
    this.cfCode = cfCode
    this.httpStatus = httpStatus
  }
}

/**
 * Redacted error mapping for Cloudflare API failures. The provider can echo
 * request details (including tokens) in error bodies — only the safe code and
 * message ever reach the caller. The numeric CF error code (when present) is
 * safe: surfaced as `Cloudflare error <n>` (e.g. 10053 = script already exists).
 */
export function mapCloudflareApiError(step: string, status: number, bodyText: string): AppError {
  if (status === 401 || status === 403) {
    return new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CREDENTIAL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CREDENTIAL_INVALID, 400)
  }
  if (status === 409) {
    return new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_CONFLICT, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_CONFLICT, 400)
  }
  // CF error codes for an already-existing script (from a 400 too — the API
  // returns 400 with code 10053 rather than 409 for duplicate names).
  if (status === 400) {
    const code = parseCfErrorCode(bodyText)
    if (code === 10053 || code === 10058 || code === 11005) {
      return new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_CONFLICT, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_CONFLICT, 400)
    }
  }
  return new CloudflareApiError(step, status, parseCfErrorCode(bodyText))
}

async function cloudflareApi(path: string, options: { method?: string; apiToken: string; body?: string; contentType?: string }): Promise<{ status: number; bodyText: string }> {
  let response: Response
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        ...(options.contentType ? { 'content-type': options.contentType } : {}),
      },
      body: options.body,
      signal: AbortSignal.timeout(apiTimeout()),
    })
  } catch (error) {
    throw mapFetchFailure(error)
  }
  const bodyText = await response.text()
  return { status: response.status, bodyText }
}

/** Verify the API token works at all (GET /user/tokens/verify). Any non-2xx
 * (401 typical, 400 for a malformed token) means the credential is invalid. */
async function validateApiToken(apiToken: string) {
  const { status } = await cloudflareApi('/user/tokens/verify', { apiToken })
  if (status >= 300) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CREDENTIAL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CREDENTIAL_INVALID, 400)
  }
}

/** Build a multipart/form-data body (string) for a Worker script upload. */
function multipartScriptUpload(script: string, relaySecret: string): { body: string; contentType: string } {
  const boundary = `----9drive-${crypto.randomBytes(16).toString('hex')}`
  const metadata = JSON.stringify({
    main_module: 'index.js',
    compatibility_date: '2024-09-01',
    bindings: [{ type: 'secret_text', name: RELAY_SECRET_BINDING, text: relaySecret }],
  })
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="script"; filename="worker.js"\r\nContent-Type: application/javascript\r\n\r\n${script}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}`,
    `--${boundary}--\r\n`,
  ]
  return { body: parts.join('\r\n'), contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Upload the bundled relay script + its secret binding in ONE multipart PUT
 * (the modern Workers Scripts API): `script` part (JS, filename worker.js —
 * the module parser keys off the filename) + `metadata` part (JSON with
 * main_module / compatibility_date / bindings, including the secret_text
 * binding carrying the generated relay secret).
 */
async function uploadWorkerScript(accountId: string, workerName: string, apiToken: string, relaySecret: string) {
  const { body, contentType } = multipartScriptUpload(RELAY_WORKER_SOURCE, relaySecret)
  const { status, bodyText } = await cloudflareApi(
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
    { method: 'PUT', apiToken, body, contentType }
  )
  if (status >= 300) throw mapCloudflareApiError('upload', status, bodyText)
}

/** Discover the deployed workers.dev subdomain for a script. */
async function getWorkerSubdomain(accountId: string, workerName: string, apiToken: string): Promise<string | null> {
  const scriptSub = await cloudflareApi(
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    { apiToken }
  )
  if (scriptSub.status >= 300) {
    const accountSub = await cloudflareApi(`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`, { apiToken })
    // A 404 here means the account has no workers.dev subdomain provisioned —
    // which is itself a useful failure to surface rather than a silent null.
    if (accountSub.status === 404) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED, 'The relay could not be provisioned by the provider. (step: subdomain — no workers.dev subdomain configured for this account)', 400)
    }
    if (accountSub.status >= 300) return null
    try {
      const parsed = JSON.parse(accountSub.bodyText) as { result?: { subdomain?: string } }
      return parsed.result?.subdomain ?? null
    } catch {
      return null
    }
  }
  try {
    const parsed = JSON.parse(scriptSub.bodyText) as { result?: { subdomain?: string } }
    return parsed.result?.subdomain ?? null
  } catch {
    return null
  }
}

/** Remove the remote script. 404 = already gone = success (idempotent). */
async function deleteWorkerScript(accountId: string, workerName: string, apiToken: string) {
  const { status, bodyText } = await cloudflareApi(
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
    { method: 'DELETE', apiToken }
  )
  if (status !== 404 && status >= 300) throw mapCloudflareApiError('delete', status, bodyText)
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
}): Promise<{ endpointUrl?: string | null; configEncryptedInput?: unknown }> {
  if (input.endpointUrl) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DRIVER_CONFIG_INVALID + ' Endpoint URL is managed by 9Drive for this service.', 400)
  }
  const { accountId, apiToken, workerName } = parseConfig(input.config ?? {})
  await validateApiToken(apiToken)
  return { endpointUrl: null, configEncryptedInput: configBlob({ accountId, workerName }, apiToken, null) }
}

/** Provision: deploy relay script (+ secret binding) → discover endpoint. */
async function provision(input: WorkerProvisionInput): Promise<WorkerProvisionResult> {
  const { accountId, apiToken, workerName } = parseConfig(input.config)
  await uploadWorkerScript(accountId, workerName, apiToken, input.secret)
  const subdomain = await getWorkerSubdomain(accountId, workerName, apiToken)
  if (!subdomain) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED, 400)
  }
  const endpointUrl = `https://${workerName}.${subdomain}.workers.dev`
  return {
    endpointUrl,
    protocolVersion: RELAY_PROTOCOL_VERSION,
    configEncryptedInput: configBlob({ accountId, workerName }, apiToken, endpointUrl),
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
  const newConfig = parseConfig({ ...input.storedConfig, ...input.config })
  const stored = parseConfig(input.storedConfig)
  const accountChanged = newConfig.accountId !== stored.accountId
  const nameChanged = newConfig.workerName !== stored.workerName
  const effectiveAccountId = accountChanged ? newConfig.accountId : stored.accountId
  const effectiveWorkerName = nameChanged ? newConfig.workerName : stored.workerName

  if (nameChanged) {
    await uploadWorkerScript(newConfig.accountId, newConfig.workerName, newConfig.apiToken, input.secret)
  } else if (accountChanged) {
    await uploadWorkerScript(effectiveAccountId, effectiveWorkerName, newConfig.apiToken, input.secret)
  }

  if (nameChanged || accountChanged) {
    const subdomain = await getWorkerSubdomain(effectiveAccountId, effectiveWorkerName, newConfig.apiToken)
    if (!subdomain) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED, 400)
    }
    const endpointUrl = `https://${effectiveWorkerName}.${subdomain}.workers.dev`
    // Old script cleanup (best-effort; the rename is already live at the new name).
    if (nameChanged && (stored.accountId !== newConfig.accountId || stored.workerName !== newConfig.workerName)) {
      try {
        await deleteWorkerScript(stored.accountId, stored.workerName, stored.apiToken)
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
async function deprovision(input: WorkerDeprovisionInput): Promise<void> {
  const { accountId, apiToken, workerName } = parseConfig(input.config)
  await deleteWorkerScript(accountId, workerName, apiToken)
}

/** Test connection: GET {endpoint}/health with an HMAC signature. */
async function testConnection(input: {
  endpointUrl: string
  authType: RemoteFetchWorkerAuthType
  secret?: string | null
}): Promise<WorkerHealthProbe> {
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
    response = await fetch(endpointUrl + pathWithQuery, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
  } catch (error) {
    throw mapFetchFailure(error)
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED, 400)
  }
  if (!response.ok) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_UNHEALTHY, 400)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID, 400)
  }
  return validateHealthPayload(body)
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
      help: 'A token with permissions to deploy and manage Workers. Encrypted on 9Drive and never shown again; leave blank on edit to keep the stored token.',
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

export const cloudflareWorkerDriver: RemoteFetchWorkerDriver = {
  key: 'cloudflare',
  displayName: 'Cloudflare Worker',
  validateConfig,
  provision,
  update,
  deprovision,
  testConnection,
  getMetadata: () => metadata,
}
