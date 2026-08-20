import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import type { Job } from 'bullmq'
import { processRemoteImportJob } from './processor.js'
import type { RemoteImportJobData } from './queue.js'
import { AppError } from '../../utils/app-error.js'

// ── Mocks ────────────────────────────────────────────────────────────────────
// Drive the DIRECT import path through the real `processRemoteImportJob` while
// mocking everything below the placement seam: the downloader, the uploader,
// prisma, and `resolveUploadPlacement` itself (spec §44 — both direct and HLS
// imports route through the SAME placement service).
//
// The processor's local `downloadToTemp` streams the remote body into a real
// temp file under REMOTE_IMPORT_TEMP_DIR (the mock's `appendStreamToTemp`
// writes through to disk), so a per-run scratch dir is created and removed in
// beforeAll/afterAll. `google.service` must be mocked too — `syncGoogleQuota`
// is fire-and-forget after a completed import and would otherwise try to
// refresh real tokens.
let scratchDir: string
const h = vi.hoisted(() => {
  const now = new Date('2026-08-07T00:00:00.000Z')
  const baseRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'import-1',
    userId: 'user-1',
    folderId: 'movies',
    connectedAccountId: null,
    fileName: 'movie.mkv',
    mimeType: 'video/x-matroska',
    sourceType: 'direct',
    sourceUrlEncrypted: 'encrypted:https://example.com/movie.mkv',
    status: 'queued',
    stage: 'waiting',
    totalBytes: 1000n,
    downloadedBytes: 0n,
    uploadedBytes: 0n,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })

  const prismaMock = {
    remoteImport: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.rows.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const current = h.rows.get(where.id) ?? baseRow()
        const next = { ...current, ...data }
        h.rows.set(where.id, next)
        return next
      }),
    },
    remoteFetchWorker: {
      findFirst: vi.fn(async () => null),
    },
    connectedAccount: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'acc-b', provider: 'google_drive' })),
    },
    file: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: any }) => ({ id: 'file-1', ...data })),
      update: vi.fn(async ({ data }: { data: any }) => ({ id: 'file-1', ...data })),
    },
  }

  return {
    prismaMock,
    rows: new Map<string, ReturnType<typeof baseRow>>(),
    baseRow,
    resolvePlacement: vi.fn(),
    downloader: vi.fn(),
    googleUploader: vi.fn(async () => ({ providerFileId: 'drive-file-1', name: 'movie.mkv', mimeType: 'video/x-matroska', sizeBytes: 1000n })),
    audit: vi.fn(async () => undefined),
    s3UploadSpy: vi.fn(async () => undefined),
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

vi.mock('../storage/upload-placement.service.js', () => ({
  resolveUploadPlacement: h.resolvePlacement,
}))

// The REAL processor `downloadToTemp` calls `followRemoteUrl` and streams the
// response body into the temp file — the mock must hand back a real async
// iterable so the `for await` loop completes and `content-length` is seen.
vi.mock('./url-downloader.js', () => ({
  followRemoteUrl: vi.fn(async (_url: string, options: { onResponse: (res: any, finalUrl: string) => Promise<unknown> }) => {
    const result = await options.onResponse(
      {
        statusCode: 200,
        headers: { 'content-length': '1000', 'accept-ranges': 'bytes' },
        body: {
          [Symbol.asyncIterator]: async function* () {
            yield new Uint8Array([1, 2, 3])
          },
        },
      },
      'https://example.com/movie.mkv',
    )
    return { result, finalUrl: 'https://example.com/movie.mkv', redirectCount: 0 }
  }),
}))

vi.mock('./ssrf.js', () => ({
  validateRemoteUrl: vi.fn(async () => undefined),
  resolveAndValidateHost: vi.fn(async () => undefined),
}))

vi.mock('./temp-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./temp-storage.js')>()
  return {
    // The processor's local `downloadToTemp` streams the body into a REAL
    // temp file under REMOTE_IMPORT_TEMP_DIR — keep the real path helpers and
    // the append stream so the file is actually written, and mock only the
    // import-keyed convenience wrappers that fake the file existence.
    tempFilePath: (id: string) => path.join(scratchDir, `${id}.part`),
    finalTempFilePath: (id: string) => path.join(scratchDir, `${id}.download`),
    appendStreamToTemp: (filePath: string) => actual.appendStreamToTemp(filePath),
    createTempPartFile: vi.fn(async (id: string) => {
      const filePath = path.join(scratchDir, `${id}.part`)
      await fsp.writeFile(filePath, Buffer.alloc(0), { flag: 'w' })
      return filePath
    }),
    removeTempFile: vi.fn(async (id: string) => {
      await fsp.rm(path.join(scratchDir, `${id}.part`), { force: true }).catch(() => undefined)
      await fsp.rm(path.join(scratchDir, `${id}.download`), { force: true }).catch(() => undefined)
    }),
    ensureTempDir: vi.fn(async () => fsp.mkdir(scratchDir, { recursive: true })),
    sweepStaleTempFiles: vi.fn(async () => undefined),
    startTempSweeper: vi.fn(),
  }
})

vi.mock('./google-resumable-uploader.js', () => ({
  uploadToGoogleResumable: (...args: unknown[]) => h.googleUploader(...args),
}))

vi.mock('../../utils/crypto.js', () => ({
  decryptText: vi.fn(() => 'https://example.com/movie.mkv'),
  encryptText: vi.fn((text: string) => `encrypted:${text}`),
}))

vi.mock('../../utils/audit.js', () => ({
  createAuditLog: (...args: unknown[]) => h.audit(...args),
}))

vi.mock('../remote-fetch-workers/driver-registry.js', () => ({
  hasDriver: (key: string) => key === 'cloudflare' || key === 'test-relay',
}))

vi.mock('../google/google.service.js', () => ({
  ensureGoogleAppFolder: vi.fn(async () => 'app-folder'),
  getAuthedGoogleClient: vi.fn(async () => ({})),
  syncGoogleQuota: vi.fn(async () => undefined),
}))

vi.mock('../s3/s3.service.js', () => ({
  getS3ConfigForAccount: vi.fn(async () => ({ bucket: 'test', region: 'us-east-1' })),
  uploadS3Object: (...args: unknown[]) => h.s3UploadSpy(...args),
  buildS3ObjectKey: vi.fn(() => 'provider/object-key.mkv'),
  syncS3Quota: vi.fn(async () => undefined),
}))

// Import AFTER mocks (vi.mock hoists).
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'

function reset() {
  vi.clearAllMocks()
  h.rows.clear()
  h.rows.set('import-1', h.baseRow())
}

beforeAll(async () => {
  scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), '9drive-placement-'))
})

afterAll(async () => {
  await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined)
})

function job() {
  return { id: 'job-1', data: { importId: 'import-1' } } as Job<RemoteImportJobData>
}

function account(id: string, provider: string) {
  return {
    id,
    userId: 'user-1',
    providerConfigId: null,
    provider,
    providerAccountId: `${provider}-${id}`,
    email: `${id}@example.com`,
    displayName: null,
    avatarUrl: null,
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    scopes: [],
    status: 'connected',
    lastError: null,
    createdAt: new Date('2026-08-07T00:00:00.000Z'),
    updatedAt: new Date('2026-08-07T00:00:00.000Z'),
  }
}

describe('processRemoteImportJob — placement routing (direct)', () => {
  beforeEach(reset)

  it('routes through resolveUploadPlacement and registers the file on the placed account with the virtual folderId', async () => {
    const accA = account('acc-a', 'google_drive')
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: accA,
      folderStorageLocation: { id: 'loc-movies-a', folderId: 'movies', connectedAccountId: 'acc-a', provider: 'google_drive', providerFolderId: 'drive-movies-a' },
    })
    h.downloader.mockResolvedValue({ finalUrl: 'https://example.com/movie.mkv', tempPartPath: '/tmp/import-1.part', contentLength: 1000n, supportsRange: true })

    await processRemoteImportJob(job())

    // Placement was consulted with the virtual folder + no pin (Automatic).
    expect(resolveUploadPlacement).toHaveBeenCalledWith('user-1', 'movies', null, 1000n, undefined, 'remote-import')
    // The registered file keeps the VIRTUAL folder id.
    const createCalls = (h.prismaMock.file.create as ReturnType<typeof vi.fn>).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)
    expect(createCalls[0][0].data.folderId).toBe('movies')
    expect(createCalls[0][0].data.connectedAccountId).toBe('acc-a')
    // Import completed.
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.status).toBe('completed')
  })

  it('fails with NO_ACCOUNT_WITH_ENOUGH_SPACE when Automatic has no eligible account', async () => {
    h.resolvePlacement.mockRejectedValue(new AppError('AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT', 'No connected storage account has enough space for this upload.', 400))
    await processRemoteImportJob(job())
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.status).toBe('failed')
    expect(finalRow.errorCode).toBe('NO_ACCOUNT_WITH_ENOUGH_SPACE')
    expect(h.downloader).not.toHaveBeenCalled()
  })

  it('GOOGLE_REAUTH_REQUIRED at placement preserves the downloaded .part on disk', async () => {
    h.resolvePlacement.mockRejectedValue(new AppError('GOOGLE_REAUTH_REQUIRED', 'This Google Drive account needs to be reconnected before it can be used.', 401))
    // The downloader writes a real temp part under the scratch dir.
    h.downloader.mockImplementation(async (_url: string) => {
      const partPath = path.join(scratchDir, 'import-1.part')
      await fsp.writeFile(partPath, 'downloaded-bytes')
      return { finalUrl: 'https://example.com/movie.mkv', tempPartPath: partPath, contentLength: 16n, supportsRange: true }
    })
    await processRemoteImportJob(job())
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.status).toBe('failed')
    expect(finalRow.errorCode).toBe('GOOGLE_REAUTH_REQUIRED')
    // The part file SURVIVES for the post-reconnect upload-resume retry.
    await expect(fsp.access(path.join(scratchDir, 'import-1.part'))).resolves.toBeUndefined()
  })

  it('fails with the raw quota code when a pinned account is insufficient (manual stays authoritative)', async () => {
    h.resolvePlacement.mockRejectedValue(new AppError('STORAGE_ACCOUNT_INSUFFICIENT_QUOTA', 'The selected storage account does not have enough available space.', 400))
    await processRemoteImportJob(job())
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.status).toBe('failed')
    expect(finalRow.errorCode).toBe('STORAGE_ACCOUNT_INSUFFICIENT_QUOTA')
  })

  it('Drive A full → Automatic selects Drive B (placement returns B; file lands on B, same virtual folder)', async () => {
    const accB = account('acc-b', 'google_drive')
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: accB,
      folderStorageLocation: { id: 'loc-movies-b', folderId: 'movies', connectedAccountId: 'acc-b', provider: 'google_drive', providerFolderId: 'drive-movies-b' },
    })
    h.downloader.mockResolvedValue({ finalUrl: 'https://example.com/movie.mkv', tempPartPath: '/tmp/import-1.part', contentLength: 1000n, supportsRange: true })

    await processRemoteImportJob(job())

    expect(resolveUploadPlacement).toHaveBeenCalledWith('user-1', 'movies', null, 1000n, undefined, 'remote-import')
    expect(h.googleUploader).toHaveBeenCalledWith('import-1', 'acc-b', 'user-1', 'movie.mkv', 'video/x-matroska', expect.stringContaining('import-1.part'), 'drive-movies-b', expect.any(Function))
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.status).toBe('completed')
    // File registered on B with the virtual folder id.
    const createCalls = (h.prismaMock.file.create as ReturnType<typeof vi.fn>).mock.calls
    expect(createCalls.some((c) => c[0].data.connectedAccountId === 'acc-b' && c[0].data.folderId === 'movies')).toBe(true)
  })

  it('opens the upload with uploadTotalBytes set from the local file size (canonical total)', async () => {
    const accA = account('acc-a', 'google_drive')
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: accA,
      folderStorageLocation: { id: 'loc-movies-a', folderId: 'movies', connectedAccountId: 'acc-a', provider: 'google_drive', providerFolderId: 'drive-movies-a' },
    })
    h.downloader.mockResolvedValue({ finalUrl: 'https://example.com/movie.mkv', tempPartPath: '/tmp/import-1.part', contentLength: 1000n, supportsRange: true })

    await processRemoteImportJob(job())

    // The upload phase records the FINAL output size — stat'd from the local
    // temp file (here the mocked downloader streamed only 3 bytes) — and
    // resets uploadedBytes for this execution. This is the number the live
    // progress bar divides against, NOT the source totalBytes.
    const updates = (h.prismaMock.remoteImport.update as ReturnType<typeof vi.fn>).mock.calls
    const phase = updates.find((c) => c[0].data?.uploadTotalBytes !== undefined)
    expect(phase).toBeDefined()
    // Note: the actual file on disk is 3 bytes (the downloader mock body).
    expect(phase![0].data.uploadTotalBytes).toBe(3n)
    expect(phase![0].data.uploadedBytes).toBe(0)
    // The uploader got an onProgress callback (live bar, not post-hoc only).
    const googleArgs = (h.googleUploader as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(typeof googleArgs[7]).toBe('function')
    // Completing the import stores the final total consistently.
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.uploadedBytes).toBe(finalRow.uploadTotalBytes)
  })

  it('propagates live progress through the upload callback (S3 branch)', async () => {
    // Route placement to an S3 account; the S3 uploader is mocked in s3.service.
    const accS3 = account('acc-s3', 's3')
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: accS3,
      folderStorageLocation: { id: 'loc-movies-s3', folderId: 'movies', connectedAccountId: 'acc-s3', provider: 's3', providerPrefix: 'test' },
    })
    h.downloader.mockResolvedValue({ finalUrl: 'https://example.com/movie.mp4', tempPartPath: '/tmp/import-1.part', contentLength: 1000n, supportsRange: true })
    // The mocked `uploadS3Object` accepts the opts and calls onProgress.
    ;(h.s3UploadSpy as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_config: unknown, _key: unknown, _body: unknown, _mime: unknown, opts?: { onProgress?: (bytes: bigint) => void }) => {
      opts?.onProgress?.(500n)
      opts?.onProgress?.(1000n)
    })

    await processRemoteImportJob(job())

    // The upload callback reported live bytes; the row recorded them.
    const updates = (h.prismaMock.remoteImport.update as ReturnType<typeof vi.fn>).mock.calls
    const progressWrites = updates.flatMap((c) => (c[0].data?.uploadedBytes !== undefined ? [c[0].data.uploadedBytes] : []))
    expect(progressWrites).toContain('500')
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.uploadedBytes).toBe(1000n)
    expect(finalRow.uploadTotalBytes).toBe(1000n)
    // S3 opts.onProgress was supplied.
    const s3Args = (h.s3UploadSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(typeof s3Args[4]?.onProgress).toBe('function')
  })

  it('finalizes uploadedBytes to the upload total once the upload completes', async () => {
    const accA = account('acc-a', 'google_drive')
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: accA,
      folderStorageLocation: { id: 'loc-movies-a', folderId: 'movies', connectedAccountId: 'acc-a', provider: 'google_drive', providerFolderId: 'drive-movies-a' },
    })
    h.downloader.mockResolvedValue({ finalUrl: 'https://example.com/movie.mkv', tempPartPath: '/tmp/import-1.part', contentLength: 1000n, supportsRange: true })

    await processRemoteImportJob(job())

    const finalRow = h.rows.get('import-1')!
    expect(finalRow.status).toBe('completed')
    expect(finalRow.uploadTotalBytes).toBe(1000n) // content-length is authoritative
    expect(finalRow.uploadedBytes).toBe(1000n)
  })

  it('uses the user-entered filename (canonical) as the provider object name', async () => {
    const accA = account('acc-a', 'google_drive')
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: accA,
      folderStorageLocation: { id: 'loc-movies-a', folderId: 'movies', connectedAccountId: 'acc-a', provider: 'google_drive', providerFolderId: 'drive-movies-a' },
    })
    h.downloader.mockResolvedValue({ finalUrl: 'https://example.com/some-remote-name.mkv', tempPartPath: '/tmp/import-1.part', contentLength: 1000n, supportsRange: true })
    // The user typed "My Movie.mkv" (stored as the row's canonical fileName);
    // the remote URL basename is different and must NEVER override it.
    h.rows.set('import-1', h.baseRow({ fileName: 'My Movie.mkv' }))
    await processRemoteImportJob(job())
    expect(h.googleUploader).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'My Movie.mkv', expect.anything(), expect.anything(), expect.anything(), expect.any(Function))
    const createCalls = (h.prismaMock.file.create as ReturnType<typeof vi.fn>).mock.calls
    expect(createCalls[0][0].data.name).toBe('My Movie.mkv')
  })

  it('fails the job with WORKER_TRANSPORT_NOT_IMPLEMENTED when a worker is selected (no silent Direct)', async () => {
    // A selected worker whose driver has no transport (this phase) must fail
    // the job explicitly — the source must NEVER be fetched via Direct.
    h.rows.set('import-1', h.baseRow({ workerId: 'worker-1', workerNameSnapshot: 'Cloudflare SG #1' }))
    ;(h.prismaMock.remoteFetchWorker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'worker-1',
      name: 'Cloudflare SG #1',
      driver: 'cloudflare',
      endpointUrl: 'https://relay.example.workers.dev',
      isEnabled: true,
    })
    await processRemoteImportJob(job())
    const row = h.rows.get('import-1')
    expect(row?.status).toBe('failed')
    expect(row?.errorCode).toBe('WORKER_TRANSPORT_NOT_IMPLEMENTED')
    // Never touched the downloader — the guard aborts before any remote fetch.
    expect(h.downloader).not.toHaveBeenCalled()
    expect(h.resolvePlacement).not.toHaveBeenCalled()
    expect(h.googleUploader).not.toHaveBeenCalled()
  })

  it('fails the job with REMOTE_IMPORT_WORKER_UNAVAILABLE when the selected worker was deleted', async () => {
    h.rows.set('import-1', h.baseRow({ workerId: 'worker-gone', workerNameSnapshot: 'Gone' }))
    ;(h.prismaMock.remoteFetchWorker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await processRemoteImportJob(job())
    const row = h.rows.get('import-1')
    expect(row?.status).toBe('failed')
    expect(row?.errorCode).toBe('REMOTE_IMPORT_WORKER_UNAVAILABLE')
    expect(h.downloader).not.toHaveBeenCalled()
  })
})
