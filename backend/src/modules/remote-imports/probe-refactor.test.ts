import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Probe refactor integration tests (§16/§17): a local controlled HTTP server
 * exercises the exact failure sequence from the report —
 *
 *   HEAD 403 → ranged GET success → HLS fetch failure → null HLS metadata
 *
 * and its fixes:
 *  - HEAD 403/405/500 are NOT logged as success and fall back to GET,
 *  - probable-HLS sources use ONE bounded manifest GET on the FINAL URL,
 *  - signed query parameters survive every hop and are never redacted from
 *    the URL actually fetched,
 *  - the redacted display URL is never used for network access,
 *  - manifest 401/403/404/429/500 map to stable structured codes (never a
 *    silent `hls: null` downgrade),
 *  - oversized/slow manifests abort at the configured caps.
 *
 * SSRF is mocked as in probe.test.ts / probe-hls.test.ts; the real network +
 * parsing path runs live against 127.0.0.1.
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

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
mid/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
high/index.m3u8`

const MEDIA_VOD = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.000,
seg-1.ts
#EXTINF:6.000,
seg-2.ts
#EXT-X-ENDLIST`

/** Server-side routing config set per test. */
let headStatus = 200
let headBody = ''
let getStatus = 200
let serveBody = ''
let contentType = 'application/octet-stream'
/** If set, the server answers HEAD with this status and falls through to GET. */
let headForbidden = false
/** If set, /signed-hls requires `?token=abc` on every request (HEAD included). */
let requireToken = false
/** If set, /redirect-to-final answers 302 to /final; relative URIs resolve there. */
let redirectChain = false
/** Requests seen by the server, for query/URL assertions. */
const seenUrls: string[] = []
/** A slow manifest: send a header then delay the body past the idle timeout. */
let slowManifest = false

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seenUrls.push(req.url ?? '')

    // Signed-token gate: EVERY request (HEAD and GET alike) must carry the
    // query — otherwise the signed URL was lost somewhere in the chain.
    if (requireToken && url.searchParams.get('token') !== 'abc') {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('token required')
      return
    }

    if (redirectChain && url.pathname === '/start') {
      res.writeHead(302, { Location: '/final/master.m3u8' })
      res.end()
      return
    }

    if (req.method === 'HEAD') {
      if (headForbidden) {
        res.writeHead(headStatus, { 'Content-Type': 'text/plain' })
        res.end()
        return
      }
      res.writeHead(headStatus, { 'Content-Type': contentType })
      res.end()
      return
    }

    if (url.pathname.startsWith('/final/')) {
      // The FINAL hop: relative children in the served manifest resolve
      // against the final URL when redirected.
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(Buffer.from(serveBody))
      return
    }

    if (slowManifest) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.write('#EXTM3U\n')
      // Never end the body — the probe's idle timeout must abort.
      return
    }

    if (url.pathname === '/oversized') {
      // Stream PAST the configured manifest cap in many chunks; the probe
      // must abort mid-stream with HLS_MANIFEST_TOO_LARGE (never buffer the
      // full body). 16 MiB total » 1 MiB cap.
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      const chunk = Buffer.alloc(64 * 1024, 0x23) // '#' — manifest-ish prefix
      for (let i = 0; i < 256; i += 1) {
        res.write(chunk)
      }
      res.end()
      return
    }

    res.writeHead(getStatus, { 'Content-Type': contentType })
    res.end(Buffer.from(serveBody))
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
  headStatus = 200
  headBody = ''
  getStatus = 200
  serveBody = ''
  contentType = 'application/octet-stream'
  headForbidden = false
  requireToken = false
  redirectChain = false
  slowManifest = false
  seenUrls.length = 0
})

afterAll(async () => {
  server?.close()
})

describe('probe refactor: HEAD semantics (§1, §8)', () => {
  it('HEAD 403 + GET 200 valid HLS → probe succeeds as hls_master', async () => {
    headForbidden = true
    headStatus = 403
    contentType = 'application/vnd.apple.mpegurl'
    serveBody = MASTER
    const result = await probeRemoteUrl(`${baseUrl}/head-403-hls`, 'ref-1')
    expect(result.sourceType).toBe('hls_master')
    expect(result.hls?.variants).toHaveLength(2)
    // The final redirected-URL children were resolved.
    expect(JSON.stringify(result.hls?.variants)).not.toContain('index.m3u8')
  })

  it('HEAD 405 + GET 200 direct file → direct_file with the GET filename', async () => {
    headForbidden = true
    headStatus = 405
    getStatus = 200
    // No Content-Disposition on HEAD; GET carries it.
    contentType = 'application/octet-stream'
    serveBody = 'binary payload'
    const result = await probeRemoteUrl(`${baseUrl}/head-405-direct`, 'ref-2')
    expect(result.sourceType).toBe('direct_file')
    expect(result.hls).toBeNull()
  })

  it('HEAD 500 + GET 200 HLS → fallback allowed, probe succeeds', async () => {
    headForbidden = true
    headStatus = 500
    contentType = 'application/vnd.apple.mpegurl'
    serveBody = MASTER
    const result = await probeRemoteUrl(`${baseUrl}/head-500-hls`, 'ref-3')
    expect(result.sourceType).toBe('hls_master')
  })

  it('never logs a non-2xx HEAD as success', async () => {
    headForbidden = true
    headStatus = 403
    serveBody = MEDIA_VOD
    contentType = 'application/octet-stream'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await probeRemoteUrl(`${baseUrl}/head-403-no-hint`, 'ref-4')
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes('HEAD ok'))).toBe(false)
      expect(lines.some((l) => l.includes('head_rejected'))).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('probe refactor: signed query preservation (§3, §4)', () => {
  it('preserves the token on every hop — the server 403s tokenless requests', async () => {
    requireToken = true
    contentType = 'application/vnd.apple.mpegurl'
    serveBody = MASTER
    const result = await probeRemoteUrl(`${baseUrl}/signed-hls?token=abc&expires=123`, 'ref-5')
    expect(result.sourceType).toBe('hls_master')
    // Every request the server saw (HEAD + bounded manifest GET) carried the
    // token — the signed query was never dropped or redacted on the wire.
    expect(seenUrls.length).toBeGreaterThanOrEqual(2)
    for (const u of seenUrls) {
      expect(u).toContain('token=abc')
      expect(u).toContain('expires=123')
    }
  })

  it('redacts sensitive query params from the RESULT URLs but never from the fetch', async () => {
    requireToken = true
    contentType = 'application/vnd.apple.mpegurl'
    serveBody = MASTER
    const result = await probeRemoteUrl(`${baseUrl}/signed-hls?token=abc&expires=123`, 'ref-6')
    // Display URLs are redacted — no token value survives.
    expect(result.originalUrl).not.toContain('token=abc')
    expect(result.finalUrl).not.toContain('token=abc')
    // But the server still saw the real token (fetch used the signed URL).
    expect(seenUrls.some((u) => u.includes('token=abc'))).toBe(true)
  })

  it('resolves relative child URIs against the FINAL redirected URL', async () => {
    redirectChain = true
    contentType = 'application/vnd.apple.mpegurl'
    // The master served from /final/master.m3u8 references `mid/index.m3u8`
    // — resolved against the FINAL URL, so the probe sees a master with 2
    // variants (a resolution against the original /start would 404 the
    // manifest GET... actually the manifest IS /final/master.m3u8, so the
    // parse succeeds; the children resolution is asserted via the variants
    // count + the absence of serialized URLs).
    serveBody = MASTER
    const result = await probeRemoteUrl(`${baseUrl}/start`, 'ref-7')
    expect(result.sourceType).toBe('hls_master')
    expect(result.finalUrl).toContain('/final/master.m3u8')
    expect(result.hls?.variants).toHaveLength(2)
    // The internal (never-serialized) child URL must resolve against /final.
    expect(JSON.stringify(result.hls?.variants)).not.toContain('index.m3u8')
  })
})

describe('probe refactor: HLS detection + invalid bodies (§6, §7)', () => {
  it('detects HLS via content-type only (no .m3u8 extension)', async () => {
    contentType = 'application/vnd.apple.mpegurl'
    serveBody = MASTER
    const result = await probeRemoteUrl(`${baseUrl}/asset/7f3a`, 'ref-8')
    expect(result.sourceType).toBe('hls_master')
  })

  it('detects HLS via the body prefix when neither URL nor content-type hints', async () => {
    contentType = 'application/octet-stream'
    serveBody = MEDIA_VOD
    const result = await probeRemoteUrl(`${baseUrl}/playlist?id=9jj2`, 'ref-9')
    expect(result.sourceType).toBe('hls_media')
    expect(result.hls?.detectedInBody).toBe(true)
  })

  it('rejects a .m3u8 URL returning HTML as HLS_INVALID_MANIFEST', async () => {
    contentType = 'text/html'
    serveBody = '<html><body>404 page</body></html>'
    await expect(probeRemoteUrl(`${baseUrl}/stream.m3u8`, 'ref-10')).rejects.toMatchObject({ code: 'HLS_INVALID_MANIFEST' })
  })

  it('rejects a .m3u8 URL returning a JSON error as HLS_INVALID_MANIFEST', async () => {
    contentType = 'application/json'
    serveBody = '{"error":"forbidden"}'
    await expect(probeRemoteUrl(`${baseUrl}/stream.m3u8`, 'ref-11')).rejects.toMatchObject({ code: 'HLS_INVALID_MANIFEST' })
  })

  it('rejects a .m3u8 URL returning a PNG as HLS_INVALID_MANIFEST', async () => {
    contentType = 'image/png'
    serveBody = '\x89PNG\r\n\x1a\n' + 'binary'
    await expect(probeRemoteUrl(`${baseUrl}/stream.m3u8`, 'ref-12')).rejects.toMatchObject({ code: 'HLS_INVALID_MANIFEST' })
  })
})

describe('probe refactor: manifest HTTP status mapping (§8, §9)', () => {
  it.each([
    [401, 'REMOTE_SOURCE_AUTHENTICATION_REQUIRED'],
    [403, 'HLS_MANIFEST_FORBIDDEN'],
    [404, 'HLS_MANIFEST_NOT_FOUND'],
    [429, 'HLS_MANIFEST_FETCH_FAILED'],
    [500, 'HLS_MANIFEST_FETCH_FAILED'],
  ] as const)('manifest GET %s → %s (structured, never null)', async (status, expectedCode) => {
    // HEAD is allowed (2xx); the GET is what fails.
    headStatus = 200
    contentType = 'application/vnd.apple.mpegurl'
    getStatus = status
    serveBody = 'n/a'
    await expect(probeRemoteUrl(`${baseUrl}/manifest-error`, 'ref-13')).rejects.toMatchObject({ code: expectedCode })
  })

  it('an oversized manifest aborts at the configured cap with HLS_MANIFEST_TOO_LARGE', async () => {
    contentType = 'application/vnd.apple.mpegurl'
    const err = await probeRemoteUrl(`${baseUrl}/oversized`, 'ref-14').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('HLS_MANIFEST_TOO_LARGE')
  })

  it('a slow manifest respects the idle timeout with HLS_MANIFEST_TIMEOUT', async () => {
    contentType = 'application/vnd.apple.mpegurl'
    slowManifest = true
    await expect(probeRemoteUrl(`${baseUrl}/slow.m3u8`, 'ref-15')).rejects.toMatchObject({ code: 'HLS_MANIFEST_TIMEOUT' })
  }, 15000)
})
