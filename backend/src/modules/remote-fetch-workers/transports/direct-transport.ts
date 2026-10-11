import { Agent, request } from 'undici'
import dns from 'node:dns'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { resolveAndValidateHost, validateRemoteUrl } from '../../remote-imports/ssrf.js'
import { hopHeaderResolver, type RemoteImportRequestContext } from '../../remote-imports/request-context.js'
import type { RemoteFetchRequest, RemoteFetchResponse, RemoteFetchTransport } from '../types.js'

function pinnedLookup(validatedIp: string) {
  return (
    _hostname: string,
    _opts: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ) => {
    const family = validatedIp.includes(':') ? 6 : 4
    callback(null, [{ address: validatedIp, family }], family)
  }
}

const MAX_REDIRECTS = () => env.REMOTE_IMPORT_MAX_REDIRECTS
const CONNECT_TIMEOUT_MS = () => env.REMOTE_IMPORT_CONNECT_TIMEOUT_SECONDS * 1000

async function prepareHop(startUrl: string) {
  const url = await validateRemoteUrl(startUrl)
  const validatedIp = await resolveAndValidateHost(url.hostname)
  const dispatcher = new Agent({
    connect: {
      lookup: pinnedLookup(validatedIp),
      timeout: CONNECT_TIMEOUT_MS(),
    },
  })
  return { url, dispatcher }
}

/**
 * Direct (no-relay) transport: SSRF-safe, per-hop validated, redirect-following.
 * Used when workerId == null or as fallback.
 */
export class DirectRemoteFetchTransport implements RemoteFetchTransport {
  constructor(
    private opts: {
      requestContext?: RemoteImportRequestContext | null
      sourceUrl?: string // anchor for cookie scope
    } = {},
  ) {}

  async request(input: RemoteFetchRequest): Promise<RemoteFetchResponse> {
    const method = input.method ?? 'GET'
    const headersInput = input.headers ?? {}
    const range = input.range
    const body = input.body
    const requestContext = ((input as any).requestContext as RemoteImportRequestContext | undefined) ?? this.opts.requestContext ?? null
    const sourceUrl = this.opts.sourceUrl ?? input.url

    let currentUrl = input.url
    let redirectCount = 0

    // Merge Range header if provided
    const baseHeaders: Record<string, string> = { ...headersInput }
    if (range) baseHeaders['Range'] = range

    for (let redirects = 0; redirects < MAX_REDIRECTS() + 1; redirects += 1) {
      const { url, dispatcher } = await prepareHop(currentUrl)
      // Merge order: defaults → captured context → explicit operation headers
      // → generated Range. Captured values fill gaps but never override the
      // operation's explicit headers, and a captured Range can never override
      // the generated probe/download Range (computeHopHeaders never emits it;
      // the generated value is applied last defensively).
      let hopHeaders: Record<string, string> | undefined
      if (requestContext) {
        // Per-hop header resolver ensures cookie scope is re-checked each hop
        hopHeaders = hopHeaderResolver(sourceUrl, requestContext)?.(url)
        if (hopHeaders) {
          for (const name of Object.keys(hopHeaders)) {
            if (name.toLowerCase() === 'range') delete hopHeaders[name]
          }
        }
      }
      const headers: Record<string, string> = {
        Accept: '*/*',
        'User-Agent': '9Drive-RemoteImport/1.0',
        ...(hopHeaders ?? {}),
        ...baseHeaders,
      }
      if (range) headers['Range'] = range

      // Log safe diagnostics — header NAMES only, never values.
      // traceId is logged when the caller threads one (probe correlationId);
      // direct has no relay hop, so relayHttpStatus/upstreamStatus are the same
      // source answer logged by the fetcher response line.
      try {
        const targetHost = url.hostname
        const forwardedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort().join(',')
        const traceId = typeof (input as RemoteFetchRequest).traceId === 'string' ? (input as RemoteFetchRequest).traceId : 'none'
        const pathLen = url.pathname.length
        const queryKeys = [...url.searchParams.keys()].sort().join('+') || 'none'
        console.log(`[remote-import:transport] route=direct traceId=${traceId} targetHost=${targetHost} method=${method} redirectCount=${redirectCount} forwardedHeaderNames=${forwardedHeaderNames} pathLen=${pathLen} queryKeys=${queryKeys}`)
      } catch {}

      const res = await request(url.href, {
        method,
        headers,
        dispatcher,
        headersTimeout: CONNECT_TIMEOUT_MS(),
        bodyTimeout: env.REMOTE_IMPORT_IDLE_TIMEOUT_SECONDS * 1000,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      })

      const status = res.statusCode
      const location = res.headers.location

      if (status >= 300 && status < 400 && location && typeof location === 'string') {
        res.body.on('error', () => undefined)
        res.body.resume()
        res.body.destroy()
        dispatcher.close().catch(() => undefined)
        const next = new URL(location, url).href
        currentUrl = next
        redirectCount += 1
        continue
      }

      const headerMap: Record<string, string> = {}
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === 'string') headerMap[key.toLowerCase()] = value
        else if (Array.isArray(value)) headerMap[key.toLowerCase()] = value.join(', ')
      }

      // Wrap body so dispatcher is closed when consumption ends
      const bodyIterable: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: async function* () {
          try {
            for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
              yield chunk as Uint8Array
            }
          } finally {
            dispatcher.close().catch(() => undefined)
          }
        },
      }

      // For HEAD, body is empty but still need to close dispatcher
      if (method === 'HEAD') {
        // Drain quickly and close
        res.body.on('error', () => undefined)
        res.body.resume()
        res.body.destroy()
        dispatcher.close().catch(() => undefined)
        return {
          status,
          statusText: String(status),
          headers: headerMap,
          body: (async function* () {})(),
          finalUrl: url.href,
          redirectCount,
        } as RemoteFetchResponse & { finalUrl?: string; redirectCount?: number }
      }

      return {
        status,
        statusText: String(status),
        headers: headerMap,
        body: bodyIterable,
        finalUrl: url.href,
        redirectCount,
      } as RemoteFetchResponse & { finalUrl?: string; redirectCount?: number }
    }

    throw new AppError('TOO_MANY_REDIRECTS', 'The URL redirected too many times.', 400)
  }
}
