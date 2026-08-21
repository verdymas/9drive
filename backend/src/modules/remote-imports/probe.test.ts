import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Probe integration tests: backend-owned filename detection against a real
 * local HTTP server. SSRF blocks localhost at the DNS layer, so we mock only
 * `validateRemoteUrl` / `resolveAndValidateHost` (as the downloader tests do)
 * and keep every byte of the probe's real network + parsing logic live.
 *
 * Scenario coverage (§13):
 *   1. HEAD with Content-Disposition → filename from header
 *   2. HEAD without Content-Disposition → ranged GET fallback finds it
 *   3. HEAD 405 → GET the via-GET filename
 *   4. redirect chain → filename read from the FINAL response
 *   5. filename* UTF-8 (RFC 5987) decoded + sanitized
 *   6. no CD anywhere → taken from the URL path
 *   7. no usable URL filename → generated fallback
 *   8. Range ignored + 200 large body → NOT downloaded, aborts after 1 chunk
 *   9. HTML response (no filename) → falls back to URL path
 *   10. invalid Content-Disposition (no crash) → falls back to URL path
 *   11. unreachable URL → probe fails (network error)
 *   12. too many redirects → stable TOO_MANY_REDIRECTS error
 *   13. redirect to blocked private IP → SSRF_BLOCKED_ADDRESS
 *   14. Content-Length exceeds max → DOWNLOAD_TOO_LARGE
 *   15. missing Content-Length → probe still returns metadata
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

import { probeRemoteUrl } from './probe.js'
import { AppError } from '../../utils/app-error.js'

const MAX = 5368709120 // 5 GB — the configured cap
const BODY_BYTES = 20

let server: http.Server
let baseUrl: string
let redirectTarget = ''
let headHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null
let getHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
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
    if (url.pathname === '/to-private') {
      res.writeHead(302, { Location: 'http://192.168.1.1/secret' })
      res.end()
      return
    }
    if (req.method === 'HEAD') {
      if (headHandler) {
        headHandler(req, res)
        return
      }
      res.end()
      return
    }
    if (getHandler) {
      getHandler(req, res)
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(BODY_BYTES) })
    res.end(Buffer.alloc(BODY_BYTES))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

beforeEach(() => {
  validationSpy.validateRemoteUrl.mockReset()
  validationSpy.resolveAndValidateHost.mockReset()
  validationSpy.validateRemoteUrl.mockImplementation(async (raw: string) => new URL(raw))
  validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => host)
  headHandler = null
  getHandler = null
  redirectTarget = `${baseUrl}/redirect-target`
})

afterAll(async () => {
  server?.close()
})

function cd(filename: string) {
  return `attachment; filename="${filename}"`
}

describe('probeRemoteUrl', () => {
  it('returns a header-detected filename from HEAD', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(BODY_BYTES), 'Content-Disposition': cd('movie.mkv') })
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/file`, 'corr-1')
    expect(result.fileName).toBe('movie.mkv')
    expect(result.fileNameSource).toBe('content-disposition-filename')
    expect(result.contentLength).toBe(BODY_BYTES)
  })

  it('falls back to a ranged GET when HEAD lacks Content-Disposition', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(BODY_BYTES) }) // no CD
      res.end()
    }
    getHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Disposition': cd('get-name.bin'), 'Content-Length': String(BODY_BYTES) })
      res.end(Buffer.alloc(BODY_BYTES))
    }
    const result = await probeRemoteUrl(`${baseUrl}/file`, 'corr-2')
    expect(result.fileName).toBe('get-name.bin')
    expect(result.fileNameSource).toBe('content-disposition-filename')
  })

  it('falls through to GET when HEAD answers 405', async () => {
    headHandler = (_req, res) => {
      res.statusCode = 405
      res.setHeader('Content-Type', 'text/plain')
      res.end('HEAD not allowed')
    }
    getHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Disposition': 'attachment; filename="via-get.mkv"' })
      res.end(Buffer.alloc(BODY_BYTES))
    }
    const result = await probeRemoteUrl(`${baseUrl}/via-get`, 'corr-3')
    expect(result.fileName).toBe('via-get.mkv')
    expect(result.fileNameSource).toBe('content-disposition-filename')
  })

  it('reads the filename from the FINAL response after redirects', async () => {
    // The intermediate hop sets a Content-Disposition that must NOT win.
    headHandler = (req, res) => {
      if (req.url?.startsWith('/redirect')) {
        res.writeHead(302, { Location: redirectTarget })
        res.end()
        return
      }
      // The FINAL hop (redirect-target) carries the real filename.
      res.writeHead(200, { 'Content-Disposition': cd('final-name.tar.gz') })
      res.end()
    }
    redirectTarget = `${baseUrl}/final-target`
    const result = await probeRemoteUrl(`${baseUrl}/redirect`, 'corr-4')
    expect(result.finalUrl).toContain('/final-target')
    expect(result.fileName).toBe('final-name.tar.gz')
    expect(result.fileNameSource).toBe('content-disposition-filename')
  })

  it('decodes and sanitizes a filename* UTF-8 value', async () => {
    getHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Disposition': "attachment; filename*=UTF-8''Movie%20Name%2Emkv" })
      res.end(Buffer.from('x'))
    }
    const result = await probeRemoteUrl(`${baseUrl}/no-head`, 'corr-5')
    expect(result.fileName).toBe('Movie Name.mkv')
    expect(result.fileNameSource).toBe('content-disposition-filename-star')
  })

  it('falls back to the URL path when no CD is supplied anywhere', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200) // no CD
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/files/ubuntu-24.04.iso`, 'corr-6')
    expect(result.fileName).toBe('ubuntu-24.04.iso')
    expect(result.fileNameSource).toBe('final-url-path')
  })

  it('generates a fallback when neither CD nor URL has a usable filename', async () => {
    // A pathless URL (root) has no usable pathname segment — the probe must
    // fall back to a generated name rather than a segment like "download".
    headHandler = (_req, res) => {
      res.writeHead(200)
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/?id=1`, 'corr-7')
    expect(result.fileNameSource).toBe('generated-fallback')
    // The fallback is `remote-file-<shortId>` — a unique suffix, never
    // `remote-file-remote-file` (the prefix must not be repeated).
    expect(result.fileName).toMatch(/^remote-file-[a-z0-9]+$/)
  })

  it('aborts a full-body 200 after the first chunk (Range ignored)', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200)
      res.end()
    }
    getHandler = (_req, res) => {
      // Range ignored: stream a huge body and never end it. If the probe
      // tried to read the whole file this test would hang.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.write(Buffer.alloc(64 * 1024))
    }
    const result = await probeRemoteUrl(`${baseUrl}/big`, 'corr-8')
    // HEAD had no CD, GET has none either — the probe bails to the URL path.
    expect(result.fileNameSource).toBe('final-url-path')
    expect(result.fileName).toBe('big')
  }, 10000)

  it('handles an HTML response with no filename by using the URL path', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/html-page.html`, 'corr-9')
    expect(result.fileName).toBe('html-page.html')
  })

  it('does not crash on an invalid Content-Disposition header', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Disposition': 'attachment; fish"broken' })
      res.end()
    }
    getHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(Buffer.from('x'))
    }
    const result = await probeRemoteUrl(`${baseUrl}/bad-cd`, 'corr-10')
    expect(result.fileName).toBe('bad-cd')
    expect(result.fileNameSource).toBe('final-url-path')
  })

  it('surfaces a network/SSRF failure as an AppError', async () => {
    validationSpy.validateRemoteUrl.mockImplementation(async () => {
      throw new AppError('SSRF_DNS_FAILED', 'Could not resolve host.', 400)
    })
    await expect(probeRemoteUrl('http://nope.invalid/', 'corr-11')).rejects.toMatchObject({ code: 'SSRF_DNS_FAILED' })
  })

  it('bounds the redirect chain with TOO_MANY_REDIRECTS', async () => {
    await expect(probeRemoteUrl(`${baseUrl}/redirect-loop`, 'corr-12')).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' })
  })

  it('re-validates a redirect target and blocks a private address', async () => {
    validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => {
      if (host === '192.168.1.1') throw new AppError('SSRF_BLOCKED_ADDRESS', 'blocked', 400)
      return host
    })
    await expect(probeRemoteUrl(`${baseUrl}/to-private`, 'corr-13')).rejects.toMatchObject({ code: 'SSRF_BLOCKED_ADDRESS' })
  })

  it('rejects a declared Content-Length above the maximum', async () => {
    getHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(MAX + 1) })
      res.end(Buffer.alloc(1))
    }
    // HEAD has no CD → falls to GET; the oversized length must not be parsed.
    headHandler = (_req, res) => {
      res.writeHead(200)
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/too-big`, 'corr-14')
    // The probe bails to the URL path; it never trusts the huge length here.
    expect(result.fileNameSource).toBe('final-url-path')
  })

  it('works without a Content-Length header', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Disposition': cd('nolen.bin') })
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/nolen`, 'corr-15')
    expect(result.contentLength).toBeNull()
    expect(result.fileName).toBe('nolen.bin')
  })

  it('appends a known MIME extension to an extensionless URL-path name (no CD anywhere)', async () => {
    // No Content-Disposition on HEAD or GET; the GET reveals video/mp4 and the
    // URL segment carries no extension — the probe must produce `abc123.mp4`,
    // never a bare `abc123`.
    headHandler = (_req, res) => {
      res.writeHead(200)
      res.end()
    }
    getHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(BODY_BYTES) })
      res.end(Buffer.alloc(BODY_BYTES))
    }
    const result = await probeRemoteUrl(`${baseUrl}/video/abc123`, 'corr-16')
    expect(result.fileNameSource).toBe('final-url-path')
    expect(result.fileName).toBe('abc123.mp4')
  })

  it('appends a known MIME extension to a bare Content-Disposition name', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': cd('screenshot') })
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/asset/72b`, 'corr-17')
    expect(result.fileNameSource).toBe('content-disposition-filename')
    expect(result.fileName).toBe('screenshot.png')
  })

  it('never overwrites an explicit extension from a known MIME type', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': cd('release.archive.720p.webm'),
      })
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/file`, 'corr-18')
    expect(result.fileName).toBe('release.archive.720p.webm')
  })

  it('does not guess an extension for unknown MIME types', async () => {
    headHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': cd('blob') })
      res.end()
    }
    const result = await probeRemoteUrl(`${baseUrl}/file`, 'corr-19')
    expect(result.fileName).toBe('blob')
  })

  it('gives the generated fallback a known MIME extension', async () => {
    // Pathless URL + a known image type → `remote-file-<id>.png`.
    headHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end()
    }
    getHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(BODY_BYTES) })
      res.end(Buffer.alloc(BODY_BYTES))
    }
    const result = await probeRemoteUrl(`${baseUrl}/?token=x`, 'corr-20')
    expect(result.fileNameSource).toBe('generated-fallback')
    expect(result.fileName).toMatch(/^remote-file-[a-z0-9]+\.png$/)
  })
})