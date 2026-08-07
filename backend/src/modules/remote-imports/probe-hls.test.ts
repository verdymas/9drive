import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { AddressInfo } from 'node:net'

/**
 * Probe HLS-detection tests (§3): an HLS source is detected from the FINAL
 * response content-type, a `.m3u8`-looking final URL, OR the body prefix —
 * even when the URL has no `.m3u8` extension. SSRF is mocked as in
 * probe.test.ts; the real fetch + parse path runs live.
 *
 * Server model (mirrors real servers):
 *   - HEAD: only headers; the Range test returns a cheap headers-only response
 *     for the sampled-prefix path, so the octet-stream HLS-body case behaves
 *     like a server that ignores Range on GET.
 *   - GET WITHOUT a Range header: the FULL response body (`serveBody`) is
 *     served — this is what `fetchManifest` re-fetches for classification.
 *   - GET WITH `Range: bytes=0-0`: `206` + 1 byte, so a range-honouring server
 *     never yields a whole HLS body to the probe ("no body hint").
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

let server: http.Server
let baseUrl: string
let contentType = 'application/octet-stream'
/** Body served to a full (non-ranged) GET — the classification re-fetch. */
let serveBody = ''
/** True: ignore the Range header and stream the full body (probe aborts after 1 chunk). */
let ignoresRange = true

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': contentType })
      res.end()
      return
    }
    const ranged = Boolean(req.headers.range)
    if (ranged && !ignoresRange) {
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes 0-0/${Math.max(serveBody.length, 1)}`,
        'Content-Length': '1',
        'Accept-Ranges': 'bytes',
      })
      res.end(Buffer.from(serveBody.slice(0, 1)))
      return
    }
    // Range ignored (or absent): serve the whole body. The probe reads only
    // the first chunk and aborts — the full file is never downloaded.
    res.writeHead(200, { 'Content-Type': contentType })
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
  contentType = 'application/octet-stream'
  serveBody = 'not a playlist'
  ignoresRange = true
})

afterAll(async () => {
  server?.close()
})

describe('probeRemoteUrl HLS detection', () => {
  it('classifies a master playlist via content-type even without .m3u8 extension', async () => {
    contentType = 'application/vnd.apple.mpegurl'
    serveBody = MASTER
    const result = await probeRemoteUrl(`${baseUrl}/asset/7f3a`, 'corr-hls-1')
    expect(result.sourceType).toBe('hls_master')
    expect(result.hls?.sourceType).toBe('hls_master')
    expect(result.hls?.variants).toHaveLength(2)
    // Server-side child URLs are never serialized.
    expect(JSON.stringify(result.hls?.variants)).not.toContain('index.m3u8')
    expect(result.hls?.variants[1]?.height).toBe(1080)
  })

  it('classifies a media playlist via body detection when the URL has no extension', async () => {
    // No HLS content-type, generic octet-stream — but the BODY is HLS.
    contentType = 'application/octet-stream'
    serveBody = MEDIA_VOD
    const result = await probeRemoteUrl(`${baseUrl}/playlist?id=9jj2`, 'corr-hls-2')
    expect(result.sourceType).toBe('hls_media')
    expect(result.hls?.isFinite).toBe(true)
    expect(result.hls?.playlistType).toBe('vod')
    expect(result.hls?.durationSeconds).toBe(12)
    expect(result.hls?.detectedInBody).toBe(true)
  })

  it('detects via the .m3u8 URL suffix', async () => {
    serveBody = MEDIA_VOD
    const result = await probeRemoteUrl(`${baseUrl}/stream.m3u8`, 'corr-hls-3')
    expect(result.sourceType).toBe('hls_media')
  })

  it('stays direct_file for a plain binary with no HLS hints', async () => {
    serveBody = 'PK\x03\x04 this is a zip payload'
    const result = await probeRemoteUrl(`${baseUrl}/archive.zip`, 'corr-hls-4')
    expect(result.sourceType).toBe('direct_file')
    expect(result.hls).toBeNull()
  })

  it('stays direct_file for an MP3-type M3U (plain M3U, no HLS tags)', async () => {
    // `audio/x-mpegurl` is an HLS content-type, but the body is an ordinary
    // MP3 M3U — classification must come from the BODY, not the header.
    contentType = 'audio/x-mpegurl'
    serveBody = '#EXTM3U\n#EXTINF:300,\nfile.mp3'
    const result = await probeRemoteUrl(`${baseUrl}/audio`, 'corr-hls-5')
    expect(result.sourceType).toBe('direct_file')
    expect(result.hls).toBeNull()
  })
})