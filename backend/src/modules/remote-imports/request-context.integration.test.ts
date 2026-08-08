import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Job } from 'bullmq'
import { prisma } from '../../config/prisma.js'
import { processRemoteImportJob } from './processor.js'
import type { RemoteImportJobData } from './queue.js'
import { env } from '../../config/env.js'
import { hlsJobDir } from './hls/job-dir.js'
import { parseCurl } from './curl-parser.js'
import { probeRemoteUrl } from './probe.js'
import { encryptRequestContext } from './request-context.js'

/**
 * Mandatory integration fixtures for the Remote Import request-context feature
 * (spec §32–§35): protected-HLS fixture, paste-as-cURL end-to-end, cookie-leak
 * regression across two hosts, and signed-URL + context.
 *
 * Fixture topology:
 *   server A (127.0.0.1:portA) — the "protected" source host.
 *     /protected/master.m3u8      → 403 without Referer+Cookie; valid master
 *                                    with them. Children also gated.
 *     /protected/720.m3u8         → media playlist (gated the same way).
 *     /protected/seg0.ts|seg1.ts  → AES-128 segments (gated the same way).
 *     /protected/key.bin          → the AES key (gated the same way).
 *     /protected/plain.m3u8       → UNGATED media playlist (fixture C segments).
 *     /signed.m3u8                → 403 without `?token=abc` AND Referer.
 *   server B (127.0.0.1:portB, a DIFFERENT port = a different origin) — the
 *     cross-host segment host for the cookie-leak regression (§34).
 *     /seg0.ts|seg1.ts /key.bin   → same fixture bytes, but cross-origin.
 *
 * Real FFmpeg is required (same skip as processor-hls.integration.test.ts);
 * prisma/SSRF are mocked exactly like that suite.
 */
const hasFfmpeg = () =>
  new Promise<boolean>((resolve) => {
    const child = spawn(env.REMOTE_IMPORT_FFMPEG_PATH, ['-version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })

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

// ── Prisma mock: identical shape to processor-hls.integration.test.ts. ──────
const createdFile = { id: 'file-' + Date.now(), providerFileId: '', name: '' }

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    remoteImport: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => mockRow(where.id)),
      update: vi.fn(async ({ data }: { data: any }) => ({ ...mockRow(data.id), ...data, status: data.status ?? 'processing' })),
    },
    folder: { findFirst: vi.fn(async () => null) },
    connectedAccount: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'acc-1', provider: 's3' })),
      findFirst: vi.fn(async () => ({ id: 'acc-1', provider: 's3', storageAccount: { availableBytes: null } })),
    },
    folderStorageLocation: { findMany: vi.fn(async () => []) },
    file: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: any }) => {
        createdFile.providerFileId = data.providerFileId
        createdFile.name = data.name
        return { ...createdFile, sizeBytes: data.sizeBytes }
      }),
      update: vi.fn(async ({ data }: { data: any }) => {
        if (data.providerFileId && data.providerFileId !== 'pending') createdFile.providerFileId = data.providerFileId
        return { ...createdFile, ...data }
      }),
    },
  },
}))

vi.mock('../s3/s3.service.js', () => ({
  getS3ConfigForAccount: vi.fn(async () => ({ bucket: 'test', region: 'us-east-1', prefix: 'test' })),
  uploadS3Object: vi.fn(async () => undefined),
  buildS3ObjectKey: vi.fn(() => 'provider/object-key.mkv'),
  syncS3Quota: vi.fn(async () => undefined),
  getS3PresignedUrl: vi.fn(async () => ''),
}))

vi.mock('../storage/provider-folder.service.js', () => ({
  ensureProviderRoot: vi.fn(async () => 'ROOT'),
}))

vi.mock('../uploads/storage-routing.service.js', () => ({
  selectAccount: vi.fn(async () => ({ id: 'acc-1', provider: 's3' })),
}))

vi.mock('../google/google.service.js', () => ({
  ensureGoogleAppFolder: vi.fn(async () => 'app-folder'),
  getAuthedGoogleClient: vi.fn(async () => ({})),
  syncGoogleQuota: vi.fn(async () => undefined),
}))

vi.mock('../../utils/audit.js', () => ({
  createAuditLog: vi.fn(async () => undefined),
}))

function mockRow(id: string) {
  return {
    id,
    userId: 'user-1',
    folderId: null,
    connectedAccountId: 'acc-1',
    fileName: 'movie.mkv',
    mimeType: 'application/vnd.apple.mpegurl',
    sourceType: 'hls_master',
    hlsVariantId: null,
    hlsAudioTrackId: null,
    hlsOutputContainer: 'auto',
    hlsIsLive: false,
    hlsRecordingDurationSeconds: null,
    sourceUrlEncrypted: '',
    requestContextEncrypted: null,
    status: 'queued',
    stage: 'waiting',
    totalBytes: null,
    downloadedBytes: 0n,
    uploadedBytes: 0n,
  }
}

// ── Fixture generation (real AES-128 segments via FFmpeg, same as the HLS
// integration suite — we reuse the exact generation commands). ───────────────
let fixtureDir: string
let segment0Bytes: Buffer
let segment1Bytes: Buffer
let plainSegBytes: Buffer[] = []
let masterBody = ''
let protectedMediaBody = ''
let plainMediaBody = ''

// Every request each fixture server received — the cookie-leak regression
// asserts on these (host A gets Cookie, host B does NOT).
let serverARequests: Array<Record<string, string>> = []
let serverBRequests: Array<Record<string, string>> = []

const REFERER = 'https://site.example/watch/1'
const COOKIE = 'session=valid'
const TOKEN = 'abc'
const USER_AGENT = 'Mozilla/5.0 Test'

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(env.REMOTE_IMPORT_FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-500)}`))))
  })
}

/** Gated request: a protected resource needs Referer + Cookie (spec §32). */
function isAuthorized(req: http.IncomingMessage): boolean {
  return req.headers.referer === REFERER && req.headers.cookie === COOKIE
}

async function generateFixture() {
  fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), '9drive-ctx-fixture-'))
  const key = Buffer.from('0123456789abcdef0123456789abcdef')
  await fsp.writeFile(path.join(fixtureDir, 'key.bin'), key)
  const keyInfoPath = path.join(fixtureDir, 'key.info')
  await fsp.writeFile(keyInfoPath, `key.bin\n${path.join(fixtureDir, 'key.bin')}\n`)

  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-force_key_frames', '0:2,0:4,0:6',
    '-c:a', 'aac', '-f', 'hls',
    '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(fixtureDir, 'seg%d.ts'),
    '-hls_key_info_file', keyInfoPath,
    path.join(fixtureDir, 'fixture.m3u8'),
  ])
  segment0Bytes = await fsp.readFile(path.join(fixtureDir, 'seg0.ts'))
  segment1Bytes = await fsp.readFile(path.join(fixtureDir, 'seg1.ts'))

  // Fixture C: UNENCRYPTED plain MPEG-TS (the raw-concat-friendly shape).
  const plainOut = path.join(fixtureDir, 'plain.m3u8')
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-force_key_frames', '0:2,0:4,0:6',
    '-c:a', 'aac', '-f', 'hls',
    '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(fixtureDir, 'pseg%d.ts'),
    plainOut,
  ])
  plainMediaBody = await fsp.readFile(plainOut, 'utf8')
  const psegFiles = (await fsp.readdir(fixtureDir))
    .filter((f) => f.startsWith('pseg') && f.endsWith('.ts'))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  plainSegBytes = await Promise.all(psegFiles.map((f) => fsp.readFile(path.join(fixtureDir, f))))
  if (plainMediaBody.includes('#EXT-X-KEY')) throw new Error('Fixture C unexpectedly encrypted')
}

let serverA: http.Server
let serverB: http.Server
let baseUrlA: string
let baseUrlB: string

beforeAll(async () => {
  if (!(await hasFfmpeg())) {
    console.warn('Skipping request-context integration test: ffmpeg not available.')
    return
  }
  validationSpy.validateRemoteUrl.mockImplementation(async (raw: string) => new URL(raw))
  validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => host)
  await generateFixture()

  // ── Server A — the protected source host (127.0.0.1:portA). ───────────────
  serverA = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const headers: Record<string, string> = { path: url.pathname }
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v)
    serverARequests.push(headers)

    const pathname = url.pathname
    const authorized = isAuthorized(req)

    // Protected master: 403 without the request context.
    if (pathname === '/protected/master.m3u8') {
      if (!authorized) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end(masterBody)
      return
    }
    // Protected child playlist + segments + key: all gated the same way.
    if (pathname === '/protected/720.m3u8' || pathname === '/protected/360.m3u8') {
      if (!authorized) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end(protectedMediaBody)
      return
    }
    if (pathname === '/protected/seg0.ts') {
      if (!authorized) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      res.end(segment0Bytes)
      return
    }
    if (pathname === '/protected/seg1.ts') {
      if (!authorized) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      res.end(segment1Bytes)
      return
    }
    if (pathname === '/protected/key.bin') {
      if (!authorized) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(Buffer.from('0123456789abcdef0123456789abcdef'))
      return
    }

    // Ungated media playlist (fixture C, raw-concat capable).
    if (pathname === '/protected/plain.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end(plainMediaBody)
      return
    }
    if (pathname.startsWith('/protected/pseg')) {
      const idx = Number(pathname.match(/pseg(\d+)\.ts/)?.[1] ?? -1)
      const bytes = plainSegBytes[idx]
      if (!bytes) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      res.end(bytes)
      return
    }

    // Signed URL fixture (§35): needs `?token=abc` AND the Referer.
    if (pathname === '/signed.m3u8') {
      const hasToken = url.searchParams.get('token') === TOKEN
      if (!hasToken || req.headers.referer !== REFERER) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('forbidden')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end(protectedMediaBody)
      return
    }

    console.warn('[ctx-fixture-serverA] 404:', pathname)
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', resolve))
  baseUrlA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`

  // ── Server B — the cross-host segment server (§34). DIFFERENT port, so a
  // DIFFERENT origin: the source cookie must never reach it. ─────────────────
  serverB = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const headers: Record<string, string> = { path: url.pathname }
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v)
    serverBRequests.push(headers)

    const pathname = url.pathname
    if (pathname === '/seg0.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.end(segment0Bytes); return }
    if (pathname === '/seg1.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.end(segment1Bytes); return }
    if (pathname === '/key.bin') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from('0123456789abcdef0123456789abcdef')); return }
    console.warn('[ctx-fixture-serverB] 404:', pathname)
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', resolve))
  baseUrlB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`

  // ── Playlists embed the server URLs — build AFTER the ports are known. ────
  masterBody = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d001e,mp4a.40.2"
${baseUrlA}/protected/360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
${baseUrlA}/protected/720.m3u8`
  protectedMediaBody = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="${baseUrlA}/protected/key.bin"
#EXTINF:4.000,
${baseUrlA}/protected/seg0.ts
#EXTINF:4.000,
${baseUrlA}/protected/seg1.ts
#EXT-X-ENDLIST`
  // Fixture C body references bare psegN.ts — point them at server A.
  plainMediaBody = plainMediaBody.replaceAll('pseg', `${baseUrlA}/protected/pseg`)
})

afterAll(async () => {
  serverA?.close()
  serverB?.close()
  if (fixtureDir) await fsp.rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined)
})

beforeEach(() => {
  validationSpy.validateRemoteUrl.mockReset()
  validationSpy.resolveAndValidateHost.mockReset()
  validationSpy.validateRemoteUrl.mockImplementation(async (raw: string) => new URL(raw))
  validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => host)
  serverARequests.length = 0
  serverBRequests.length = 0
  const updateMock = prisma.remoteImport.update as ReturnType<typeof vi.fn>
  updateMock.mockClear()
})

/** Run the worker on a row whose source URL + context are encrypted. */
async function runWorker(importId: string, sourceUrl: string, ctx: Record<string, string> | null) {
  const { encryptText } = await import('../../utils/crypto.js')
  const row = mockRow(importId)
  row.sourceUrlEncrypted = encryptText(sourceUrl)
  row.requestContextEncrypted = ctx ? encryptRequestContext(ctx) : null
  prisma.remoteImport.findUnique = vi.fn(async () => row)
  const job = { data: { importId, attempt: 1 }, id: `job-${importId}` } as unknown as Job<RemoteImportJobData>
  await processRemoteImportJob(job)
  return prisma.remoteImport.update as ReturnType<typeof vi.fn>
}

describe('spec §32 — protected-HLS fixture (URL-only fails, URL+context completes)', () => {
  it('URL only → HLS_MANIFEST_FORBIDDEN (probe)', async () => {
    if (!fixtureDir) return
    await expect(probeRemoteUrl(`${baseUrlA}/protected/master.m3u8`, 'corr-32a')).rejects.toMatchObject({
      code: 'HLS_MANIFEST_FORBIDDEN',
    })
    // The forbidden probe must NOT have sent the context (none existed).
    expect(serverARequests.some((h) => h['cookie'])).toBe(false)
  })

  it('URL + context → probe succeeds (master, child playlist, segments all gated)', async () => {
    if (!fixtureDir) return
    const ctx = { referer: REFERER, cookie: COOKIE }
    const probe = await probeRemoteUrl(`${baseUrlA}/protected/master.m3u8`, 'corr-32b', ctx)
    expect(probe.sourceType).toBe('hls_master')
    // Server A received the context on the manifest probe request.
    const masterHit = serverARequests.find((h) => h['referer'] === REFERER && h['cookie'] === COOKIE)
    expect(masterHit).toBeDefined()
  })

  it('URL + context → worker completes: probe → child → segments → remux → completed', async () => {
    if (!fixtureDir) return
    await fsp.rm(hlsJobDir('user-1', 'import-ctx-32'), { recursive: true, force: true }).catch(() => undefined)
    const updateMock = await runWorker('import-ctx-32', `${baseUrlA}/protected/master.m3u8`, { referer: REFERER, cookie: COOKIE })

    const completed = updateMock.mock.calls.some((call) => call[0]?.data?.status === 'completed')
    expect(completed).toBe(true)
    expect(createdFile.name).toBe('movie.mkv')
    // Every protected request (master, child, key, both segments) carried the
    // context; nothing was served 403.
    const authHits = serverARequests.filter((h) => h['referer'] === REFERER && h['cookie'] === COOKIE)
    expect(authHits.length).toBeGreaterThanOrEqual(5)
    // No request to server A lacked the context once the import started.
    const masterPaths = ['/protected/master.m3u8', '/protected/720.m3u8', '/protected/seg0.ts', '/protected/seg1.ts', '/protected/key.bin']
    expect(serverARequests.some((h, i) => masterPaths.some((p) => h['path']?.includes(p)) && !(h['referer'] === REFERER && h['cookie'] === COOKIE))).toBe(false)
  })
})

describe('spec §33 — paste-as-cURL end-to-end (parse → probe → create → worker → remux)', () => {
  it('runs the spec command: parser → probe → worker, and no secret ever leaks to output', async () => {
    if (!fixtureDir) return
    const command = [
      `curl '${baseUrlA}/protected/master.m3u8?token=${TOKEN}' \\`,
      `  -H 'Referer: ${REFERER}' \\`,
      `  -H 'Origin: https://site.example' \\`,
      `  -H 'User-Agent: ${USER_AGENT}' \\`,
      `  -H 'Cookie: ${COOKIE}'`,
    ].join('\n')

    // Capture the entire test output stream (console.log from the processor +
    // vitest reporter alike) so we can assert no secret crosses it.
    const originalLog = console.log
    const captured: string[] = []
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); originalLog(...args) }
    const originalError = console.error
    const errors: string[] = []
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); originalError(...args) }
    try {
      // 1. Parse (the authoritative server-side parse — same function the
      //    /parse-curl endpoint and the create route call).
      const parsed = parseCurl(command)
      expect(parsed.url).toBe(`${baseUrlA}/protected/master.m3u8?token=${TOKEN}`)
      expect(parsed.requestContext).toEqual({
        referer: REFERER,
        origin: 'https://site.example',
        userAgent: USER_AGENT,
        cookie: COOKIE,
      })

      // 2. Probe with the extracted context.
      const probe = await probeRemoteUrl(parsed.url, 'corr-33', parsed.requestContext)
      expect(probe.sourceType).toBe('hls_master')

      // 3. Worker decrypts the context from the DB row (never the job payload)
      //    and drives manifest → child → segments → remux.
      await fsp.rm(hlsJobDir('user-1', 'import-ctx-33'), { recursive: true, force: true }).catch(() => undefined)
      const updateMock = await runWorker('import-ctx-33', parsed.url, parsed.requestContext)
      const completed = updateMock.mock.calls.some((call) => call[0]?.data?.status === 'completed')
      expect(completed).toBe(true)
    } finally {
      console.log = originalLog
      console.error = originalError
    }

    // §33: no Cookie value (and no signed token) in any captured log line.
    const allOutput = [...captured, ...errors].join('\n')
    expect(allOutput).not.toContain(COOKIE)
    expect(allOutput).not.toContain(`token=${TOKEN}`)
  })
})

describe('spec §34 — cookie-leak regression (manifest host gets Cookie, segment host does NOT)', () => {
  it('never forwards the source Cookie to a cross-origin segment host', async () => {
    if (!fixtureDir) return
    // Manifest on server A, segments on server B (different port => different
    // origin key). The child playlist is UNGATED on B (no auth needed) so the
    // pipeline fails for exactly ONE reason: assertChildAccessible refusing to
    // leak the cookie cross-host.
    const crossHostMediaBody = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="${baseUrlB}/key.bin"
#EXTINF:4.000,
${baseUrlB}/seg0.ts
#EXTINF:4.000,
${baseUrlB}/seg1.ts
#EXT-X-ENDLIST`
    const signedMaster = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
${baseUrlA}/protected/720-cross.m3u8`
    // Mount a transient master + cross-host child on server A.
    const realListener = serverA.listeners('request')[0] as (req: http.IncomingMessage, res: http.ServerResponse) => void
    serverA.removeAllListeners('request')
    serverA.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/protected/master-cross.m3u8') {
        const headers: Record<string, string> = { path: url.pathname }
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v)
        serverARequests.push(headers)
        if (req.headers.cookie !== COOKIE) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return }
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        res.end(signedMaster)
        return
      }
      if (url.pathname === '/protected/720-cross.m3u8') {
        const headers: Record<string, string> = { path: url.pathname }
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v)
        serverARequests.push(headers)
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        res.end(crossHostMediaBody)
        return
      }
      realListener(req, res)
    })

    try {
      await fsp.rm(hlsJobDir('user-1', 'import-ctx-34'), { recursive: true, force: true }).catch(() => undefined)
      const updateMock = await runWorker('import-ctx-34', `${baseUrlA}/protected/master-cross.m3u8`, { cookie: COOKIE })

      // The import must FAIL — cross-origin segments with a source cookie are
      // refused by design (assertChildAccessible), never fetched with the leak.
      const failed = updateMock.mock.calls.some((call) => call[0]?.data?.status === 'failed' && call[0]?.data?.errorCode === 'HLS_CHILD_AUTHENTICATION_REQUIRED')
      expect(failed).toBe(true)

      // Server A (the manifest host) received the cookie.
      const aHits = serverARequests.filter((h) => h['path']?.includes('/protected/master-cross') || h['path']?.includes('/protected/720-cross'))
      expect(aHits.length).toBeGreaterThanOrEqual(2)
      expect(aHits.every((h) => h['cookie'] === COOKIE)).toBe(true)
      // Server B (the cross-origin segment host) NEVER received the cookie.
      expect(serverBRequests.length).toBe(0)
    } finally {
      // Restore the original listener for later tests.
      serverA.removeAllListeners('request')
      serverA.on('request', realListener)
    }
  })
})

describe('spec §35 — signed URL + request context', () => {
  it('both ?token and Referer reach the server; neither appears in output', async () => {
    if (!fixtureDir) return
    const url = `${baseUrlA}/signed.m3u8?token=${TOKEN}`

    // Without context → 403 (forbidden).
    await expect(probeRemoteUrl(url, 'corr-35a')).rejects.toMatchObject({ code: 'HLS_MANIFEST_FORBIDDEN' })

    // With the Referer but WITHOUT the token → still 403; a context-bearing
    // 403 maps to REMOTE_SOURCE_ACCESS_EXPIRED (spec §23), proving the token
    // really is required alongside the context.
    await expect(probeRemoteUrl(`${baseUrlA}/signed.m3u8`, 'corr-35b', { referer: REFERER })).rejects.toMatchObject({
      code: 'REMOTE_SOURCE_ACCESS_EXPIRED',
    })

    const originalLog = console.log
    const captured: string[] = []
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); originalLog(...args) }
    try {
      const probe = await probeRemoteUrl(url, 'corr-35c', { referer: REFERER })
      expect(probe.sourceType).toBe('hls_media')
      // The signed request actually reached the server with the token intact.
      const signedHit = serverARequests.find((h) => h['referer'] === REFERER)
      expect(signedHit).toBeDefined()
    } finally {
      console.log = originalLog
    }
    // Neither the token nor the referer leaks into probe logs.
    expect(captured.join('\n')).not.toContain(`token=${TOKEN}`)
    expect(captured.join('\n')).not.toContain('signed.m3u8')
  })
})

describe('spec §23 — expired context with 401/403 maps to REMOTE_SOURCE_ACCESS_EXPIRED', () => {
  it('probe: URL + stale context on a 403 master → REMOTE_SOURCE_ACCESS_EXPIRED', async () => {
    if (!fixtureDir) return
    // The fixture requires `session=valid`; a stale `session=expired` still 403s.
    await expect(
      probeRemoteUrl(`${baseUrlA}/protected/master.m3u8`, 'corr-exp', { referer: REFERER, cookie: 'session=expired' }),
    ).rejects.toMatchObject({ code: 'REMOTE_SOURCE_ACCESS_EXPIRED' })
  })

  it('worker: URL + stale context → failed with REMOTE_SOURCE_ACCESS_EXPIRED', async () => {
    if (!fixtureDir) return
    await fsp.rm(hlsJobDir('user-1', 'import-ctx-exp'), { recursive: true, force: true }).catch(() => undefined)
    const updateMock = await runWorker('import-ctx-exp', `${baseUrlA}/protected/master.m3u8`, { referer: REFERER, cookie: 'session=expired' })
    const failed = updateMock.mock.calls.some((call) => call[0]?.data?.status === 'failed' && call[0]?.data?.errorCode === 'REMOTE_SOURCE_ACCESS_EXPIRED')
    expect(failed).toBe(true)
  })
})
