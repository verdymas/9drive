import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Job } from 'bullmq'

/**
 * End-to-end regression (spec case 8): capturedResource.type='hls' must flow
 *   importCapturedResource → probeRemoteUrl → createRemoteImport(sourceType)
 *   → processRemoteImportJob → HLS pipeline (master → variant → segments →
 *   FFmpeg remux) → registered File = remuxed media (.mkv), NEVER the manifest.
 *
 * Reuses the fixture pattern of processor-hls.integration.test.ts: a real
 * local HTTP server serves master/variant/segment playlists; FFmpeg runs for
 * real; only storage + DB boundaries are mocked. Requires FFmpeg; skips
 * cleanly without it.
 */
const hasFfmpeg = () =>
  new Promise<boolean>((resolve) => {
    const child = spawn(envPath().ffmpeg, ['-version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })

function envPath() {
  // Lazy env access (env is imported at module scope below, but paths are
  // resolved lazily so a missing binary never breaks module load).
  return { ffmpeg: process.env.REMOTE_IMPORT_FFMPEG_PATH ?? '/usr/bin/ffmpeg' }
}

// The fixture lives on 127.0.0.1 — mock only the SSRF DNS/validation boundary
// (same approach as processor-hls.integration.test.ts, which also stubs
// resolveAndValidateHost for the direct transport's per-hop re-check).
const validationSpy = vi.hoisted(() => ({
  validateRemoteUrl: vi.fn(),
  resolveAndValidateHost: vi.fn(),
}))
vi.mock('../remote-imports/ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../remote-imports/ssrf.js')>()
  return {
    ...actual,
    validateRemoteUrl: validationSpy.validateRemoteUrl,
    resolveAndValidateHost: validationSpy.resolveAndValidateHost,
  }
})

// Prisma fake covering both the browser-capture service AND the processor.
const h = vi.hoisted(() => {
  const pairings: any[] = []
  const devices: any[] = []
  const resources: any[] = []
  const imports: Record<string, any> = {}
  const files: any[] = []
  let seq = 0

  const matches = (row: any, where: any): boolean => {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (cond === null || cond === undefined || typeof cond !== 'object' || cond instanceof Date) {
        if (row[key] !== cond && !(cond instanceof Date && row[key]?.getTime() === cond.getTime())) return false
        continue
      }
      if (cond.in && !cond.in.includes(row[key])) return false
      if (cond.not !== undefined && row[key] === cond.not) return false
      if (cond.lt !== undefined && !(row[key] < cond.lt)) return false
      if (cond.gt !== undefined && !(row[key] > cond.gt)) return false
    }
    return true
  }

  return {
    pairings, devices, resources, imports, files,
    newId: () => `id-${++seq}`,
    matches,
  }
})

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    browserDevicePairing: {
      create: vi.fn(async ({ data }: any) => { const r = { id: h.newId(), usedAt: null, createdAt: new Date(), ...data }; h.pairings.push(r); return r }),
      findUnique: vi.fn(async ({ where }: any) => h.pairings.find((p) => p.codeHash === where.codeHash) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let n = 0
        for (const p of h.pairings) if (h.matches(p, where)) { Object.assign(p, data); n++ }
        return { count: n }
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    browserDevice: {
      create: vi.fn(async ({ data }: any) => { const r = { id: h.newId(), lastSeenAt: null, revokedAt: null, status: 'active', createdAt: new Date(), updatedAt: new Date(), ...data }; h.devices.push(r); return r }),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async ({ where }: any) => h.devices.find((d) => h.matches(d, where)) ?? null),
      findUnique: vi.fn(async ({ where }: any) => h.devices.find((d) => d.deviceTokenHash === where.deviceTokenHash) ?? null),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    capturedResource: {
      create: vi.fn(async ({ data }: any) => { const r = { id: h.newId(), importedAt: null, detectedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...data }; h.resources.push(r); return r }),
      findFirst: vi.fn(async ({ where }: any) =>
        [...h.resources].sort((a, b) => b.detectedAt - a.detectedAt).find((r) => h.matches(r, where)) ?? null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ where, data }: any) => {
        const row = h.resources.find((r) => r.id === where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let n = 0
        for (const r of h.resources) if (h.matches(r, where)) { Object.assign(r, data); n++ }
        return { count: n }
      }),
      count: vi.fn(async () => 0),
    },
    remoteImport: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: data.id ?? h.newId(), downloadedBytes: 0n, uploadedBytes: 0n, attempt: 1, status: 'queued', stage: 'waiting', jobId: null, queuedAt: null, heartbeatAt: null, fileName: '', retryFromStage: null, fileId: null, ...data }
        h.imports[row.id] = row
        return row
      }),
      findUnique: vi.fn(async ({ where }: any) => h.imports[where.id] ?? null),
      findFirst: vi.fn(async ({ where }: any) => Object.values(h.imports).find((r) => h.matches(r, where)) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = h.imports[where.id]
        if (!row) throw new Error('import not found')
        Object.assign(row, data, { status: data.status ?? row.status })
        return row
      }),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    file: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { const r = { id: h.newId(), sizeBytes: data.sizeBytes, ...data }; h.files.push(r); return r }),
      // The S3 branch creates a provisional 'pending' row then updates it with
      // the REAL provider key — the update must land on the tracked row.
      update: vi.fn(async ({ where, data }: any) => {
        const row = h.files.find((f) => f.id === where.id)
        if (row) Object.assign(row, data)
        return row
      }),
    },
    folder: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    connectedAccount: {
      findMany: vi.fn(async () => []),
      findFirstOrThrow: vi.fn(async ({ where }: any) => ({ id: where.id, provider: 's3' })),
      findFirst: vi.fn(async () => ({ id: 'acc-1', provider: 's3', userId: 'user-1', status: 'connected', storageAccount: { availableBytes: null } })),
      findUniqueOrThrow: vi.fn(async () => ({ id: 'acc-1', provider: 's3' })),
    },
    s3StorageConfig: { findFirst: vi.fn(async () => null), upsert: vi.fn() },
    folderStorageLocation: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    uploadRoutingPolicy: { upsert: vi.fn(async () => ({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })), update: vi.fn() },
    auditLog: { create: vi.fn(async () => undefined) },
    $transaction: vi.fn(),
  },
}))

// Storage boundary: S3 branch, no network.
vi.mock('../s3/s3.service.js', async () => {
  const actual = await vi.importActual<typeof import('../s3/s3.service.js')>('../s3/s3.service.js')
  return {
    ...actual,
    getS3ConfigForAccount: vi.fn(async () => ({ bucket: 'test', region: 'us-east-1', prefix: 'test' })),
    uploadS3Object: vi.fn(async () => undefined),
    buildS3ObjectKey: vi.fn(() => 'provider/object-key.mkv'),
    syncS3Quota: vi.fn(async () => undefined),
  }
})

vi.mock('../storage/provider-folder.service.js', () => ({
  ensureProviderRoot: vi.fn(async () => 'ROOT'),
}))
vi.mock('../uploads/storage-routing.service.js', () => ({
  selectAccount: vi.fn(async () => ({ id: 'acc-1', provider: 's3' })),
  planBatchUploads: vi.fn(),
}))
vi.mock('../google/google.service.js', () => ({
  ensureGoogleAppFolder: vi.fn(async () => 'app-folder'),
  getAuthedGoogleClient: vi.fn(async () => ({})),
  syncGoogleQuota: vi.fn(async () => undefined),
}))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn(async () => undefined) }))
// No Redis in unit-land: capture enqueue and drive the job directly.
const queueSpy = vi.hoisted(() => ({ enqueued: [] as Array<{ id: string; attempt: number }> }))
vi.mock('../remote-imports/queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../remote-imports/queue.js')>()
  return {
    ...actual,
    enqueueRemoteImport: vi.fn(async (importId: string, attempt: number) => {
      queueSpy.enqueued.push({ id: importId, attempt })
      return `${importId}~${attempt}`
    }),
  }
})

import { registerBrowserDevice, createDevicePairing, submitCapturedResource, importCapturedResource } from './browser-capture.service.js'
import { processRemoteImportJob } from '../remote-imports/processor.js'
import type { RemoteImportJobData } from '../remote-imports/queue.js'
import { env } from '../../config/env.js'

let server: http.Server
let baseUrl = ''
let fixtureDir = ''

beforeAll(async () => {
  if (!(await hasFfmpeg())) return
  // ── Fixture: master → two variants → AES-128 MPEG-TS segments. ────────────
  fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), '9drive-capture-hls-'))
  const key = Buffer.from('0123456789abcdef0123456789abcdef')
  await fsp.writeFile(path.join(fixtureDir, 'key.bin'), key)
  const keyInfo = path.join(fixtureDir, 'key.info')
  await fsp.writeFile(keyInfo, `key.bin\n${path.join(fixtureDir, 'key.bin')}\n`)

  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    spawn(envPath().ffmpeg, args, { stdio: 'ignore' }).on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${args.join(' ')} failed`))))
  })
  await run([
    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-force_key_frames', '0:4',
    '-c:a', 'aac', '-f', 'hls',
    '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_key_info_file', keyInfo,
    '-hls_segment_filename', path.join(fixtureDir, 'seg%d.ts'),
    path.join(fixtureDir, 'media.m3u8'),
  ])
  const mediaBody = await fsp.readFile(path.join(fixtureDir, 'media.m3u8'), 'utf8')
  const mediaLines = mediaBody.split('\n').filter((l) => l.endsWith('.ts'))

  server = http.createServer((req, res) => {
    const urlPath = (req.url ?? '').split('?')[0]
    if (urlPath === '/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n${baseUrl}/media.m3u8\n`)
      return
    }
    if (urlPath === '/media.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(mediaBody.replaceAll(/seg\d+\.ts/g, (m) => `${baseUrl}/${m}`))
      return
    }
    if (urlPath.startsWith('/seg')) {
      fsp.readFile(path.join(fixtureDir, path.basename(urlPath))).then((b) => {
        res.writeHead(200, { 'content-type': 'video/mp2t' })
        res.end(b)
      }).catch(() => { res.writeHead(404); res.end() })
      return
    }
    if (urlPath === '/key.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(key)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  void mediaLines
})

afterAll(async () => {
  server?.close()
  if (fixtureDir) await fsp.rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('captured HLS → Remote Import → remux (e2e)', () => {
  it('type=hls → sourceType=hls_master → FFmpeg remux → .mkv File registered', async () => {
    if (!fixtureDir) return // skipped (no ffmpeg)

    // SSRF gate allows the loopback fixture.
    validationSpy.validateRemoteUrl.mockReset()
    validationSpy.resolveAndValidateHost.mockReset()
    validationSpy.validateRemoteUrl.mockImplementation(async (raw: string) => new URL(raw))
    validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => host)

    // 1. Pair a device and submit an HLS capture pointing at the fixture.
    const pairing = await createDevicePairing('user-1')
    await registerBrowserDevice({ pairingCode: pairing.code, name: 'test', browser: 'chrome', platform: 'win32' })
    const resource = await submitCapturedResource({
      deviceId: h.devices[0].id,
      userId: 'user-1',
      url: `${baseUrl}/master.m3u8`,
      type: 'hls',
      mimeType: 'application/vnd.apple.mpegurl',
    })

    // 2. Import through the REAL service (real probeRemoteUrl + createRemoteImport).
    const { remoteImport } = await importCapturedResource('user-1', resource.id, {})
    expect(remoteImport.sourceType).toBe('hls_master')
    expect(h.files.length).toBe(0) // nothing uploaded yet — just queued

    // 3. Drive the REAL processor with a fake BullMQ Job.
    const job = { data: { importId: remoteImport.id, attempt: 1 }, id: 'job-1' } as unknown as Job<RemoteImportJobData>
    await processRemoteImportJob(job)

    // 4. The registered file is the REMUXED MEDIA, not the manifest.
    const stored = h.imports[remoteImport.id]
    expect(stored.status).toBe('completed')
    const file = h.files[0]
    expect(file.name.endsWith('.mkv')).toBe(true)          // default container mkv
    expect(file.mimeType).toMatch(/^video\//)              // manifest MIME replaced by derived video/*
    expect(file.providerFileId).toContain('provider/object-key')
    // The remuxed output had real bytes (tracked on the import row; the S3
    // provisional File row itself keeps sizeBytes=0 — pre-existing behavior).
    expect(stored.uploadedBytes).toBeGreaterThan(0n)
    expect(stored.uploadTotalBytes).toBe(stored.uploadedBytes)
  }, 120_000)

  it('custom filename movie.mkv survives to the stored object', async () => {
    if (!fixtureDir) return
    validationSpy.validateRemoteUrl.mockImplementation(async (raw: string) => new URL(raw))
    validationSpy.resolveAndValidateHost.mockImplementation(async (host: string) => host)

    const pairing = await createDevicePairing('user-1')
    await registerBrowserDevice({ pairingCode: pairing.code, name: 'test2', browser: 'chrome', platform: 'win32' })
    const resource = await submitCapturedResource({
      deviceId: h.devices[h.devices.length - 1].id,
      userId: 'user-1',
      url: `${baseUrl}/master.m3u8`,
      type: 'hls',
    })
    h.files.length = 0
    const { remoteImport } = await importCapturedResource('user-1', resource.id, { filename: 'movie.mkv' })
    const job = { data: { importId: remoteImport.id, attempt: 1 }, id: 'job-2' } as unknown as Job<RemoteImportJobData>
    await processRemoteImportJob(job)

    expect(h.imports[remoteImport.id].status).toBe('completed')
    expect(h.files[0]?.name).toBe('movie.mkv')
  }, 120_000)
})
