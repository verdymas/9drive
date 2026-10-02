import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadRelaySource } from '../drivers/cloudflare-relay.js'
import { CloudflareRemoteFetchTransport } from './cloudflare-transport.js'

vi.mock('../../remote-imports/ssrf.js', async (original) => ({
  ...(await original<typeof import('../../remote-imports/ssrf.js')>()),
  validateRemoteUrl: async (value: string) => new URL(value),
}))

describe('Cookie-safe transport through deployed Worker artifact', () => {
  let first: http.Server
  let second: http.Server
  let firstUrl: string
  let secondUrl: string
  let originalFetch: typeof fetch
  const hits: Array<{ host: string; path: string; cookie?: string }> = []

  beforeAll(async () => {
    second = http.createServer((req, res) => {
      hits.push({ host: 'second', path: req.url ?? '', cookie: req.headers.cookie })
      res.end('ok')
    })
    await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve))
    secondUrl = `http://127.0.0.1:${(second.address() as AddressInfo).port}`
    first = http.createServer((req, res) => {
      hits.push({ host: 'first', path: req.url ?? '', cookie: req.headers.cookie })
      if (req.url === '/same') res.writeHead(302, { Location: '/final' })
      if (req.url === '/cross') res.writeHead(302, { Location: `${secondUrl}/final` })
      res.end('ok')
    })
    await new Promise<void>((resolve) => first.listen(0, '127.0.0.1', resolve))
    firstUrl = `http://127.0.0.1:${(first.address() as AddressInfo).port}`
    const mod = await import(`data:text/javascript;base64,${Buffer.from(loadRelaySource()).toString('base64')}`)
    originalFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://relay-old.test/')) return Promise.resolve(new Response(JSON.stringify({ error: 'invalid payload', reason: 'INVALID_PROTOCOL' }), { status: 400, headers: { 'content-type': 'application/json' } }))
      if (url.startsWith('https://relay.test/')) return mod.default.fetch(new Request(input, init), { RELAY_SECRET: 'test-secret' })
      return originalFetch(input, init)
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = originalFetch
    await Promise.all([first, second].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('keeps Cookie on same-origin redirects and removes it on cross-origin redirects and child requests', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: 'https://relay.test', secret: 'test-secret', sourceUrl: `${firstUrl}/source`, requestContext: { cookie: 'session=private-value' } })
    const same = await transport.request({ method: 'GET', url: `${firstUrl}/same` })
    expect(same.status).toBe(200)
    await transport.request({ method: 'GET', url: `${firstUrl}/cross` })
    await transport.request({ method: 'GET', url: `${secondUrl}/child` })
    expect(hits.filter((hit) => hit.host === 'first').map((hit) => hit.cookie)).toEqual(['session=private-value', 'session=private-value', 'session=private-value'])
    expect(hits.filter((hit) => hit.host === 'second').map((hit) => hit.cookie)).toEqual([undefined, undefined])
  })

  it('fails closed against an older relay that rejects the Cookie-safe protocol', async () => {
    const transport = new CloudflareRemoteFetchTransport({ endpointUrl: 'https://relay-old.test', secret: 'test-secret', sourceUrl: `${firstUrl}/source`, requestContext: { cookie: 'session=private-value' } })
    const before = hits.length
    await expect(transport.request({ method: 'GET', url: `${firstUrl}/source` })).rejects.toMatchObject({ code: 'WORKER_RELAY_PROTOCOL_ERROR' })
    expect(hits.length).toBe(before)
  })
})
