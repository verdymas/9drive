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

/** Upstream/relay statuses treated as TRANSIENT for idempotent GET/HEAD. */
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504])
/** Total attempts for a retryable request (1 initial + 2 retries). */
const MAX_RELAY_ATTEMPTS = 3
/** Bounded exponential backoff: base 200ms, doubling, jittered, capped. */
const RELAY_BACKOFF_BASE_MS = 200
const RELAY_BACKOFF_MAX_MS = 2000

function relayBackoffDelay(attempt: number): number {
  const exponential = RELAY_BACKOFF_BASE_MS * 2 ** (attempt - 1)
  const jittered = exponential * (0.5 + Math.random())
  return Math.min(Math.max(jittered, RELAY_BACKOFF_BASE_MS), RELAY_BACKOFF_MAX_MS)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** True when the relay returned the structured upstream-failure envelope.
 *  The relay is healthy but its fetch of the SOURCE failed. */
function isUpstreamFailureEnvelope(status: number, bodyText: string): boolean {
  if (status !== 502) return false
  return /"error"\s*:\s*"upstream fetch failed"|UPSTREAM_FETCH_EXCEPTION/.test(bodyText)
}

function signForRelay(secret: string, method: string, path: string): string {
  const canonical = `${method} ${path}`
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
}

/**
 * Cloudflare relay transport: forwards the request through the 9Drive Worker relay.
 * The relay is POST /fetch with HMAC; it returns {status, headers, body:base64}.
 * All bytes go via the relay — 9Drive never contacts the source directly.
 *
 * Error classification:
 *  - relay 400                      → WORKER_RELAY_PROTOCOL_ERROR (fatal)
 *  - relay 401/403                  → WORKER_AUTH_FAILED (fatal)
 *  - relay 502 + upstream envelope  → WORKER_UPSTREAM_FETCH_FAILED (transient:
 *                                     the relay is healthy, the SOURCE failed)
 *  - relay !ok otherwise            → WORKER_UNHEALTHY (the relay itself is the
 *                                     problem: unhealthy/timeout/4xx)
 *  - relay network error            → WORKER_CONNECTION_TIMEOUT | WORKER_UNHEALTHY
 *
 * Transient retry: idempotent GET/HEAD retry on 502/503/504 and network
 * exceptions with bounded exponential backoff + jitter. The serialized payload
 * (URL, method, Range, request-context headers) is built ONCE — every retry
 * preserves the exact same workerId / URL / Range / request context. Never
 * retries 400/401/403/404 and never falls back to a direct connection.
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
    // URL syntax/policy validation before relaying (scheme, credentials,
    // literal-IP blocklist). The relay edge — Cloudflare Workers fetch — is
    // the DNS/IP enforcement point for the relayed hostname, so the backend
    // must NOT resolve the target here (strict-firewall hosts may be
    // unresolvable from the backend even though the relay can reach them).
    await validateRemoteUrl(targetUrl, { resolveDns: false })

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
    // Header parity with the Direct transport: baseline defaults, then the
    // caller's headers, then Range, then the request-context for the initial
    // hop. The same header set is reused verbatim on every retry.
    const reqHeaders: Record<string, string> = {
      Accept: '*/*',
      'User-Agent': '9Drive-RemoteImport/1.0',
      ...(input.headers ?? {}),
    }
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
    // Safe payload-shape diagnostics — header NAMES/types only, never values.
    const payloadKeys = Object.keys(payload).sort().join(',')
    const payloadForLog = payload as any
    const urlType = typeof payloadForLog.url
    const methodType = typeof payloadForLog.method
    const headersType = typeof payloadForLog.headers
    const headersCount = payloadForLog.headers && typeof payloadForLog.headers === 'object' ? Object.keys(payloadForLog.headers as Record<string, unknown>).length : 0
    const headerNames = Object.keys(reqHeaders).map((h) => h.toLowerCase()).sort().join(',')
    const hasRange = headerNames.includes('range')
    const hasReferer = headerNames.includes('referer')
    const hasOrigin = headerNames.includes('origin')
    const hasCookie = headerNames.includes('cookie')
    const bodyPresent = 'body' in payload
    const bodyType = typeof (payloadForLog as any).body
    console.log(
      `[remote-import:transport] protocol=${RELAY_PROTOCOL_VERSION} route=worker relayMethod=${relayMethod} upstreamMethod=${upstreamMethod} payloadKeys=${payloadKeys} urlType=${urlType} methodType=${methodType} headersType=${headersType} headersCount=${headersCount} headerNames=${headerNames} hasRange=${hasRange} hasReferer=${hasReferer} hasOrigin=${hasOrigin} hasCookie=${hasCookie} bodyPresent=${bodyPresent} bodyType=${bodyType} targetHost=${targetHost}`,
    )
    console.log(
      `[remote-import:transport] protocol=${RELAY_PROTOCOL_VERSION} payloadKeys=${payloadKeys} contentType=${contentType} targetHost=${targetHost} bodyPresent=${bodyPresent}`,
    )

    const signature = signForRelay(this.opts.secret, relayMethod, RELAY_FETCH_PATH)
    const retryable = method === 'GET' || method === 'HEAD'
    const relayId = `workerId=${this.opts.workerId ?? 'unknown'} driver=${this.opts.driver ?? 'cloudflare'} relayHost=${relayHost} targetHost=${targetHost} upstreamMethod=${method}`

    let attempt = 0
    for (;;) {
      attempt += 1
      const outcome = await this.relayAttempt({
        relayUrl,
        payloadText,
        signature,
        targetUrl,
        relayId,
        attempt,
        timeoutMs: input.timeoutMs,
      })

      if (outcome.kind === 'ok') {
        // Upstream server responded with a transient 5xx THROUGH the relay —
        // retry the whole idempotent request; after exhaustion return the last
        // response so the caller maps its status.
        if (retryable && attempt < MAX_RELAY_ATTEMPTS && RETRYABLE_UPSTREAM_STATUSES.has(outcome.status)) {
          console.error(`[remote-import:transport] retryable upstream status=${outcome.status} attempt=${attempt} ${relayId}`)
          await sleep(relayBackoffDelay(attempt))
          continue
        }
        return {
          status: outcome.status,
          statusText: outcome.statusText,
          headers: outcome.headers,
          body: outcome.body,
          finalUrl: outcome.finalUrl,
          redirectCount: 0,
        } as RemoteFetchResponse & { finalUrl?: string; redirectCount?: number }
      }

      // Error outcome (code/status/transient already classified).
      if (retryable && outcome.transient && attempt < MAX_RELAY_ATTEMPTS) {
        console.error(`[remote-import:transport] retryable ${outcome.code} status=${outcome.status} attempt=${attempt} ${relayId}`)
        await sleep(relayBackoffDelay(attempt))
        continue
      }
      throw new AppError(outcome.code, outcome.message, outcome.status)
    }
  }

  /** ONE relay POST + classification. Never falls back to a direct fetch. */
  private async relayAttempt(opts: {
    relayUrl: string
    payloadText: string
    signature: string
    targetUrl: string
    relayId: string
    attempt: number
    timeoutMs?: number
  }): Promise<
    | { kind: 'ok'; status: number; statusText: string; headers: Record<string, string>; body: AsyncIterable<Uint8Array> | string; finalUrl: string }
    | { kind: 'error'; code: string; message: string; status: number; transient: boolean }
  > {
    const { relayUrl, payloadText, signature, targetUrl, relayId, attempt, timeoutMs } = opts

    let response: Response
    try {
      response = await fetch(relayUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [HMAC_HEADER]: signature,
        },
        body: payloadText,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      })
    } catch (error) {
      const cause = (error as Error)?.cause ?? error
      const name = cause instanceof Error ? cause.name : ''
      const msg = cause instanceof Error ? cause.message : String(cause)
      const lower = msg.toLowerCase()
      if (name === 'TimeoutError' || lower.includes('timeout') || lower.includes('aborted')) {
        return {
          kind: 'error',
          code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CONNECTION_TIMEOUT,
          message: REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CONNECTION_TIMEOUT,
          status: 504,
          transient: true,
        }
      }
      // The RELAY itself is unreachable — a relay problem, never an upstream one.
      console.error(`[remote-import:transport] relay unreachable attempt=${attempt} ${relayId}`)
      return {
        kind: 'error',
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY,
        message: 'The worker relay could not be reached.',
        status: 502,
        transient: true,
      }
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
        `[remote-import:transport] protocol=${RELAY_PROTOCOL_VERSION} relay protocol error status=400 attempt=${attempt} ${relayId}${reason}`,
      )
      return {
        kind: 'error',
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_PROTOCOL_ERROR,
        message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_RELAY_PROTOCOL_ERROR} (relay 400${reason})${staleHint}`,
        status: 400,
        transient: false,
      }
    }

    if (response.status === 401 || response.status === 403) {
      return {
        kind: 'error',
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED,
        message: REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_AUTH_FAILED,
        status: 403,
        transient: false,
      }
    }

    const bodyText = await response.text().catch(() => '')

    // Upstream fetch failed at the relay (the relay itself is healthy).
    if (isUpstreamFailureEnvelope(response.status, bodyText)) {
      // The relay's structured reason/cause are static error NAMES/codes
      // (TypeError, ENOTFOUND, ...) — safe diagnostics, never request data.
      let detail = ''
      try {
        const parsed = JSON.parse(bodyText) as { reason?: string; cause?: string }
        const parts = [parsed.reason, parsed.cause].filter(Boolean)
        if (parts.length > 0) detail = ` (${parts.join(' / ')})`
      } catch { /* keep generic */ }
      console.error(`[remote-import:transport] relay upstream fetch failed status=502 attempt=${attempt} ${relayId}${detail}`)
      return {
        kind: 'error',
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UPSTREAM_FETCH_FAILED,
        message: `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_UPSTREAM_FETCH_FAILED}${detail}`,
        status: 502,
        transient: true,
      }
    }

    if (!response.ok) {
      // The RELAY is unhealthy (500/503/504... or an unclassified 5xx). Safe
      // message only — never echo the relay body.
      console.error(`[remote-import:transport] relay unhealthy status=${response.status} attempt=${attempt} ${relayId}`)
      return {
        kind: 'error',
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY,
        message: `Relay error ${response.status}: the relay did not respond as healthy.`,
        status: 502,
        transient: RETRYABLE_UPSTREAM_STATUSES.has(response.status),
      }
    }

    // Relay 2xx: decode the upstream response envelope {status, headers, body}.
    let data: any
    try {
      data = JSON.parse(bodyText)
    } catch {
      return {
        kind: 'error',
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID,
        message: REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID,
        status: 502,
        transient: false,
      }
    }

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
      } catch {
        return {
          kind: 'error',
          code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROTOCOL_INVALID,
          message: REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROTOCOL_INVALID,
          status: 502,
          transient: false,
        }
      }
    } else {
      body = (async function* () {})()
    }

    // The relay follows redirects internally and reports the final URL;
    // older deployments without `finalUrl` fall back to the requested URL.
    return {
      kind: 'ok',
      status,
      statusText: data.statusText ?? String(status),
      headers: respHeaders,
      body,
      finalUrl: typeof data.finalUrl === 'string' && data.finalUrl ? data.finalUrl : targetUrl,
    }
  }
}