import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import { loadRelaySource } from '../drivers/cloudflare-relay.js'
import { CloudflareRemoteFetchTransport } from './cloudflare-transport.js'
import { DirectRemoteFetchTransport } from './direct-transport.js'
import {
  RELAY_PROTOCOL_VERSION,
  RELAY_SIGNATURE_HEADER,
  opTraceId,
  serializeRelayRequest,
  urlFingerprintForLog,
} from '../relay-protocol.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES } from '../errors.js'
import { SecureRemoteFetcher } from '../../remote-imports/secure-fetcher.js'

vi.mock('../../remote-imports/ssrf.js', async (original) => ({
  ...(await original<typeof import('../../remote-imports/ssrf.js')>()),
  validateRemoteUrl: async (value: string) => new URL(value),
  resolveAndValidateHost: async (host: string) => host,
}))

const SECRET = 'boundary-test-secret'
const RELAY_URL = 'https://relay.test'

function sign(method: string, path: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${method} ${path}`, 'utf8').digest('hex')
}

describe('relay failure boundary: correlated diagnostics + route consistency', () => {
  let upstream: http.Server
  let upstreamUrl = ''
  let worker: { fetch: (request: Request, env: { RELAY_SECRET: string }) => Promise<Response> }
  let originalFetch: typeof fetch
  const upstreamHits: Array<{ method: string; url: string }> = []

  beforeAll(async () => {
    const source = loadRelaySource()
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
    worker = mod.default as typeof worker

    upstream = http.createServer((req, res) => {
      upstreamHits.push({ method: req.method ?? 'GET', url: req.url ?? '/' })
      if (req.url?.startsWith('/missing')) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found upstream')
        return
      }
      if (req.url?.startsWith('/video')) {
        if (req.headers.range) {
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
    return new CloudflareRemoteFetchTransport({ endpointUrl: RELAY_URL, secret: SECRET, workerId: 'w-boundary', driver: 'cloudflare' })
  }

  async function drain(res: { body: AsyncIterable<Uint8Array> | string }): Promise<string> {
    if (typeof res.body === 'string') return res.body
    let out = ''
    for await (const chunk of res.body) out += Buffer.from(chunk).toString()
    return out
  }

  it('opTraceId scopes per-operation ids and urlFingerprint is canonical', () => {
    expect(opTraceId('job-1', 'probe-head')).toBe('job-1:probe-head')
    expect(opTraceId('job-1:probe-head', 'probe-head')).toBe('job-1:probe-head')
    expect(opTraceId(undefined, 'download')).toMatch(/:download$/)
    const a = urlFingerprintForLog(`${upstreamUrl}/video.mp4?token=abc`)
    const b = urlFingerprintForLog(`${upstreamUrl}/video.mp4?token=abc`)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    // Different query value → different fingerprint, but neither fp leaks the value.
    const c = urlFingerprintForLog(`${upstreamUrl}/video.mp4?token=other`)
    expect(c).not.toBe(a)
    expect(`${a}${b}${c}`).not.toContain('abc')
  })

  it('1: worker validation rejection happens before upstream fetch (no fetchExecuted)', async () => {
    upstreamHits.length = 0
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const bad = { protocolVersion: RELAY_PROTOCOL_VERSION, method: 'GET', headers: {} }
      const req = new Request(`${RELAY_URL}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sign('POST', '/fetch') },
        body: JSON.stringify({ ...bad, traceId: 'job-v:probe-head' }),
      })
      const res = await worker.fetch(req, { RELAY_SECRET: SECRET })
      expect(res.status).toBe(400)
      const data = (await res.json()) as { reason?: string }
      expect(data.reason).toBe('MISSING_URL')
      expect(upstreamHits).toHaveLength(0)
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      const line = lines.find((l) => l.includes('job-v:probe-head') && l.includes('validation_rejected'))
      expect(line).toBeTruthy()
      expect(line).toContain('reason=MISSING_URL')
      expect(line).toContain('fetchExecuted=false')
      expect(line).toContain('relayHttpStatus=400')
      expect(line).toContain('upstreamStatus=none')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('5: blocked-scheme URL is rejected as INVALID_URL without upstream fetch', async () => {
    upstreamHits.length = 0
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: 'javascript:alert(1)', method: 'GET', headers: {}, traceId: 'job-p:probe-head' }
    const req = new Request(`${RELAY_URL}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sign('POST', '/fetch') },
      body: JSON.stringify(payload),
    })
    const res = await worker.fetch(req, { RELAY_SECRET: SECRET })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { reason?: string }).reason).toBe('INVALID_URL')
    expect(upstreamHits).toHaveLength(0)
  })

  it('2: upstream 404 is classified as upstream (fetchExecuted=true, relay 200)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      upstreamHits.length = 0
      const target = `${upstreamUrl}/missing.mp4?token=secret-abc`
      const res = await transport().request({ method: 'GET', url: target, headers: {}, traceId: 'job-404:download' })
      expect(res.status).toBe(404)
      expect(await drain(res)).toContain('not found upstream')
      expect(upstreamHits).toHaveLength(1)
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      const ours = lines.filter((l) => l.includes('job-404:download'))
      expect(ours.length).toBeGreaterThan(0)
      // Worker post-fetch line proves upstream executed.
      const wl = ours.find((l) => l.includes('upstream_response'))
      expect(wl).toBeTruthy()
      expect(wl).toContain('fetchExecuted=true')
      expect(wl).toContain('upstreamStatus=404')
      expect(wl).toContain('relayHttpStatus=200')
      expect(wl).toContain('urlFp=')
      // Backend streaming/envelope line keeps outer vs inner distinct.
      const bl = ours.find((l) => l.includes('relayHttpStatus=200') && l.includes('upstreamStatus=404'))
      expect(bl).toBeTruthy()
      // No secret query value anywhere.
      expect(JSON.stringify(ours)).not.toContain('secret-abc')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('3: upstream 206 round-trips with body and range intact', async () => {
    const res = await transport().request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {}, range: 'bytes=0-0', traceId: 'job-206:probe-range' })
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 0-0/11')
    expect(await drain(res)).toBe('H')
  })

  it('4: upstream network exception is 502 UPSTREAM_FETCH_EXCEPTION, never 404', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: 'http://127.0.0.1:1/unreachable', method: 'GET', headers: {}, traceId: 'job-exc:download' }
      const req = new Request(`${RELAY_URL}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sign('POST', '/fetch') },
        body: serializeRelayRequest(payload as never),
      })
      const res = await worker.fetch(req, { RELAY_SECRET: SECRET })
      expect(res.status).toBe(502)
      const data = (await res.json()) as { code?: string }
      expect(data.code).toBe('UPSTREAM_FETCH_EXCEPTION')
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      const line = lines.find((l) => l.includes('job-exc:download') && l.includes('upstream_fetch_failed'))
      expect(line).toBeTruthy()
      expect(line).toContain('upstreamStatus=none')
      expect(line).toContain('relayHttpStatus=502')
      expect(line).not.toContain('upstreamStatus=404')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('6: backend distinguishes relay-404 (WORKER_UNHEALTHY) from upstream-404 (status)', async () => {
    const bad = await worker.fetch(
      new Request(`${RELAY_URL}/not-fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sign('POST', '/not-fetch') },
        body: JSON.stringify({}),
      }),
      { RELAY_SECRET: SECRET },
    )
    expect(bad.status).toBe(404)

    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false, text: async () => JSON.stringify({ error: 'not found' }), headers: new Headers() })) as any)
    try {
      await expect(transport().request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {}, traceId: 'job-relay404:download' })).rejects.toMatchObject({
        code: REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY,
      })
    } finally {
      vi.stubGlobal('fetch', origFetch)
    }
  })

  it('7+8: worker-selected job stays on Worker after 404; no Direct request', async () => {
    const workerHits: unknown[] = []
    const directHits: unknown[] = []
    const workerTransport = {
      request: async (input: { traceId?: string; url: string }) => {
        workerHits.push(input)
        return { status: 404, statusText: '404', headers: {}, body: (async function* () {})(), finalUrl: input.url, redirectCount: 0 }
      },
    }
    const directTransport = {
      request: async (input: unknown) => {
        directHits.push(input)
        return { status: 200, statusText: '200', headers: {}, body: (async function* () {})(), finalUrl: '', redirectCount: 0 }
      },
    }
    const workerFetcher = new SecureRemoteFetcher(workerTransport as never, { route: 'worker', workerId: 'w-1', driver: 'cloudflare', relayHost: 'relay.test' })
    // Probe fails 404 through Worker.
    const probeRes = await workerFetcher.fetch({ method: 'GET', url: `${upstreamUrl}/missing`, range: 'bytes=0-0', traceId: 'job-stay:probe-range' } as never)
    expect(probeRes.status).toBe(404)
    // Retry/download through the SAME worker fetcher (existing retry policy retries Worker only).
    const dlRes = await workerFetcher.fetch({ method: 'GET', url: `${upstreamUrl}/missing`, traceId: 'job-stay:download' } as never)
    expect(dlRes.status).toBe(404)
    expect(workerHits).toHaveLength(2)
    expect(directHits).toHaveLength(0)
    // downloadToFile maps upstream 404 to DOWNLOAD_HTTP_ERROR (Worker-route error, never Direct).
    await expect(workerFetcher.downloadToFile(`${upstreamUrl}/missing`, '/tmp/x', { traceId: 'job-stay:download' } as never)).rejects.toMatchObject({ code: 'DOWNLOAD_HTTP_ERROR' })
    expect(directHits).toHaveLength(0)
  })

  it('9: independent Direct jobs remain unaffected', async () => {
    const direct = new DirectRemoteFetchTransport()
    const res = await direct.request({ method: 'GET', url: `${upstreamUrl}/video.mp4`, headers: {}, traceId: 'direct-job:probe-range' })
    expect(res.status).toBe(200)
    await drain(res)
  })

  it('11: logs carry traceId+urlFp+shape but never secrets', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const target = `${upstreamUrl}/video.mp4?token=top-secret-value&expires=999`
      const res = await transport().request({ method: 'GET', url: target, headers: { Accept: '*/*' }, traceId: 'job-safe:probe-range' })
      await drain(res)
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      const ours = lines.filter((l) => l.includes('job-safe:probe-range'))
      expect(ours.length).toBeGreaterThan(0)
      expect(ours.some((l) => l.includes('urlFp='))).toBe(true)
      expect(ours.some((l) => l.includes('queryKeys='))).toBe(true)
      expect(JSON.stringify(ours)).not.toContain('top-secret-value')
      expect(JSON.stringify(ours)).not.toContain(SECRET)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('12: relay accepts payloads without traceId/response (backward compatible)', async () => {
    const raw = JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, url: `${upstreamUrl}/video.mp4`, method: 'GET', headers: {} })
    const req = new Request(`${RELAY_URL}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: sign('POST', '/fetch') },
      body: raw,
    })
    const res = await worker.fetch(req, { RELAY_SECRET: SECRET })
    expect(res.status).toBe(200)
  })
})
