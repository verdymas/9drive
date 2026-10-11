import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  computeHopHeaders,
  decryptRequestContext,
  encryptRequestContext,
  serializeRequestContext,
  validateRequestContext,
} from './request-context.js'

// SSRF DNS is mocked so loopback test servers are reachable: syntax/policy
// checks still run, only the public-IP gate is bypassed (same pattern as the
// relay transport suite).
vi.mock('./ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ssrf.js')>()
  return {
    ...actual,
    validateRemoteUrl: async (raw: string) => new URL(raw),
    resolveAndValidateHost: async (host: string) => host,
  }
})

/**
 * Browser-equivalence header set modeled on a successful XDM request.
 * Test fixture ONLY — production code never hardcodes these values.
 * The Referer host is generic; no real page URL is used.
 */
const XDM_FIXTURE_WIRE: Record<string, string> = {
  'sec-ch-ua-platform': '"Windows"',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Dest': 'video',
  'Sec-Fetch-Storage-Access': 'active',
  Referer: 'https://site.example/post/1.html?sk=abc&so=0&ss=latest',
  'Accept-Encoding': 'identity',
  'Accept-Language': 'en-US,en;q=0.9',
}

function url(u: string): URL {
  return new URL(u)
}

describe('request context accepts the browser-equivalence allowlist', () => {
  it('validates the XDM fixture (wire casing) into canonical fields', () => {
    const ctx = validateRequestContext(XDM_FIXTURE_WIRE)!
    expect(ctx).toMatchObject({
      secChUaPlatform: '"Windows"',
      userAgent: expect.stringContaining('Chrome/155'),
      secChUa: expect.stringContaining('Google Chrome'),
      secChUaMobile: '?0',
      secFetchSite: 'cross-site',
      secFetchMode: 'no-cors',
      secFetchDest: 'video',
      secFetchStorageAccess: 'active',
      referer: 'https://site.example/post/1.html?sk=abc&so=0&ss=latest',
      acceptEncoding: 'identity',
      acceptLanguage: 'en-US,en;q=0.9',
    })
  })

  it('header-name casing does not affect validation', () => {
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(XDM_FIXTURE_WIRE)) lower[k.toLowerCase()] = v
    const upper: Record<string, string> = {}
    for (const [k, v] of Object.entries(XDM_FIXTURE_WIRE)) upper[k.toUpperCase()] = v
    expect(validateRequestContext(lower)).toEqual(validateRequestContext(XDM_FIXTURE_WIRE))
    expect(validateRequestContext(upper)).toEqual(validateRequestContext(XDM_FIXTURE_WIRE))
    // camelCase canonical keys are accepted too
    expect(validateRequestContext({ userAgent: 'A', secFetchDest: 'video' })).toEqual({
      userAgent: 'A',
      secFetchDest: 'video',
    })
  })

  it('rejects disallowed and transport-controlled headers', () => {
    for (const name of [
      'connection',
      'host',
      'content-length',
      'transfer-encoding',
      'proxy-authorization',
      'te',
      'trailer',
      'upgrade',
      'authorization',
      'range',
      'x-custom-header',
    ]) {
      expect(() => validateRequestContext({ [name]: 'x' })).toThrowError(
        expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
      )
    }
  })

  it('rejects unsupported enum values and oversized values', () => {
    expect(() => validateRequestContext({ secFetchDest: 'rocket' })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
    expect(() => validateRequestContext({ secFetchSite: 'everywhere' })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
    expect(() => validateRequestContext({ secChUaMobile: 'maybe' })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
    expect(() => validateRequestContext({ referer: 'https://x.example/\r\nX-Evil: 1' })).toThrow()
    expect(() => validateRequestContext({ secFetchDest: 'video\r\nX-Evil: 1' })).toThrow()
  })

  it('a captured Range is rejected, never stored', () => {
    expect(() => validateRequestContext({ range: 'bytes=0-0' })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
    expect(() => validateRequestContext({ Range: 'bytes=0-0' })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
  })
})

describe('request context stays encrypted at rest', () => {
  it('round-trips the extended fields with ciphertext hiding values', () => {
    const ctx = validateRequestContext({ ...XDM_FIXTURE_WIRE, cookie: 'session=secret-value' })!
    const encrypted = encryptRequestContext(ctx)
    expect(encrypted).not.toContain('session=secret-value')
    expect(encrypted).not.toContain('site.example/post')
    expect(decryptRequestContext(encrypted)).toEqual(ctx)
  })

  it('summary stays boolean-only with the extended fields', () => {
    const out = serializeRequestContext(validateRequestContext(XDM_FIXTURE_WIRE))
    expect(out.attached).toBe(true)
    expect(out.secFetchDest).toBe(true)
    expect(out.acceptLanguage).toBe(true)
    expect(JSON.stringify(out)).not.toContain('site.example')
  })
})

describe('hop headers: forwarding + cookie scope', () => {
  const source = url('https://video.example.test/watch')
  const ctx = validateRequestContext({ ...XDM_FIXTURE_WIRE, cookie: 'session=secret-value' })!

  it('forwards every permitted header same-origin (cookie included)', () => {
    const headers = computeHopHeaders(source, url('https://video.example.test/seg-1.ts'), ctx)!
    expect(headers['Sec-Fetch-Dest']).toBe('video')
    expect(headers['Sec-Fetch-Site']).toBe('cross-site')
    expect(headers['Sec-Fetch-Mode']).toBe('no-cors')
    expect(headers['Sec-Fetch-Storage-Access']).toBe('active')
    expect(headers['Sec-CH-UA']).toContain('Google Chrome')
    expect(headers['Sec-CH-UA-Mobile']).toBe('?0')
    expect(headers['Sec-CH-UA-Platform']).toBe('"Windows"')
    expect(headers['Accept-Encoding']).toBe('identity')
    expect(headers['Accept-Language']).toBe('en-US,en;q=0.9')
    expect(headers['Referer']).toBe('https://site.example/post/1.html?sk=abc&so=0&ss=latest')
    expect(headers['Cookie']).toBe('session=secret-value')
    expect(headers['Range']).toBeUndefined()
  })

  it('cross-origin redirect drops Cookie but keeps the browser headers', () => {
    const headers = computeHopHeaders(source, url('https://cdn.other.test/seg-1.ts'), ctx)!
    expect(headers['Cookie']).toBeUndefined()
    expect(headers['Sec-Fetch-Dest']).toBe('video')
    expect(headers['User-Agent']).toContain('Chrome/155')
    expect(headers['Referer']).toContain('site.example')
  })
})

describe('direct + relay transports forward the same permitted context', () => {
  let upstream: http.Server
  let upstreamUrl = ''
  let relay: http.Server
  let relayUrl = ''
  const upstreamHits: Array<{ method: string; url: string; headers: Record<string, string> }> = []
  const relayPayloads: Array<{ headers: Record<string, string> }> = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ')
      }
      upstreamHits.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers })
      if (req.url?.startsWith('/missing')) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '11' })
      res.end('hello world')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

    // Minimal mock relay: captures the payload, forwards its headers to the
    // upstream, and answers the v1 JSON envelope (fallback path). Forwarding
    // uses undici `request` (raw headers): the global `fetch` normalizes
    // `Sec-Fetch-Mode: no-cors` to `cors` and strips other browser-forbidden
    // headers, which would mask the payload parity this suite asserts. The
    // deployed relay's own edge runtime is the transport constraint there.
    relay = http.createServer(async (req, res) => {
      const { request: undiciRequest } = await import('undici')
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const payload = JSON.parse(body) as { url: string; method: string; headers: Record<string, string>; body?: string }
      relayPayloads.push({ headers: payload.headers ?? {} })
      const upstreamRes = await undiciRequest(payload.url, {
        method: payload.method as 'GET',
        headers: payload.headers as Record<string, string>,
      })
      const chunks: Buffer[] = []
      for await (const chunk of upstreamRes.body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const buf = Buffer.concat(chunks)
      const respHeaders: Record<string, string> = {}
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (typeof v === 'string') respHeaders[k.toLowerCase()] = v
        else if (Array.isArray(v)) respHeaders[k.toLowerCase()] = v.join(', ')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        status: upstreamRes.statusCode,
        statusText: String(upstreamRes.statusCode),
        headers: respHeaders,
        body: buf.toString('base64'),
        finalUrl: payload.url,
        protocolVersion: '9drive-relay-v1',
      }))
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      new Promise<void>((resolve) => relay.close(() => resolve())),
    ])
  })

  function drain(res: { body: AsyncIterable<Uint8Array> | string }): Promise<string> {
    return (async () => {
      let out = ''
      const body = res.body
      if (typeof body === 'string') return body
      for await (const chunk of body) out += Buffer.from(chunk).toString()
      return out
    })()
  }

  it('direct fetch forwards the permitted headers', async () => {
    const { DirectRemoteFetchTransport } = await import('../remote-fetch-workers/transports/direct-transport.js')
    upstreamHits.length = 0
    const ctx = validateRequestContext(XDM_FIXTURE_WIRE)!
    const transport = new DirectRemoteFetchTransport({ requestContext: ctx, sourceUrl: `${upstreamUrl}/video.mp4` })
    const res = await transport.request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {} })
    expect(res.status).toBe(200)
    await drain(res)
    const hit = upstreamHits[upstreamHits.length - 1]
    expect(hit.headers['sec-fetch-dest']).toBe('video')
    expect(hit.headers['sec-fetch-site']).toBe('cross-site')
    expect(hit.headers['sec-fetch-mode']).toBe('no-cors')
    expect(hit.headers['sec-fetch-storage-access']).toBe('active')
    expect(hit.headers['sec-ch-ua-platform']).toBe('"Windows"')
    expect(hit.headers['sec-ch-ua-mobile']).toBe('?0')
    expect(hit.headers['sec-ch-ua']).toContain('Google Chrome')
    expect(hit.headers['accept-encoding']).toBe('identity')
    expect(hit.headers['accept-language']).toBe('en-US,en;q=0.9')
    expect(hit.headers['referer']).toBe('https://site.example/post/1.html?sk=abc&so=0&ss=latest')
    expect(hit.headers['user-agent']).toContain('Chrome/155')
  })

  it('relay forwards the same permitted headers', async () => {
    const { CloudflareRemoteFetchTransport } = await import('../remote-fetch-workers/transports/cloudflare-transport.js')
    upstreamHits.length = 0
    relayPayloads.length = 0
    const ctx = validateRequestContext(XDM_FIXTURE_WIRE)!
    const transport = new CloudflareRemoteFetchTransport({
      endpointUrl: relayUrl,
      secret: 'test-secret',
      sourceUrl: `${upstreamUrl}/video.mp4`,
      requestContext: ctx,
    })
    const res = await transport.request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {} })
    expect(res.status).toBe(200)
    await drain(res)
    const hit = upstreamHits[upstreamHits.length - 1]
    expect(hit.headers['sec-fetch-dest']).toBe('video')
    expect(hit.headers['sec-fetch-site']).toBe('cross-site')
    expect(hit.headers['sec-fetch-mode']).toBe('no-cors')
    expect(hit.headers['sec-fetch-storage-access']).toBe('active')
    expect(hit.headers['sec-ch-ua-platform']).toBe('"Windows"')
    expect(hit.headers['sec-ch-ua-mobile']).toBe('?0')
    expect(hit.headers['sec-ch-ua']).toContain('Google Chrome')
    expect(hit.headers['accept-encoding']).toBe('identity')
    expect(hit.headers['accept-language']).toBe('en-US,en;q=0.9')
    expect(hit.headers['referer']).toBe('https://site.example/post/1.html?sk=abc&so=0&ss=latest')
    expect(hit.headers['user-agent']).toContain('Chrome/155')
    // The relay payload carried the same context (names only asserted here;
    // values were asserted at the upstream above).
    const names = Object.keys(relayPayloads[relayPayloads.length - 1].headers).map((h) => h.toLowerCase())
    expect(names).toEqual(expect.arrayContaining(['sec-fetch-dest', 'sec-fetch-site', 'referer', 'accept-language']))
  })

  it('generated Range wins over operation headers; operation Accept wins over captured Accept', async () => {
    const { DirectRemoteFetchTransport } = await import('../remote-fetch-workers/transports/direct-transport.js')
    upstreamHits.length = 0
    const ctx = validateRequestContext({ ...XDM_FIXTURE_WIRE, accept: 'text/html' })!
    const transport = new DirectRemoteFetchTransport({ requestContext: ctx, sourceUrl: `${upstreamUrl}/video.mp4` })
    const res = await transport.request({
      method: 'GET',
      url: `${upstreamUrl}/video.mp4`,
      headers: { Range: 'bytes=5-10', Accept: 'application/vnd.apple.mpegurl' },
      range: 'bytes=0-0',
    })
    expect(res.status).toBe(200)
    await drain(res)
    const hit = upstreamHits[upstreamHits.length - 1]
    expect(hit.headers['range']).toBe('bytes=0-0')
    expect(hit.headers['accept']).toBe('application/vnd.apple.mpegurl')
  })

  it('a source 404 stays an explicit non-2xx on both routes', async () => {
    const { DirectRemoteFetchTransport } = await import('../remote-fetch-workers/transports/direct-transport.js')
    const { CloudflareRemoteFetchTransport } = await import('../remote-fetch-workers/transports/cloudflare-transport.js')
    const ctx = validateRequestContext(XDM_FIXTURE_WIRE)!
    const direct = new DirectRemoteFetchTransport({ requestContext: ctx, sourceUrl: `${upstreamUrl}/missing.mp4` })
    const directRes = await direct.request({ method: 'GET', url: `${upstreamUrl}/missing.mp4`, headers: {} })
    expect(directRes.status).toBe(404)
    await drain(directRes)
    const relayTransport = new CloudflareRemoteFetchTransport({
      endpointUrl: relayUrl,
      secret: 'test-secret',
      sourceUrl: `${upstreamUrl}/missing.mp4`,
      requestContext: ctx,
    })
    const relayRes = await relayTransport.request({ method: 'GET', url: `${upstreamUrl}/missing.mp4`, headers: {} })
    expect(relayRes.status).toBe(404)
    await drain(relayRes)
  })

  it('imports without extra context still work on both routes with defaults', async () => {
    const { DirectRemoteFetchTransport } = await import('../remote-fetch-workers/transports/direct-transport.js')
    const { CloudflareRemoteFetchTransport } = await import('../remote-fetch-workers/transports/cloudflare-transport.js')
    upstreamHits.length = 0
    const direct = new DirectRemoteFetchTransport()
    const directRes = await direct.request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {} })
    expect(directRes.status).toBe(200)
    await drain(directRes)
    expect(upstreamHits[upstreamHits.length - 1].headers['user-agent']).toBe('9Drive-RemoteImport/1.0')
    expect(upstreamHits[upstreamHits.length - 1].headers['sec-fetch-dest']).toBeUndefined()
    const relayTransport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: 'test-secret' })
    const relayRes = await relayTransport.request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {} })
    expect(relayRes.status).toBe(200)
    await drain(relayRes)
  })

  it('safe diagnostics log header names only — never values', async () => {
    const { DirectRemoteFetchTransport } = await import('../remote-fetch-workers/transports/direct-transport.js')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const ctx = validateRequestContext({ ...XDM_FIXTURE_WIRE, cookie: 'session=secret-value' })!
      const transport = new DirectRemoteFetchTransport({ requestContext: ctx, sourceUrl: `${upstreamUrl}/video.mp4` })
      const res = await transport.request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {} })
      await drain(res)
      const lines = spy.mock.calls.map((c) => String(c[0]))
      const diag = lines.find((l) => l.includes('forwardedHeaderNames='))
      expect(diag).toBeTruthy()
      expect(diag).toContain('sec-fetch-dest')
      expect(diag).not.toContain('session=secret-value')
      expect(diag).not.toContain('sk=abc')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('deployed relay allowlist', () => {
  it('worker.mjs forwards allowlisted headers and strips the rest', async () => {
    const { loadRelaySource } = await import('../remote-fetch-workers/drivers/cloudflare-relay.js')
    const crypto = await import('node:crypto')
    const source = loadRelaySource()
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
    const worker = mod.default as { fetch: (request: Request, env: { RELAY_SECRET: string }) => Promise<Response> }

    const upstreamHits: Array<{ headers: http.IncomingHttpHeaders }> = []
    const upstream = http.createServer((req, res) => {
      upstreamHits.push({ headers: req.headers })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/file.mp4`
    try {
      const secret = 'allowlist-test-secret'
      const sig = crypto.createHmac('sha256', secret).update('POST /fetch', 'utf8').digest('hex')
      const payload = {
        protocolVersion: '9drive-relay-v1',
        url: target,
        method: 'GET',
        headers: {
          ...XDM_FIXTURE_WIRE,
          Range: 'bytes=0-0',
          Connection: 'close',
          Host: 'evil.example',
          Authorization: 'Bearer secret',
          'X-Custom': 'evil',
        },
      }
      const res = await worker.fetch(
        new Request('https://relay.test/fetch', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-9drive-signature': sig },
          body: JSON.stringify(payload),
        }),
        { RELAY_SECRET: secret },
      )
      expect(res.status).toBe(200)
      await res.text().catch(() => undefined)
      const got = upstreamHits[upstreamHits.length - 1].headers
      expect(got['sec-fetch-dest']).toBe('video')
      expect(got['sec-ch-ua-platform']).toBe('"Windows"')
      expect(got['accept-language']).toBe('en-US,en;q=0.9')
      expect(got['range']).toBe('bytes=0-0')
      expect(got['authorization']).toBeUndefined()
      expect(got['x-custom']).toBeUndefined()
      // Hop-by-hop values never forwarded: the client stack supplies its own.
      expect(got['connection']).not.toBe('close')
      expect(got['host']).not.toContain('evil')
      // Sec-Fetch-Mode is forwarded by the relay, but the test runtime's
      // fetch normalizes `no-cors` to `cors` — the edge runtime governs the
      // final value (transport constraint, see suite comment above).
      expect(got['sec-fetch-mode']).toBeDefined()
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})
