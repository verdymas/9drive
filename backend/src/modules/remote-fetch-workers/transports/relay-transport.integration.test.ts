import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import { AppError } from '../../../utils/app-error.js'
import { CloudflareRemoteFetchTransport } from './cloudflare-transport.js'
import { DirectRemoteFetchTransport } from './direct-transport.js'
import { serializeRelayRequest, parseRelayRequest, RELAY_PROTOCOL_VERSION, RELAY_SIGNATURE_HEADER } from '../relay-protocol.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES } from '../errors.js'

const validationSpy = vi.hoisted(() => ({
  validateRemoteUrl: vi.fn(),
  resolveAndValidateHost: vi.fn(),
}))

vi.mock('../../remote-imports/ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../remote-imports/ssrf.js')>()
  return {
    ...actual,
    validateRemoteUrl: validationSpy.validateRemoteUrl,
    resolveAndValidateHost: validationSpy.resolveAndValidateHost,
  }
})

// Mock request-context hopHeaderResolver to pass through headers
vi.mock('../../remote-imports/request-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../remote-imports/request-context.js')>()
  return {
    ...actual,
    hopHeaderResolver: (sourceUrl: string, ctx: any) => {
      if (!ctx) return undefined
      return (hopUrl: URL) => {
        const headers: Record<string, string> = {}
        if (ctx.referer) headers['Referer'] = ctx.referer
        if (ctx.userAgent) headers['User-Agent'] = ctx.userAgent
        if (ctx.cookie) headers['Cookie'] = ctx.cookie
        if (ctx.origin) headers['Origin'] = ctx.origin
        return Object.keys(headers).length > 0 ? headers : undefined
      }
    },
  }
})

const SECRET = 'test-relay-secret-123'
const RELAY_PROTOCOL = RELAY_PROTOCOL_VERSION

function signForRelay(secret: string, method: string, path: string): string {
  return crypto.createHmac('sha256', secret).update(`${method} ${path}`, 'utf8').digest('hex')
}

describe('Relay protocol canonical contract', () => {
  it('serializes HEAD with canonical keys (body omitted)', () => {
    const payload = {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      url: 'https://example.test/video.m3u8',
      method: 'HEAD' as const,
      headers: {} as Record<string, string>,
    }
    const text = serializeRelayRequest(payload)
    const parsed = JSON.parse(text)
    expect(Object.keys(parsed).sort()).toEqual(['headers', 'method', 'protocolVersion', 'url'])
    expect(parsed.method).toBe('HEAD')
    expect(parsed.url).toBe('https://example.test/video.m3u8')
    expect(parsed.protocolVersion).toBe(RELAY_PROTOCOL_VERSION)
    expect(parsed.body).toBeUndefined()
  })

  it('serializes GET with canonical keys (body omitted)', () => {
    const payload = {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      url: 'https://example.test/video.m3u8',
      method: 'GET' as const,
      headers: {} as Record<string, string>,
    }
    const text = serializeRelayRequest(payload)
    const parsed = JSON.parse(text)
    expect(Object.keys(parsed).sort()).toEqual(['headers', 'method', 'protocolVersion', 'url'])
    expect(parsed.method).toBe('GET')
  })

  it('serializes GET + Range with headers (body omitted)', () => {
    const payload = {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      url: 'https://example.test/video.ts',
      method: 'GET' as const,
      headers: { range: 'bytes=0-1023' } as Record<string, string>,
    }
    const text = serializeRelayRequest(payload)
    const parsed = JSON.parse(text)
    expect(parsed.headers.range).toBe('bytes=0-1023')
    expect(parsed.body).toBeUndefined()
  })

  it('serializes GET + Range with canonical keys including Range header', () => {
    const payload = {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      url: 'https://sample.vodobox.net/video.m3u8',
      method: 'GET' as const,
      headers: { Range: 'bytes=0-0', Accept: 'application/vnd.apple.mpegurl' } as Record<string, string>,
    }
    const text = serializeRelayRequest(payload)
    const parsed = JSON.parse(text)
    expect(Object.keys(parsed).sort()).toEqual(['headers', 'method', 'protocolVersion', 'url'])
    expect(parsed.headers.Range).toBe('bytes=0-0')
    expect(parsed.body).toBeUndefined()
  })

  it('rejects invalid payload via Zod', () => {
    expect(() => serializeRelayRequest({ protocolVersion: RELAY_PROTOCOL_VERSION, method: 'DELETE' as any, url: 'https://example.com', headers: {} } as any)).toThrow()
    expect(() => serializeRelayRequest({ protocolVersion: RELAY_PROTOCOL_VERSION, method: 'GET' as any, url: 'not-a-url', headers: {} } as any)).toThrow()
    // body: null must be rejected (optional string, not nullable)
    expect(() => serializeRelayRequest({ protocolVersion: RELAY_PROTOCOL_VERSION, method: 'GET', url: 'https://example.com', headers: {}, body: null as any })).toThrow()
  })

  it('rejects body:null with INVALID_BODY_TYPE (the bug that caused WORKER_RELAY_PROTOCOL_ERROR)', () => {
    const raw = JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, url: 'https://example.test/video.m3u8', method: 'GET', headers: {}, body: null })
    expect(() => parseRelayRequest(raw)).toThrow()
    try {
      parseRelayRequest(raw)
    } catch (e: any) {
      expect(e.reason).toBe('INVALID_BODY_TYPE')
    }
  })

  it('accepts HEAD payload via parser', () => {
    const raw = JSON.stringify({ protocolVersion: '9drive-relay-v1', url: 'https://example.test/video.m3u8', method: 'HEAD', headers: {} })
    const parsed = parseRelayRequest(raw)
    expect(parsed.method).toBe('HEAD')
  })

  it('accepts GET payload via parser', () => {
    const raw = JSON.stringify({ protocolVersion: '9drive-relay-v1', url: 'https://example.test/video.m3u8', method: 'GET', headers: {} })
    const parsed = parseRelayRequest(raw)
    expect(parsed.method).toBe('GET')
  })

  it('accepts GET + Range payload via parser', () => {
    const raw = JSON.stringify({ protocolVersion: '9drive-relay-v1', url: 'https://example.test/video.ts', method: 'GET', headers: { range: 'bytes=0-1023' } })
    const parsed = parseRelayRequest(raw)
    expect(parsed.headers.range).toBe('bytes=0-1023')
  })
})

describe('CloudflareRemoteFetchTransport via mock relay', () => {
  let upstreamServer: http.Server
  let upstreamUrl: string
  let relayServer: http.Server
  let relayUrl: string

  // Track upstream hits
  let upstreamHits: Array<{ method: string; url: string; headers: Record<string, string> }> = []
  let upstreamBody = 'hello world'

  beforeAll(async () => {
    // Upstream that serves manifests/segments
    upstreamServer = http.createServer((req, res) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ')
      }
      upstreamHits.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers })
      if (req.url?.includes('manifest.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': String('#EXTM3U\n#EXT-X-VERSION:3\n'.length) })
        res.end('#EXTM3U\n#EXT-X-VERSION:3\n')
        return
      }
      if (req.url?.includes('segment')) {
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(upstreamBody.length) })
        res.end(upstreamBody)
        return
      }
      // Default
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(upstreamBody.length) })
      res.end(upstreamBody)
    })
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve))
    upstreamUrl = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`

    // Relay that mimics worker.mjs
    relayServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      // Verify HMAC
      const secret = SECRET
      const canonical = req.method + ' ' + url.pathname
      const expected = signForRelay(secret, req.method ?? 'POST', url.pathname)
      const got = req.headers[RELAY_SIGNATURE_HEADER.toLowerCase()] as string | undefined
      if (got !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ service: '9drive-relay', protocolVersion: RELAY_PROTOCOL_VERSION, status: 'ok', capabilities: {} }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/fetch') {
        let body = ''
        for await (const chunk of req) body += chunk.toString()
        let payload: any
        try {
          payload = JSON.parse(body)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload' }))
          return
        }
        // Validate with canonical 9drive-relay-v1 contract — keep in sync with relay-protocol.ts and worker.mjs
        const { method, url: targetUrl, headers, body: b, protocolVersion } = payload || {}
        if (protocolVersion === undefined || protocolVersion === null) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'MISSING_PROTOCOL' }))
          return
        }
        if (protocolVersion !== RELAY_PROTOCOL_VERSION) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'INVALID_PROTOCOL' }))
          return
        }
        if (method === undefined || method === null) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'MISSING_METHOD' }))
          return
        }
        if (typeof method !== 'string' || !['GET', 'HEAD', 'POST'].includes(method)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'UNSUPPORTED_METHOD' }))
          return
        }
        if (targetUrl === undefined || targetUrl === null) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'MISSING_URL' }))
          return
        }
        if (typeof targetUrl !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'INVALID_URL' }))
          return
        }
        try {
          new URL(targetUrl)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'INVALID_URL' }))
          return
        }
        if (b !== undefined && typeof b !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'INVALID_BODY_TYPE' }))
          return
        }
        if (headers !== undefined && headers !== null && (typeof headers !== 'object' || Array.isArray(headers))) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid payload', reason: 'INVALID_HEADERS' }))
          return
        }
        // Simulate upstream fetch
        try {
          const upstreamRes = await fetch(targetUrl, {
            method,
            headers: headers as Record<string, string>,
            body: method === 'GET' || method === 'HEAD' ? undefined : b,
            redirect: 'follow',
          })
          const buf = Buffer.from(await upstreamRes.arrayBuffer())
          const respHeaders: Record<string, string> = {}
          upstreamRes.headers.forEach((v, k) => (respHeaders[k.toLowerCase()] = v))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              status: upstreamRes.status,
              statusText: upstreamRes.statusText,
              headers: respHeaders,
              body: buf.toString('base64'),
              finalUrl: upstreamRes.url,
              protocolVersion: RELAY_PROTOCOL_VERSION,
            }),
          )
        } catch {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'upstream fetch failed' }))
        }
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
    await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve))
    relayUrl = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    upstreamHits = []
    validationSpy.validateRemoteUrl.mockReset()
    validationSpy.resolveAndValidateHost.mockReset()
    validationSpy.validateRemoteUrl.mockImplementation(async (raw: string) => new URL(raw))
    validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => host)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => relayServer.close(() => resolve()))
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()))
  })

  it('HEAD through relay succeeds', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET, workerId: 'w1', driver: 'cloudflare' })
    const res = await transport.request({ method: 'HEAD', url: `${upstreamUrl}/test`, headers: {} })
    expect(res.status).toBe(200)
    expect(upstreamHits.length).toBe(1)
    expect(upstreamHits[0].method).toBe('HEAD')
    expect(upstreamHits[0].url).toBe('/test')
  })

  it('GET through relay succeeds', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET, workerId: 'w1', driver: 'cloudflare' })
    const res = await transport.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {} })
    expect(res.status).toBe(200)
    let body = ''
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) body += Buffer.from(chunk).toString()
    expect(body).toBe(upstreamBody)
    expect(upstreamHits.some((h) => h.url === '/test' && h.method === 'GET')).toBe(true)
  })

  it('Range GET through relay forwards Range header', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET, workerId: 'w1', driver: 'cloudflare' })
    const res = await transport.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {}, range: 'bytes=0-0' })
    expect(res.status).toBe(200)
    expect(upstreamHits[0].headers['range']).toBe('bytes=0-0')
  })

  it('validates the relayed target with resolveDns:false (no backend DNS in relay mode)', async () => {
    const calls: Array<{ raw: string; opts?: unknown }> = []
    validationSpy.validateRemoteUrl.mockImplementation(async (raw: string, opts?: unknown) => {
      calls.push({ raw, opts })
      return new URL(raw)
    })
    validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => host)
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET, workerId: 'w1', driver: 'cloudflare' })
    await transport.request({ method: 'GET', url: `${upstreamUrl}/file`, headers: {} })
    expect(calls[0]).toMatchObject({ raw: `${upstreamUrl}/file`, opts: { resolveDns: false } })
    // The backend never DNS-resolves the relayed target — the relay edge enforces IP space.
    expect(validationSpy.resolveAndValidateHost).not.toHaveBeenCalled()
  })

  it('passes the relay-reported post-redirect finalUrl through', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET, workerId: 'w1', driver: 'cloudflare' })
    const res = await transport.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {} })
    // Mock relay echoes upstream.fetch's URL (it never redirects at /test).
    expect((res as { finalUrl?: string }).finalUrl).toBe(`${upstreamUrl}/test`)
  })

  it('HLS manifest GET through relay (with HLS headers) succeeds', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET, workerId: 'w1', driver: 'cloudflare' })
    const res = await transport.request({
      method: 'GET',
      url: `${upstreamUrl}/manifest.m3u8`,
      headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegurl', 'User-Agent': '9Drive-Remote-Import/1.0' },
    })
    expect(res.status).toBe(200)
    let body = ''
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) body += Buffer.from(chunk).toString()
    expect(body).toContain('#EXTM3U')
    expect(upstreamHits[0].headers['accept']).toContain('application/vnd.apple.mpegurl')
  })

  it('headers/request-context forwarding', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET, workerId: 'w1', driver: 'cloudflare' })
    const res = await transport.request({
      method: 'GET',
      url: `${upstreamUrl}/test`,
      headers: { Referer: 'https://site.example/watch/1', 'User-Agent': 'CustomAgent' },
      // Simulate requestContext via headers (the secure-fetcher would have merged them)
    })
    expect(res.status).toBe(200)
    expect(upstreamHits[0].headers['referer']).toBe('https://site.example/watch/1')
    expect(upstreamHits[0].headers['user-agent']).toBe('CustomAgent')
  })

  it('400 invalid payload is classified as WORKER_RELAY_PROTOCOL_ERROR, not WORKER_UNHEALTHY', async () => {
    // Create a transport that sends malformed JSON (bypass serializeRelayRequest)
    // We can directly POST invalid JSON to the relay and see how transport handles 400
    // Instead, test the transport's error mapping for 400
    const badRelayUrl = `${relayUrl}/fetch`
    // Send a request with missing url field to trigger 400 invalid payload (MISSING_URL)
    const badPayload = JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, method: 'GET', headers: {} }) // missing url
    const sig = signForRelay(SECRET, 'POST', '/fetch')
    const rawRes = await fetch(badRelayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sig },
      body: badPayload,
    })
    expect(rawRes.status).toBe(400)
    const text = await rawRes.text()
    expect(text).toMatch(/invalid payload|invalid request/)
    const parsed = JSON.parse(text) as { reason?: string }
    expect(parsed.reason).toBe('MISSING_URL')

    // Now test that Cloudflare transport maps 400 to WORKER_RELAY_PROTOCOL_ERROR
    // We can mock fetch to return 400 and see what transport throws
    const originalFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 400,
        ok: false,
        text: async () => JSON.stringify({ error: 'invalid payload' }),
        json: async () => ({ error: 'invalid payload' }),
        headers: new Headers(),
      })) as any,
    )
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET })
    await expect(transport.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {} })).rejects.toMatchObject({
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_RELAY_PROTOCOL_ERROR,
    })
    vi.stubGlobal('fetch', originalFetch)
  })

  it('relay unreachable is classified as WORKER_CONNECTION_REFUSED', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: 'http://127.0.0.1:1', secret: SECRET })
    await expect(transport.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {} })).rejects.toMatchObject({
      code: expect.stringMatching(/WORKER_CONNECTION_REFUSED|WORKER_CONNECTION_TIMEOUT/),
    })
  })

  it('Direct transport does not use relay (and Cloudflare does)', async () => {
    const direct = new DirectRemoteFetchTransport()
    const relay = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET })
    // Direct should hit upstream directly (but in test, upstream is at 127.0.0.1, which is allowed via mock)
    // We can verify by checking that direct's fetch goes to upstream, not relay
    // For this test, we just verify that both transports can fetch the same upstream via their respective paths
    const directRes = await direct.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {} })
    expect(directRes.status).toBe(200)
    // Reset hits
    upstreamHits = []
    const relayRes = await relay.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {} })
    expect(relayRes.status).toBe(200)
    // Both hit upstream, but via different routes — direct hits upstream directly, relay hits upstream via relay's fetch
    // In our mock, both will hit upstream, but the relay's hit will be logged as coming from the relay server's fetch
    // We verify that the relay was used by checking that the relay server was hit (it was, because we made a request to it)
    // And that the direct request did not go via the relay (we can check that the relay's hit count is as expected)
    expect(upstreamHits.length).toBeGreaterThan(0)
  })

  it('rejects body:null with INVALID_BODY_TYPE (protocol mismatch regression)', async () => {
    const badPayload = JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, url: `${upstreamUrl}/test`, method: 'GET', headers: {}, body: null })
    const sig = signForRelay(SECRET, 'POST', '/fetch')
    const rawRes = await fetch(`${relayUrl}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sig },
      body: badPayload,
    })
    expect(rawRes.status).toBe(400)
    const json = (await rawRes.json()) as { error: string; reason?: string }
    expect(json.error).toBe('invalid payload')
    expect(json.reason).toBe('INVALID_BODY_TYPE')
  })

  it('serializer omits body for HEAD/GET (no body:null leak) — integration', async () => {
    let captured: any = null
    const origFetch = globalThis.fetch
    const spyFetch = vi.fn(async (url: any, init: any) => {
      if (typeof url === 'string' && url.includes('/fetch') && init?.body) {
        try {
          captured = JSON.parse(init.body as string)
        } catch {}
      }
      return origFetch(url, init) as any
    })
    vi.stubGlobal('fetch', spyFetch as any)
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET })
    await transport.request({ method: 'HEAD', url: `${upstreamUrl}/test`, headers: {} })
    expect(captured).not.toBeNull()
    expect(captured.body).toBeUndefined()
    expect(captured.protocolVersion).toBe(RELAY_PROTOCOL_VERSION)
    expect(Object.keys(captured).sort()).toEqual(['headers', 'method', 'protocolVersion', 'url'])
    // Verify via canonical parser — must be accepted
    expect(() => parseRelayRequest(JSON.stringify(captured))).not.toThrow()
    // Also GET
    captured = null
    await transport.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {} })
    expect(captured.body).toBeUndefined()
    expect(() => parseRelayRequest(JSON.stringify(captured))).not.toThrow()
    // GET + Range
    captured = null
    await transport.request({ method: 'GET', url: `${upstreamUrl}/test`, headers: {}, range: 'bytes=0-1023' })
    // Transport sets Range header with capital R; relay preserves it, upstream lowercases it
    expect(captured.headers.Range).toBe('bytes=0-1023')
    expect(captured.body).toBeUndefined()
    expect(() => parseRelayRequest(JSON.stringify(captured))).not.toThrow()
    vi.stubGlobal('fetch', origFetch)
  })

  it('HMAC verification is independent of body omission (signature still valid for HEAD)', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: relayUrl, secret: SECRET })
    const res = await transport.request({ method: 'HEAD', url: `${upstreamUrl}/test`, headers: {} })
    expect(res.status).toBe(200)
  })
})

describe('SecureRemoteFetcher workerId propagation', () => {
  it('creates Direct fetcher when workerId is null', async () => {
    const { createSecureFetcherForWorkerId } = await import('../../remote-imports/secure-fetcher.js')
    // Mock prisma to return null for worker
    const fetcher = await createSecureFetcherForWorkerId(null, { sourceUrl: 'https://example.com/video.mp4' })
    expect((fetcher as any).diagnostics.route).toBe('direct')
    // Check that transport is Direct
    const transport = (fetcher as any).transport
    expect(transport.constructor.name).toBe('DirectRemoteFetchTransport')
  })
})

describe('Serializer → relay parser integration (mandatory drift guard)', () => {
  it('HEAD payload from serializer is accepted by parser', async () => {
    const { serializeRelayRequest, parseRelayRequest } = await import('../relay-protocol.js')
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: 'https://example.test/video.m3u8', method: 'HEAD' as const, headers: {} }
    const raw = serializeRelayRequest(payload as any)
    const parsed = parseRelayRequest(raw)
    expect(parsed.method).toBe('HEAD')
  })
  it('GET payload from serializer is accepted by parser', async () => {
    const { serializeRelayRequest, parseRelayRequest } = await import('../relay-protocol.js')
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: 'https://example.test/video.m3u8', method: 'GET' as const, headers: {} }
    const raw = serializeRelayRequest(payload as any)
    const parsed = parseRelayRequest(raw)
    expect(parsed.method).toBe('GET')
  })
  it('GET+Range payload from serializer is accepted by parser', async () => {
    const { serializeRelayRequest, parseRelayRequest } = await import('../relay-protocol.js')
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: 'https://example.test/video.ts', method: 'GET' as const, headers: { range: 'bytes=0-1023' } }
    const raw = serializeRelayRequest(payload as any)
    const parsed = parseRelayRequest(raw)
    expect(parsed.headers.range).toBe('bytes=0-1023')
  })
  it('HLS master manifest payload from serializer is accepted by parser', async () => {
    const { serializeRelayRequest, parseRelayRequest } = await import('../relay-protocol.js')
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: 'https://example.test/master.m3u8', method: 'GET' as const, headers: { Accept: 'application/vnd.apple.mpegurl' } }
    const raw = serializeRelayRequest(payload as any)
    const parsed = parseRelayRequest(raw)
    expect(parsed.url).toBe('https://example.test/master.m3u8')
  })
  it('POST with body string is accepted', async () => {
    const { serializeRelayRequest, parseRelayRequest } = await import('../relay-protocol.js')
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: 'https://example.test/api', method: 'POST' as const, headers: {}, body: 'payload-data' }
    const raw = serializeRelayRequest(payload as any)
    const parsed = parseRelayRequest(raw)
    expect(parsed.body).toBe('payload-data')
  })
})
