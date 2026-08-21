import crypto from 'node:crypto'
import { AppError } from '../../../utils/app-error.js'
import { validateRemoteUrl } from '../../remote-imports/ssrf.js'
import { hopHeaderResolver, type RemoteImportRequestContext } from '../../remote-imports/request-context.js'
import type { RemoteFetchRequest, RemoteFetchResponse, RemoteFetchTransport } from '../types.js'
import {
  RELAY_FETCH_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SIGNATURE_HEADER,
  serializeRelayRequest,
} from '../relay-protocol.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from '../errors.js'

const HMAC_HEADER = RELAY_SIGNATURE_HEADER

function signForRelay(secret: string, method: string, path: string): string {
  const canonical = `${method} ${path}`
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
}

/**
 * Cloudflare relay transport: forwards the request through the 9Drive Worker relay.
 * The relay is POST /fetch with HMAC; it returns {status, headers, body:base64}.
 * All bytes go via the relay — 9Drive never contacts the source directly.
 */
export class CloudflareRemoteFetchTransport implements RemoteFetchTransport {
  constructor(
    public opts: {
      endpointUrl: string
      secret: string
      workerId?: string
      driver?: string
    },
  ) {}

  async request(input: RemoteFetchRequest): Promise<RemoteFetchResponse> {
    const targetUrl = input.url
    // Validate URL before relaying (SSRF for initial host)
    try {
      await validateRemoteUrl(targetUrl)
    } catch (error) {
      throw error
    }

    const endpoint = this.opts.endpointUrl.replace(/\/$/, '')
    const relayUrl = `${endpoint}/fetch`
    const relayHost = (() => {
      try {
        return new URL(endpoint).hostname
      } catch {
        return endpoint
      }
    })()
    const targetHost = (() => {
      try {
        return new URL(targetUrl).hostname
      } catch {
        return ''
      }
    })()

    // Safe diagnostics — never log URL query, cookie, or HMAC
    const upstreamMethod = input.method ?? 'GET'
    const relayMethod = 'POST'
    const contentType = 'application/json'
    console.log(
      `[remote-import:transport] protocol=${RELAY_PROTOCOL_VERSION} route=worker workerId=${this.opts.workerId ?? 'unknown'} driver=${this.opts.driver ?? 'cloudflare'} relayHost=${relayHost} targetHost=${targetHost} relayMethod=${relayMethod} upstreamMethod=${upstreamMethod} contentType=${contentType}`,
    )

    const method = upstreamMethod
    const reqHeaders: Record<string, string> = { ...(input.headers ?? {}) }
    if (input.range) reqHeaders['Range'] = input.range
    // Merge request-context headers for the initial hop (cookie scoped to source)
    const rc = (input as any).requestContext as RemoteImportRequestContext | undefined
    if (rc) {
      try {
        const hopHeaders = hopHeaderResolver(targetUrl, rc)?.(new URL(targetUrl))
        if (hopHeaders) Object.assign(reqHeaders, hopHeaders)
      } catch {}
    }
    // Optional body: omit when not provided (HEAD/GET). Relay expects body?: string, not body:null.
    const rawBody = (input.body as unknown) as string | undefined | null
    const hasBody = rawBody !== undefined && rawBody !== null && rawBody !== ''
    const bodyValue = hasBody ? String(rawBody) : undefined
    const payload: Record<string, unknown> = {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      url: targetUrl,
      method,
      headers: reqHeaders,
      ...(bodyValue !== undefined ? { body: bodyValue } : {}),
    }
    // Canonical serialization — drifts are caught by Zod (single source of truth: relay-protocol.ts)
    let payloadText: string
    try {
      payloadText = serializeRelayRequest(payload as any)
    } catch (e) {
      throw new AppError(
        REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_PROTOCOL_ERROR,
        REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_PROTOCOL_ERROR,
        400,
      )
    }
    // Safe payload-shape diagnostics — never log URL query, cookie, auth, HMAC, or body content
    const payloadKeys = Object.keys(payload).sort().join(',')
    const payloadForLog = payload as any
    const urlType = typeof payloadForLog.url
    const methodType = typeof payloadForLog.method
    const headersType = typeof payloadForLog.headers
    const headersCount = payloadForLog.headers && typeof payloadForLog.headers === 'object' ? Object.keys(payloadForLog.headers as Record<string, unknown>).length : 0
    const bodyPresent = 'body' in payload
    const bodyType = typeof (payloadForLog as any).body
    console.log(
      `[remote-import:transport] protocol=${RELAY_PROTOCOL_VERSION} route=worker relayMethod=${relayMethod} upstreamMethod=${upstreamMethod} payloadKeys=${payloadKeys} urlType=${urlType} methodType=${methodType} headersType=${headersType} headersCount=${headersCount} bodyPresent=${bodyPresent} bodyType=${bodyType} targetHost=${targetHost}`,
    )
    console.log(
      `[remote-import:transport] protocol=${RELAY_PROTOCOL_VERSION} payloadKeys=${payloadKeys} contentType=${contentType} targetHost=${targetHost} bodyPresent=${bodyPresent}`,
    )

    const signature = signForRelay(this.opts.secret, relayMethod, RELAY_FETCH_PATH)

    let response: Response
    try {
      response = await fetch(relayUrl, {
        method: relayMethod,
        headers: {
          'content-type': contentType,
          accept: 'application/json',
          [HMAC_HEADER]: signature,
        },
        body: payloadText,
        signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined,
      })
    } catch (error) {
      const cause = (error as Error)?.cause ?? error
      const name = cause instanceof Error ? cause.name : ''
      const msg = cause instanceof Error ? cause.message : String(cause)
      const lower = msg.toLowerCase()
      if (name === 'TimeoutError' || lower.includes('timeout') || lower.includes('aborted')) {
        throw new AppError('WORKER_CONNECTION_TIMEOUT', 'The worker did not respond in time.', 504)
      }
      throw new AppError('WORKER_CONNECTION_REFUSED', 'The worker relay could not be reached.', 502)
    }

    if (response.status === 400) {
      const text = await response.text().catch(() => '')
      let reason = ''
      try {
        const parsed = JSON.parse(text) as { reason?: string; error?: string }
        if (parsed.reason && typeof parsed.reason === 'string') reason = ` reason=${parsed.reason}`
        else if (parsed.error && typeof parsed.error === 'string') reason = ` error=${parsed.error.slice(0, 40)}`
      } catch {
        // non-JSON 400 body — keep generic
      }
      // Safe hint: a relay that rejects a valid 9Drive payload is almost always
      // a STALE deployment — the deployed worker.mjs predates the current relay
      // contract. The exact reason code stays the evidence; this never echoes
      // the URL, headers, body or any credential.
      const staleHint =
        reason.includes('INVALID_PROTOCOL') || reason.includes('MISSING_PROTOCOL') || reason.includes('INVALID_JSON')
          ? ' — the deployed relay does not match 9Drive\'s relay protocol; delete and re-add the worker to redeploy the current relay.'
          : ''
      console.error(
        `[remote-import:transport] protocol=${RELAY_PROTOCOL_VERSION} relay protocol error status=400 targetHost=${targetHost}${reason}`,
      )
      throw new AppError(
        REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_PROTOCOL_ERROR,
        `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_PROTOCOL_ERROR} (relay 400${reason})${staleHint}`,
        400,
      )
    }

    if (response.status === 401 || response.status === 403) {
      throw new AppError('WORKER_AUTH_FAILED', 'The worker rejected the authentication.', 403)
    }

    if (!response.ok) {
      // Relay itself failed (not upstream) — 5xx or other
      const text = await response.text().catch(() => '')
      console.error(`[remote-import:transport] relay unhealthy status=${response.status} targetHost=${targetHost}`)
      throw new AppError('WORKER_UNHEALTHY', `Relay error ${response.status}: ${text.slice(0, 200)}`, 502)
    }

    let data: any
    try {
      data = await response.json()
    } catch {
      throw new AppError('WORKER_PROTOCOL_INVALID', 'The relay returned an invalid response.', 502)
    }

    // Expected shape: {status, headers, body: base64, protocolVersion}
    const status: number = typeof data.status === 'number' ? data.status : 502
    const respHeaders: Record<string, string> = {}
    if (data.headers && typeof data.headers === 'object') {
      for (const [k, v] of Object.entries(data.headers as Record<string, unknown>)) {
        if (typeof v === 'string') respHeaders[k.toLowerCase()] = v
      }
    }
    const bodyBase64: string | null = typeof data.body === 'string' ? data.body : null
    let body: AsyncIterable<Uint8Array> | string
    if (bodyBase64) {
      try {
        const buf = Buffer.from(bodyBase64, 'base64')
        body = (async function* () {
          yield new Uint8Array(buf)
        })()
        // Also provide string variant for callers that need text? We'll keep async iterable
        // For manifest we need string: caller can collect.
      } catch {
        throw new AppError('WORKER_PROTOCOL_INVALID', 'The relay returned an invalid body encoding.', 502)
      }
    } else {
      body = (async function* () {})()
    }

    // Handle upstream HTTP errors as per status mapping: 401/403 already handled as auth, 404 etc will be handled by caller
    // For HLS manifest we need to surface 401/403 as REMOTE_SOURCE_ACCESS_EXPIRED etc — caller will map status.

    return {
      status,
      statusText: data.statusText ?? String(status),
      headers: respHeaders,
      body,
      finalUrl: targetUrl, // relay follows redirects internally, we treat target as final
      redirectCount: 0,
    } as RemoteFetchResponse & { finalUrl?: string; redirectCount?: number }
  }
}
