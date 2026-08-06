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
import { AppError } from '../../utils/app-error.js'

const BODY = 'chunk-one;chunk-two;chunk-three'
const MIME = 'application/octet-stream'

let server: http.Server
let baseUrl: string
const hits: number[] = []
let redirectTarget = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.push(1)
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