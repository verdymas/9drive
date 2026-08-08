import { Agent, request } from 'undici'
import dns from 'node:dns'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { resolveAndValidateHost, urlHasCredentials, validateRemoteUrl } from './ssrf.js'

/**
 * SSRF-safe downloader for Remote Import.
 *
 * For every request (including every redirect hop) we:
 *  - validate the scheme and reject embedded credentials,
 *  - resolve + validate the hostname to a *public* address (ipaddr-based
 *    blocklist rejects loopback/private/link-local/metadata/CGNAT, IPv4-mapped
 *    IPv6 included),
 *  - connect to that validated address via a custom undici `lookup`, which
 *    defeats DNS rebinding (the socket targets the address we already checked,
 *    never a re-resolved hostname),
 *  - keep the Host header and TLS server name equal to the URL's host (we
 *    never rewrite them to the IP),
 *  - forward no credentials across hops by default (no auth / cookie /
 *    original-query leakage). The ONLY exception is the Remote Import request
 *    context (referer/origin/user-agent/cookie) the user explicitly supplied:
 *    `getHopHeaders` recomputes the allowlisted headers for EACH hop and the
 *    cookie is dropped the moment the host changes (see request-context.ts),
 *  - cap redirects, enforce max bytes and idle timeout during streaming.
 *
 * Redirects are walked manually (not via undici's built-in follow) so every
 * hop is validated before its socket is opened.
 */

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

/**
 * Validate + resolve every hop from `startUrl` up to the redirect limit.
 * Returns the final URL and a dispatcher pinned to that hop's validated
 * address (undici keeps Host/SNI from the original hostname automatically).
 */
export async function prepareHop(startUrl: string): Promise<{ url: URL; dispatcher: Agent }> {
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
 * Perform an HTTP request that follows redirects with per-hop SSRF
 * re-validation. `startUrl` is validated synchronously; each `Location` is
 * re-validated. On the final hop the `onResponse` callback receives the
 * readable body (already validated), its metadata, and the final URL.
 * Returns the result of `onResponse`, the final URL, and the redirect count.
 * `dispatcher` is closed after the terminal response (probe/drain-download).
 *
 * `method` defaults to GET; a different method (e.g. HEAD) is applied to every
 * hop. HEAD responses have no body — the `body` callback argument is still an
 * empty readable.
 */
export async function followRemoteUrl<T>(
  startUrl: string,
  options: {
    method?: 'GET' | 'HEAD'
    headers?: Record<string, string>
    /**
     * Per-hop header resolver for the Remote Import request context. Called
     * with the CURRENT hop URL AFTER SSRF validation, so sensitive headers are
     * recomputed for every redirect (spec §14) and cookie scope is enforced
     * against the current target. Absent → the default no-credential behavior.
     */
    getHopHeaders?: (hopUrl: URL) => Record<string, string> | undefined
    onResponse: (
      res: { statusCode: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> },
      finalUrl: string,
    ) => Promise<T>
  },
): Promise<{ result: T; finalUrl: string; redirectCount: number }> {
  const { onResponse } = options
  const method = options.method ?? 'GET'
  const requestHeaders = options.headers
  const getHopHeaders = options.getHopHeaders
  let currentUrl = startUrl
  let redirectCount = 0

  for (let redirects = 0; redirects < MAX_REDIRECTS() + 1; redirects += 1) {
    const { url, dispatcher } = await prepareHop(currentUrl)
    const headers: Record<string, string> = {
      Accept: '*/*',
      'User-Agent': '9Drive-RemoteImport/1.0',
    }
    if (requestHeaders) Object.assign(headers, requestHeaders)
    // Request-context headers (explicitly authorized by the user) are merged
    // per hop — the cookie is dropped automatically when the host differs.
    if (getHopHeaders) {
      const hopHeaders = getHopHeaders(url)
      if (hopHeaders) Object.assign(headers, hopHeaders)
    }
    const res = await request(url.href, {
      method,
      headers,
      dispatcher,
      headersTimeout: CONNECT_TIMEOUT_MS(),
      // undici's body timeout refreshes on each chunk — it is an *idle*
      // timeout, which is exactly what we want while streaming the body.
      bodyTimeout: env.REMOTE_IMPORT_IDLE_TIMEOUT_SECONDS * 1000,
    })

    const status = res.statusCode
    const location = res.headers.location
    if (status >= 300 && status < 400 && location && typeof location === 'string') {
      // Drain + close the redirect response before following. `.body` is the
      // undici BodyReadable (a node stream) — resume() + destroy() ensures the
      // socket is freed before we open the next hop. The abort is intentional,
      // so silence the unhandled 'error' the body would otherwise emit.
      res.body.on('error', () => undefined)
      res.body.resume()
      res.body.destroy()
      dispatcher.close().catch(() => undefined)
      const next = new URL(location, url).href
      // Advance to the next hop — the next loop iteration re-validates the new
      // host (scheme, creds, IP) before its socket opens.
      currentUrl = next
      redirectCount += 1
      continue
    }

    // IncomingHttpHeaders values can be `string | string[] | undefined`.
    const headerMap: Record<string, string> = {}
    for (const [key, value] of Object.entries(res.headers)) {
      if (typeof value === 'string') headerMap[key.toLowerCase()] = value
      else if (Array.isArray(value)) headerMap[key.toLowerCase()] = value.join(', ')
    }
    try {
      const result = await onResponse(
        {
          statusCode: status,
          headers: headerMap,
          body: res.body,
        },
        url.href,
      )
      return { result, finalUrl: url.href, redirectCount }
    } finally {
      dispatcher.close().catch(() => undefined)
    }
  }
  throw new AppError('TOO_MANY_REDIRECTS', 'The URL redirected too many times.', 400)
}

export { resolveAndValidateHost, urlHasCredentials, validateRemoteUrl }