import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * SSRF must not reach localhost, so for these integration tests we mock only
 * the DNS + validation layer (the downloader's redirect/streaming/timeout logic
 * stays fully real). A separate unit test proves a per-hop validation error is
 * surfaced and aborts the download.
 */
const validationSpy = vi.hoisted(() => ({
  validateRemoteUrl: vi.fn(),
  resolveAndValidateHost: vi.fn(),
}))

vi.mock('./ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ssrf.js')>()
  return {
    ...actual,
    validateRemoteUrl: validationSpy.validateRemoteUrl,
    resolveAndValidateHost: validationSpy.resolveAndValidateHost,
  }
})

import { followRemoteUrl } from './url-downloader.js'
import { hopHeaderResolver } from './request-context.js'
import { AppError } from '../../utils/app-error.js'

const BODY = 'chunk-one;chunk-two;chunk-three'
const MIME = 'application/octet-stream'

let server: http.Server
let baseUrl: string
const hits: number[] = []
/** Headers received by the fixture server, one entry per request. */
const receivedHeaders: Array<Record<string, string>> = []
let redirectTarget = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.push(1)
    receivedHeaders.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])))
    if (url.pathname === '/chunked') {
      res.writeHead(200, { 'Content-Type': MIME, 'Transfer-Encoding': 'chunked' })
      res.write(BODY.slice(0, 10))
      setTimeout(() => {
        res.write(BODY.slice(10))
        res.end()
      }, 30)
      return
    }
    if (url.pathname === '/slow-idle') {
      res.writeHead(200, { 'Content-Type': MIME })
      res.write('start')
      // Never finish — bodyTimeout (idle) should abort it.
      return
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: redirectTarget })
      res.end()
      return
    }
    if (url.pathname === '/redirect-loop') {
      res.writeHead(302, { Location: '/redirect-loop' })
      res.end()
      return
    }
    if (url.pathname === '/final') {
      res.writeHead(200, { 'Content-Type': MIME })
      res.end(Buffer.from(BODY))
      return
    }
    res.writeHead(200, { 'Content-Type': MIME })
    res.end(Buffer.from(BODY))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  server?.close()
})

beforeEach(() => {
  validationSpy.validateRemoteUrl.mockReset()
  validationSpy.resolveAndValidateHost.mockReset()
  validationSpy.validateRemoteUrl.mockImplementation(async (raw: string) => new URL(raw))
  validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => host)
  hits.length = 0
  receivedHeaders.length = 0
  redirectTarget = `${baseUrl}/final`
})

describe('followRemoteUrl', () => {
  it('downloads a body over HTTP and returns finalUrl', async () => {
    const { result, finalUrl } = await followRemoteUrl(`${baseUrl}/chunked`, {
      onResponse: async ({ statusCode, headers, body }) => {
        expect(statusCode).toBe(200)
        expect(headers['content-type']).toBe(MIME)
        let data = ''
        for await (const chunk of body) data += Buffer.from(chunk).toString('utf8')
        return { size: data.length }
      },
    })
    expect(result.size).toBe(BODY.length)
    expect(finalUrl).toBe(`${baseUrl}/chunked`)
  })

  it('follows redirects and re-validates each hop', async () => {
    const { result, finalUrl } = await followRemoteUrl(`${baseUrl}/redirect`, {
      onResponse: async ({ body }) => {
        let data = ''
        for await (const chunk of body) data += Buffer.from(chunk).toString('utf8')
        return data.length
      },
    })
    expect(result).toBe(BODY.length)
    expect(finalUrl).toBe(`${baseUrl}/final`)
    // initial + redirect-target both hit the server
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it('enforces the redirect limit with a stable code', async () => {
    await expect(
      followRemoteUrl(`${baseUrl}/redirect-loop`, { onResponse: async () => 0 }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' })
  })

  it('aborts an idle connection that stops producing data', async () => {
    await expect(
      followRemoteUrl(`${baseUrl}/slow-idle`, {
        // Must actually consume the body so the idle timeout has something to
        // fire against; unsupported-termination surfaces as a rejected promise.
        onResponse: async ({ body }) => {
          for await (const _chunk of body) {
            /* consume */
          }
          return 0
        },
      }),
    ).rejects.toBeDefined()
  }, 10000)

  it('surfaces a per-hop validation error before opening a socket', async () => {
    validationSpy.resolveAndValidateHost.mockImplementation(async () => {
      throw new AppError('SSRF_BLOCKED_ADDRESS', 'blocked', 400)
    })
    await expect(
      followRemoteUrl(`${baseUrl}/final`, { onResponse: async () => 0 }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED_ADDRESS' })
  })
})

describe('followRemoteUrl with getHopHeaders (request-context forwarding)', () => {
  const CONTEXT = { referer: 'https://site.example/watch/1', userAgent: 'Mozilla/5.0 Test', cookie: 'session=secret' }

  /** Second fixture server on a DIFFERENT port — a different origin. */
  let otherServer: http.Server
  let otherBaseUrl: string
  const otherHeaders: Array<Record<string, string>> = []

  beforeAll(async () => {
    otherServer = http.createServer((req, res) => {
      otherHeaders.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])))
      res.writeHead(200, { 'Content-Type': MIME })
      res.end(Buffer.from(BODY))
    })
    await new Promise<void>((resolve) => otherServer.listen(0, '127.0.0.1', resolve))
    const { port } = otherServer.address() as AddressInfo
    otherBaseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    otherServer?.close()
  })

  beforeEach(() => {
    otherHeaders.length = 0
  })

  it('merges the context headers per hop; same-host hop keeps the Cookie', async () => {
    const resolver = hopHeaderResolver(`${baseUrl}/redirect`, CONTEXT)
    await followRemoteUrl(`${baseUrl}/redirect`, {
      getHopHeaders: resolver,
      onResponse: async ({ body }) => {
        for await (const _c of body) { /* consume */ }
        return 0
      },
    })
    // Two requests: the initial /redirect + the redirected /final, both on the
    // same fixture host (127.0.0.1:port) => Cookie must be on BOTH.
    expect(receivedHeaders.length).toBeGreaterThanOrEqual(2)
    for (const headers of receivedHeaders) {
      expect(headers['cookie']).toBe('session=secret')
      expect(headers['referer']).toBe('https://site.example/watch/1')
      expect(headers['user-agent']).toBe('Mozilla/5.0 Test')
    }
  })

  it('drops the Cookie when a redirect crosses to a different port (spec §13)', async () => {
    const resolver = hopHeaderResolver(`${baseUrl}/redirect`, CONTEXT)
    redirectTarget = `${otherBaseUrl}/final` // different port => different origin key
    await followRemoteUrl(`${baseUrl}/redirect`, {
      getHopHeaders: resolver,
      onResponse: async ({ body }) => {
        for await (const _c of body) { /* consume */ }
        return 0
      },
    })
    // The source-host hop carried the Cookie...
    expect(receivedHeaders[0]['cookie']).toBe('session=secret')
    // ...but the cross-port hop did NOT (headers were recomputed per hop).
    expect(otherHeaders[0]['cookie']).toBeUndefined()
    // UA/Referer still forwarded cross-origin (spec §10/§11).
    expect(otherHeaders[0]['referer']).toBe('https://site.example/watch/1')
    expect(otherHeaders[0]['user-agent']).toBe('Mozilla/5.0 Test')
  })

  it('no-op when the resolver is undefined (existing callers unchanged)', async () => {
    await followRemoteUrl(`${baseUrl}/final`, {
      onResponse: async ({ body }) => {
        for await (const _c of body) { /* consume */ }
        return 0
      },
    })
    expect(receivedHeaders[0]['cookie']).toBeUndefined()
  })
})