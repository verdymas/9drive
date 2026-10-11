import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import { loadRelaySource } from '../drivers/cloudflare-relay.js'
import { CloudflareRemoteFetchTransport } from './cloudflare-transport.js'
import { RELAY_PROTOCOL_VERSION, RELAY_SIGNATURE_HEADER, serializeRelayRequest } from '../relay-protocol.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES } from '../errors.js'

vi.mock('../../remote-imports/ssrf.js', async (original) => ({
  ...(await original<typeof import('../../remote-imports/ssrf.js')>()),
  validateRemoteUrl: async (value: string) => new URL(value),
}))

const SECRET = 'diagnostics-test-secret'
const RELAY_URL = 'https://relay.test'

function sign(method: string, path: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${method} ${path}`, 'utf8').digest('hex')
}

describe('relay 404 diagnostics: URL/query/method/header/status preservation', () => {
  let upstream: http.Server
  let upstreamUrl = ''
  let worker: { fetch: (request: Request, env: { RELAY_SECRET: string }) => Promise<Response> }
  let originalFetch: typeof fetch
  const upstreamHits: Array<{ method: string; url: string; headers: Record<string, string> }> = []

  beforeAll(async () => {
    const source = loadRelaySource()
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
    worker = mod.default as typeof worker

    upstream = http.createServer((req, res) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ')
      }
      upstreamHits.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers })
      if (req.url?.startsWith('/redirect-to-final')) {
        // Preserve query through the redirect (signed-query shape).
        const u = new URL(req.url, 'http://x')
        const qs = u.search
        res.writeHead(302, { Location: `/final.m3u8${qs}` })
        res.end()
        return
      }
      if (req.url?.startsWith('/final.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '8' })
        res.end('#EXTM3U\n')
        return
      }
      if (req.url?.startsWith('/missing.mp4')) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found upstream')
        return
      }
      if (req.url?.startsWith('/video.mp4')) {
        if (req.headers.range) {
          res.writeHead(206, {
            'content-type': 'video/mp4',
            'content-range': 'bytes 0-0/11',
            'accept-ranges': 'bytes',
            'content-length': '1',
          })
          res.end('H')
          return
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '11', 'accept-ranges': 'bytes' })
        res.end('hello world')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url.startsWith(`${RELAY_URL}/`)) {
        return worker.fetch(new Request(input, init), { RELAY_SECRET: SECRET })
      }
      return originalFetch(input, init)
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  function transport() {
    return new CloudflareRemoteFetchTransport({ endpointUrl: RELAY_URL, secret: SECRET, workerId: 'w-404', driver: 'cloudflare' })
  }

  async function drain(res: { body: AsyncIterable<Uint8Array> | string }): Promise<string> {
    if (typeof res.body === 'string') return res.body
    let out = ''
    for await (const chunk of res.body) out += Buffer.from(chunk).toString()
    return out
  }

  it('preserves destination path and query string verbatim (no decode/normalize/truncate)', async () => {
    upstreamHits.length = 0
    // Signed-URL shape: encoded chars, plus, slashes — values must survive.
    const target = `${upstreamUrl}/video.mp4?token=a%2Bb%3Dc&expires=123&sig=xy%2Fz`
    const res = await transport().request({ method: 'GET', url: target, headers: {}, traceId: 'trace-query-1' })
    expect(res.status).toBe(200)
    await drain(res)
    expect(upstreamHits).toHaveLength(1)
    // Exact path + query preservation (upstream saw what the backend sent).
    expect(upstreamHits[0].url).toBe('/video.mp4?token=a%2Bb%3Dc&expires=123&sig=xy%2Fz')
    expect(upstreamHits[0].method).toBe('GET')
  })

  it('forwards GET method and permitted headers; strips non-allowlisted headers', async () => {
    upstreamHits.length = 0
    const target = `${upstreamUrl}/video.mp4`
    const res = await transport().request({
      method: 'GET',
      url: target,
      headers: {
        Accept: 'video/mp4',
        'User-Agent': 'CustomAgent/1.0',
        Authorization: 'Bearer secret-value',
        'X-Custom': 'evil',
        Host: 'evil.example',
        Connection: 'close',
      },
      traceId: 'trace-headers-1',
    })
    expect(res.status).toBe(200)
    await drain(res)
    const hit = upstreamHits[upstreamHits.length - 1]
    expect(hit.method).toBe('GET')
    expect(hit.headers['accept']).toBe('video/mp4')
    expect(hit.headers['user-agent']).toBe('CustomAgent/1.0')
    // Stripped, never forwarded.
    expect(hit.headers['authorization']).toBeUndefined()
    expect(hit.headers['x-custom']).toBeUndefined()
    expect(hit.headers['host']).not.toContain('evil')
    expect(hit.headers['connection']).not.toBe('close')
  })

  it('forwards Range when supplied and omits it otherwise (never mandatory)', async () => {
    upstreamHits.length = 0
    const target = `${upstreamUrl}/video.mp4`
    const withRange = await transport().request({ method: 'GET', url: target, headers: {}, range: 'bytes=0-0', traceId: 'trace-range-1' })
    expect(withRange.status).toBe(206)
    await drain(withRange)
    expect(upstreamHits[upstreamHits.length - 1].headers['range']).toBe('bytes=0-0')

    upstreamHits.length = 0
    const withoutRange = await transport().request({ method: 'GET', url: target, headers: {}, traceId: 'trace-range-2' })
    expect(withoutRange.status).toBe(200)
    await drain(withoutRange)
    expect(upstreamHits[upstreamHits.length - 1].headers['range']).toBeUndefined()
  })

  it('preserves upstream 206 with body and content-range headers', async () => {
    const target = `${upstreamUrl}/video.mp4`
    const res = await transport().request({ method: 'GET', url: target, headers: {}, range: 'bytes=0-0', traceId: 'trace-206-1' })
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 0-0/11')
    expect(res.headers['accept-ranges']).toBe('bytes')
    const body = await drain(res)
    expect(body).toBe('H')
    expect((res as { finalUrl?: string }).finalUrl).toBe(target)
  })

  it('preserves upstream 404 as status (streaming) — never a relay error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const target = `${upstreamUrl}/missing.mp4?token=abc123`
      const res = await transport().request({ method: 'GET', url: target, headers: {}, traceId: 'trace-404-1' })
      // Upstream 404 is returned, not thrown as WORKER_UNHEALTHY.
      expect(res.status).toBe(404)
      const body = await drain(res)
      expect(body).toContain('not found upstream')
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      // Relay was healthy (HTTP 200) carrying an upstream 404.
      const relayLine = lines.find((l) => l.includes('trace-404-1') && l.includes('relayHttpStatus='))
      expect(relayLine).toBeTruthy()
      expect(relayLine).toContain('relayHttpStatus=200')
      expect(relayLine).toContain('upstreamStatus=404')
      // Safe shape only — never the secret query value.
      expect(JSON.stringify(lines)).not.toContain('abc123')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('preserves upstream 404 via JSON envelope (non-streaming relay)', async () => {
    // Direct worker call without response:stream → v1 envelope path.
    const target = `${upstreamUrl}/missing.mp4`
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: target, method: 'GET' as const, headers: {}, traceId: 'trace-404-env' }
    const req = new Request(`${RELAY_URL}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sign('POST', '/fetch') },
      body: serializeRelayRequest(payload as never),
    })
    const relayRes = await worker.fetch(req, { RELAY_SECRET: SECRET })
    // Relay HTTP is 200; upstream 404 rides in the envelope.
    expect(relayRes.status).toBe(200)
    const data = (await relayRes.json()) as { status: number; body: string }
    expect(data.status).toBe(404)
    expect(Buffer.from(data.body, 'base64').toString()).toContain('not found upstream')
  })

  it('distinguishes relay-level 404 (wrong path) from upstream 404', async () => {
    // Relay-level 404: every non-/fetch path answers 404.
    const bad = await worker.fetch(
      new Request(`${RELAY_URL}/not-fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sign('POST', '/not-fetch') },
        body: JSON.stringify({}),
      }),
      { RELAY_SECRET: SECRET },
    )
    expect(bad.status).toBe(404)

    // Backend maps relay !ok (404) to WORKER_UNHEALTHY — never returns it as 404.
    const origFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, ok: false, text: async () => JSON.stringify({ error: 'not found' }), headers: new Headers() })) as any,
    )
    try {
      await expect(transport().request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {}, traceId: 'trace-relay404' })).rejects.toMatchObject({
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY,
      })
    } finally {
      vi.stubGlobal('fetch', origFetch)
    }
  })

  it('follows redirects and reports finalHost (redirect does not conceal the 404 origin)', async () => {
    const target = `${upstreamUrl}/redirect-to-final?token=q123`
    const res = await transport().request({ method: 'GET', url: target, headers: {}, traceId: 'trace-redirect-1' })
    expect(res.status).toBe(200)
    await drain(res)
    const finalUrl = (res as { finalUrl?: string }).finalUrl ?? ''
    expect(finalUrl).toContain('/final.m3u8')
    // Query shape survived the redirect hop.
    expect(finalUrl).toContain('token=')
    expect(new URL(finalUrl).hostname).toBe('127.0.0.1')
  })

  it('safe diagnostics carry traceId + shape but never secret values', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const target = `${upstreamUrl}/video.mp4?token=super-secret-value&expires=999`
      const res = await transport().request({ method: 'GET', url: target, headers: { Accept: '*/*' }, traceId: 'trace-safe-1' })
      await drain(res)
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      const ours = lines.filter((l) => l.includes('trace-safe-1'))
      expect(ours.length).toBeGreaterThan(0)
      // Correlation id + shape present.
      expect(ours.some((l) => l.includes('queryKeys='))).toBe(true)
      expect(ours.some((l) => l.includes('pathLen='))).toBe(true)
      // Never the secret value, cookie, or HMAC.
      expect(JSON.stringify(ours)).not.toContain('super-secret-value')
      expect(JSON.stringify(ours)).not.toContain(SECRET)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('accepts traceId in the canonical serializer and parser', async () => {
    const raw = serializeRelayRequest({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      url: `${upstreamUrl}/video.mp4`,
      method: 'GET',
      headers: {},
      traceId: 'trace-serializer-1',
    } as never)
    expect(JSON.parse(raw).traceId).toBe('trace-serializer-1')
    const req = new Request(`${RELAY_URL}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sign('POST', '/fetch') },
      body: raw,
    })
    const res = await worker.fetch(req, { RELAY_SECRET: SECRET })
    expect(res.status).toBe(200)
  })
})
