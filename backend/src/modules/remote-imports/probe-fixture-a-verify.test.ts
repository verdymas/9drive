import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Fixture server A — manual-verification step from the refactor plan (spec
 * §23): `HEAD → 403`, `GET → 200 valid HLS master`. Runs the REAL
 * url-downloader + probe against a live 127.0.0.1 server (SSRF mocked exactly
 * like probe-refactor.test.ts — loopback is blocklisted by design).
 *
 * Proof targets:
 *   - HEAD 403 is logged as `head_rejected` and never as `HEAD ok`,
 *   - exactly ONE bounded manifest GET (the ranged 0-0 GET plus the manifest
 *     GET = 2 GETs total; the manifest is fetched once, on the real URL),
 *   - the result is `hls_master` with 2 variants, `hls` never null.
 * `npx vitest run probe-fixture-a-verify.test.ts` and read the "exact log
 * lines" block printed by the test body.
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

/** (method, path, hasRange) triples the server saw — the raw network evidence. */
const seenRequests: Array<{ method: string; path: string; range: boolean }> = []

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seenRequests.push({ method: req.method ?? '', path: url.pathname, range: Boolean(req.headers.range) })
    if (req.method === 'HEAD') {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end()
      return
    }
    if (url.pathname === '/final/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end(Buffer.from(MASTER))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end('')
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
  seenRequests.length = 0
})

afterAll(async () => {
  server?.close()
})

describe('fixture A: HEAD→403, GET→200 HLS (manual verification)', () => {
  it('falls back to GET, runs exactly one manifest GET, returns hls_master; never logs HEAD ok', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(String(msg))
      // instructed to silence — we re-print the captured lines below
      return undefined
    })
    let result: Awaited<ReturnType<typeof probeRemoteUrl>>
    try {
      result = await probeRemoteUrl(`${baseUrl}/final/master.m3u8`, 'manual-a')
    } finally {
      logSpy.mockRestore()
    }

    // ── THE MANUAL OBSERVATION ─────────────────────────────────────────────
    console.log('\n=== fixture A: exact log lines observed ===')
    for (const line of logs) console.log(`  ${line}`)
    console.log(`=== network evidence: ${seenRequests.length} request(s) ===`)
    for (const req of seenRequests) console.log(`  ${req.method} ${req.path}${req.range ? ' (Range: bytes=0-0)' : ''}`)
    console.log('==============================================')

    // ── Assertions ─────────────────────────────────────────────────────────
    expect(result.sourceType).toBe('hls_master')
    expect(result.hls?.variants).toHaveLength(2)
    expect(result.hls).not.toBeNull()

    const networkGetManifest = seenRequests.filter((r) => r.method === 'GET' && !r.range)
    const networkGetRanged = seenRequests.filter((r) => r.method === 'GET' && r.range)
    const networkHead = seenRequests.filter((r) => r.method === 'HEAD')

    // HEAD was attempted once (403) and fell through to GET.
    expect(networkHead).toHaveLength(1)
    // The `.m3u8` URL hint fires from the HEAD response itself → the flow
    // skips the ranged sample and goes straight to the ONE bounded manifest
    // GET (no ranged GET, no duplicate manifest fetch).
    expect(networkGetRanged).toHaveLength(0)
    expect(networkGetManifest).toHaveLength(1)

    // Exact log line semantics (§8): 403 → head_rejected, never HEAD ok.
    expect(logs.some((l) => l.includes('head_rejected') && l.includes('status=403'))).toBe(true)
    expect(logs.some((l) => l.includes('HEAD ok'))).toBe(false)
    expect(logs.some((l) => l.includes('head_success'))).toBe(false)
    // manifest GET count in the logs is exactly one; it parsed as a master.
    expect(logs.filter((l) => l.includes('HLS parsed')).length).toBe(1)
    expect(logs.some((l) => l.includes('HLS parsed') && l.includes('type=master') && l.includes('variants=2'))).toBe(true)
  })
})