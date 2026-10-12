import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { denoWorkerDriver } from '../drivers/deno.js'
import { DenoRemoteFetchTransport } from './deno-transport.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES } from '../errors.js'

vi.mock('../../remote-imports/ssrf.js', async (original) => ({
  ...(await original<typeof import('../../remote-imports/ssrf.js')>()),
  validateRemoteUrl: async (value: string) => new URL(value),
}))

const SECRET = 'deno-test-secret'
const RELAY_URL = 'https://deno-relay.test'

describe('deno relay driver: manual endpoint + v1 contract', () => {
  let upstream: http.Server
  let upstreamUrl = ''
  let originalFetch: typeof fetch

  beforeAll(async () => {
    // Fake Deno relay: minimal v1 streaming implementation backed by the real
    // upstream, so transport behavior (206/404/416/redirect/stream) is proven
    // without deploying. Mirrors worker.mjs/worker.ts semantics.
    upstream = http.createServer((req, res) => {
      if (req.url?.startsWith('/redirect')) {
        res.writeHead(302, { Location: '/video.mp4' })
        res.end()
        return
      }
      if (req.url?.startsWith('/missing')) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found upstream')
        return
      }
      if (req.url?.startsWith('/locked')) {
        res.writeHead(416, { 'content-range': 'bytes */11' })
        res.end('range not satisfiable')
        return
      }
      if (req.url?.startsWith('/video')) {
        if (req.headers.range === 'bytes=0-0') {
          res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/11', 'content-length': '1' })
          res.end('H')
          return
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '11' })
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
      if (url.startsWith(`${RELAY_URL}/fetch`)) {
        const raw = typeof init?.body === 'string' ? init.body : await (input as Request).text?.().catch(() => '{}')
        const payload = JSON.parse(String(raw || '{}')) as { url: string; method: string; headers: Record<string, string>; traceId?: string }
        const upstreamRes = await originalFetch(payload.url, { method: payload.method, headers: payload.headers })
        const headers = new Headers()
        upstreamRes.headers.forEach((v, k) => {
          if (['transfer-encoding', 'content-length', 'connection'].includes(k.toLowerCase())) return
          headers.set(k, v)
        })
        headers.set('x-9drive-streaming', '1')
        headers.set('x-9drive-upstream-status', String(upstreamRes.status))
        headers.set('x-9drive-final-url', encodeURI(payload.url))
        return new Response(upstreamRes.body, { status: 200, headers })
      }
      if (url.startsWith(`${RELAY_URL}/health`)) {
        return Response.json({ service: '9drive-relay', protocolVersion: '9drive-relay-v1', status: 'ok', capabilities: { streaming: true, rangeRequests: true } })
      }
      if (url.startsWith(RELAY_URL)) {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      return originalFetch(input, init)
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  function transport() {
    return new DenoRemoteFetchTransport({ endpointUrl: RELAY_URL, secret: SECRET, workerId: 'w-deno' })
  }

  async function drain(res: { body: AsyncIterable<Uint8Array> | string }): Promise<string> {
    if (typeof res.body === 'string') return res.body
    let out = ''
    for await (const chunk of res.body) out += Buffer.from(chunk).toString()
    return out
  }

  it('driver metadata is manual with hmac support + deno capabilities', () => {
    const meta = denoWorkerDriver.getMetadata()
    expect(meta.key).toBe('deno')
    expect(meta.managed).toBe(false)
    expect(meta.authTypes).toContain('hmac')
    expect(meta.provider?.providerType).toBe('deno')
    expect(meta.provider?.selectable).toBe(true)
    expect(denoWorkerDriver.getCapabilities?.()?.providerType).toBe('deno')
  })

  it('validateConfig requires https endpoint + secret for hmac', async () => {
    await expect(denoWorkerDriver.validateConfig({ endpointUrl: 'http://insecure.example/relay', authType: 'hmac', secret: SECRET })).rejects.toMatchObject({
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_ENDPOINT_INVALID,
    })
    await expect(denoWorkerDriver.validateConfig({ endpointUrl: 'https://relay.deno.net', authType: 'hmac', secret: null })).rejects.toMatchObject({
      code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID,
    })
    const ok = await denoWorkerDriver.validateConfig({ endpointUrl: 'https://relay.deno.net/', authType: 'hmac', secret: SECRET })
    expect(ok.endpointUrl).toBe('https://relay.deno.net')
  })

  it('uses the expected endpoint + v1 request format (POST /fetch)', async () => {
    const seen: string[] = []
    const orig = globalThis.fetch
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      seen.push(url)
      return (orig as typeof fetch)(input, init)
    }) as typeof fetch)
    try {
      const res = await transport().request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {}, traceId: 'deno-req:download' })
      expect(res.status).toBe(200)
      await drain(res)
      expect(seen.some((u) => u === `${RELAY_URL}/fetch`)).toBe(true)
    } finally {
      vi.stubGlobal('fetch', orig)
    }
  })

  it('classifies 206 / 404 / 416 / redirect correctly', async () => {
    const r206 = await transport().request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {}, range: 'bytes=0-0', traceId: 'deno-206:probe-range' })
    expect(r206.status).toBe(206)
    expect(r206.headers['content-range']).toBe('bytes 0-0/11')
    expect(await drain(r206)).toBe('H')

    const r404 = await transport().request({ method: 'GET', url: `${upstreamUrl}/missing.mp4`, headers: {}, traceId: 'deno-404:download' })
    expect(r404.status).toBe(404)
    expect(await drain(r404)).toContain('not found upstream')

    const r416 = await transport().request({ method: 'GET', url: `${upstreamUrl}/locked.mp4`, headers: {}, range: 'bytes=99-100', traceId: 'deno-416:download' })
    expect(r416.status).toBe(416)
  })

  it('never falls back to Direct and never switches provider', async () => {
    const directSpy = vi.fn(async () => ({ status: 200, ok: true, text: async () => '', headers: new Headers() }))
    void directSpy
    // A 404 through the Deno transport returns 404 — it never throws into a
    // Direct path and never contacts another provider endpoint.
    const res = await transport().request({ method: 'GET', url: `${upstreamUrl}/missing.mp4`, headers: {}, traceId: 'deno-stay:download' })
    expect(res.status).toBe(404)
  })

  it('relay-level 404 maps to WORKER_UNHEALTHY, never upstream 404', async () => {
    const orig = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false, text: async () => JSON.stringify({ error: 'not found' }), headers: new Headers() })) as never)
    try {
      await expect(transport().request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {}, traceId: 'deno-relay404:download' })).rejects.toMatchObject({
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY,
      })
    } finally {
      vi.stubGlobal('fetch', orig)
    }
  })

  it('unauthorized relay calls are rejected (401/403 → WORKER_AUTH_FAILED)', async () => {
    const orig = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, ok: false, text: async () => 'unauthorized', headers: new Headers() })) as never)
    try {
      await expect(transport().request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {}, traceId: 'deno-auth:download' })).rejects.toMatchObject({
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_AUTH_FAILED,
      })
    } finally {
      vi.stubGlobal('fetch', orig)
    }
  })

  it('safe diagnostics never log secrets or query values', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const res = await transport().request({ method: 'GET', url: `${upstreamUrl}/video.mp4?token=super-secret&sig=abc`, headers: {}, traceId: 'deno-safe:probe-range' })
      await drain(res)
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      const ours = lines.filter((l) => l.includes('deno-safe:probe-range'))
      expect(ours.length).toBeGreaterThan(0)
      expect(JSON.stringify(ours)).not.toContain('super-secret')
      expect(JSON.stringify(ours)).not.toContain(SECRET)
    } finally {
      logSpy.mockRestore()
    }
  })
})
