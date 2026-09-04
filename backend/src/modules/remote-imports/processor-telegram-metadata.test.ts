import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import type { Job } from 'bullmq'
import { processRemoteImportJob } from './processor.js'
import type { RemoteImportJobData } from './queue.js'

// Drive the DIRECT import path through the real `processRemoteImportJob` while
// mocking the network/storage seam. Asserts that the Telegram upload carries
// the canonical 9drive:id= / 9drive:path= caption and stamps
// `File.telegramStableId` BEFORE the upload.

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
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any } = {} as any) => {
        const current = h.rows.get(where.id) ?? baseRow()
        const next = { ...current, ...data }
        h.rows.set(where.id, next)
        return next
      }),
    },
    remoteFetchWorker: { findFirst: vi.fn(async () => null) },
    connectedAccount: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'acc-tg', provider: 'telegram' })),
    },
    folder: { findFirst: vi.fn(async () => null) },
    file: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: any }) => {
        // Each `prisma.file.create` call gets a unique synthetic id tracked
        // in the hoisted `nextFileId` counter so tests can assert the
        // exact id the production code read off the return value.
        const id = h.nextFileId()
        h.createdFileIds.push(id)
        return { id, ...data }
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => ({ id: where.id, ...data })),
    },
  }

  return {
    prismaMock,
    rows: new Map<string, ReturnType<typeof baseRow>>(),
    baseRow,
    resolvePlacement: vi.fn(),
    googleUploader: vi.fn(async () => ({ providerFileId: 'unused', name: '', mimeType: '', sizeBytes: 0n })),
    audit: vi.fn(async () => undefined),
    uploadTelegram: vi.fn(async () => 'telegram://channel-1/100'),
    buildCaption: vi.fn((stableId: string, logicalPath: string | null) =>
      logicalPath ? `9drive:id=${stableId}\n9drive:path=${logicalPath}` : `9drive:id=${stableId}`,
    ),
    logicalPath: vi.fn(async (_userId: string, fileId: string) => {
      // Default: read the provisional file name from the last `prisma.file.create`
      // call and synthesize a path that mirrors the real resolver's contract.
      const last = h.prismaMock.file.create.mock.calls.at(-1)?.[0]?.data
      const name = last?.name ?? 'movie.mkv'
      const folderId = last?.folderId
      if (!folderId) return name
      return `Movies/${name}`
    }),
    nextFileId: () => `file-${h.createdFileIds.length + 1}`,
    createdFileIds: [] as string[],
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

vi.mock('../storage/upload-placement.service.js', () => ({
  resolveUploadPlacement: h.resolvePlacement,
}))

vi.mock('./url-downloader.js', () => ({
  followRemoteUrl: vi.fn(async (_url: string, options: { onResponse: (res: any, finalUrl: string) => Promise<unknown> }) => {
    await options.onResponse(
      {
        statusCode: 200,
        headers: { 'content-length': '1000', 'accept-ranges': 'bytes' },
        body: { [Symbol.asyncIterator]: async function* () { yield new Uint8Array([1, 2, 3]) } },
      },
      'https://example.com/movie.mkv',
    )
    return { result: undefined, finalUrl: 'https://example.com/movie.mkv', redirectCount: 0 }
  }),
}))

vi.mock('./ssrf.js', () => ({
  validateRemoteUrl: vi.fn(async () => undefined),
  resolveAndValidateHost: vi.fn(async () => undefined),
}))

vi.mock('./temp-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./temp-storage.js')>()
  return {
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

vi.mock('./secure-fetcher.js', () => ({
  createSecureFetcherForWorkerId: vi.fn(async () => ({
    fetch: vi.fn(async (input: any) => ({
      status: 200,
      headers: { 'content-length': '1000' },
      body: (async function* () { yield new Uint8Array([1, 2, 3]) })(),
      finalUrl: input.url,
      redirectCount: 0,
    })),
  })),
}))

vi.mock('../../utils/crypto.js', () => ({
  decryptText: vi.fn(() => 'https://example.com/movie.mkv'),
  encryptText: vi.fn((text: string) => `encrypted:${text}`),
}))

vi.mock('../../utils/audit.js', () => ({
  createAuditLog: (...args: unknown[]) => h.audit(...args),
}))

vi.mock('../google/google.service.js', () => ({
  ensureGoogleAppFolder: vi.fn(async () => 'app-folder'),
  getAuthedGoogleClient: vi.fn(async () => ({})),
  syncGoogleQuota: vi.fn(async () => undefined),
}))

vi.mock('../s3/s3.service.js', () => ({
  getS3ConfigForAccount: vi.fn(async () => ({ bucket: 'test', region: 'us-east-1' })),
  uploadS3Object: vi.fn(async () => undefined),
  buildS3ObjectKey: vi.fn(() => 'provider/object-key.mkv'),
  syncS3Quota: vi.fn(async () => undefined),
}))

vi.mock('../remote-fetch-workers/driver-registry.js', () => ({
  hasDriver: () => false,
  resolveDriver: () => ({ key: 'noop', displayName: 'noop', managed: false, authTypes: ['none'], fields: [], getMetadata: () => ({}), validateConfig: async () => ({}), testConnection: async () => ({ status: 'healthy' }) }),
}))

vi.mock('../telegram/telegram.service.js', () => ({
  getTelegramConfig: vi.fn(async () => ({ apiIdEncrypted: 'enc', apiHashEncrypted: 'enc', sessionEncrypted: 'enc', channelId: 'channel-1', connectedAccountId: 'acc-tg' })),
  markTelegramReauthRequired: vi.fn(async () => undefined),
  uploadTelegramDocument: (...args: unknown[]) => h.uploadTelegram(...args),
}))

vi.mock('../telegram/telegram-usage.service.js', () => ({
  syncTelegramUsage: vi.fn(async () => undefined),
}))

// The shared upload helper is mocked at the same seam as the raw uploader so
// this test keeps asserting the caption/name the processor produces without
// re-testing the crypto layer (covered by telegram-crypto.service.test.ts).
vi.mock('../telegram/telegram-caption.service.js', () => ({
  buildInitialCaption: (...args: unknown[]) => h.buildCaption(...args),
  uploadTelegramDocumentWithCrypto: async (opts: any) => {
    const caption = h.buildCaption(opts.fileId, opts.logicalPath)
    const remoteId = await h.uploadTelegram(opts.config, {
      filePath: opts.filePath,
      name: opts.fileName,
      mimeType: opts.mimeType,
      sizeBytes: opts.sizeBytes,
      caption: caption ?? undefined,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    })
    return { remoteId, caption, uploadName: opts.fileName }
  },
}))

vi.mock('../files/file-logical-path.js', () => ({
  logicalPathForFileId: (...args: unknown[]) => h.logicalPath(...args),
}))

function reset() {
  vi.clearAllMocks()
  h.rows.clear()
  h.rows.set('import-1', h.baseRow())
  h.createdFileIds.length = 0
}

beforeAll(async () => {
  scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), '9drive-telegram-meta-'))
})

afterAll(async () => {
  await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined)
})

function job(): Job<RemoteImportJobData> {
  return { id: 'job-1', data: { importId: 'import-1' } } as Job<RemoteImportJobData>
}

function telegramAccount(id: string) {
  return {
    id,
    userId: 'user-1',
    providerConfigId: null,
    provider: 'telegram',
    providerAccountId: `${id}`,
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

describe('processRemoteImportJob — Telegram caption + stable id', () => {
  beforeEach(reset)

  it('pre-creates the File row, stamps telegramStableId, encodes the caption, and uploads', async () => {
    const acc = telegramAccount('acc-tg')
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: acc,
      folderStorageLocation: { id: 'loc-1', folderId: 'movies', connectedAccountId: 'acc-tg', provider: 'telegram', providerFolderId: 'tg-flat' },
    })

    await processRemoteImportJob(job())

    // 1. A provisional File row was created BEFORE the upload.
    const createCalls = h.prismaMock.file.create.mock.calls
    expect(createCalls.length).toBeGreaterThanOrEqual(1)
    const provisionalInput = createCalls[0][0].data
    const provisionalId = h.createdFileIds[0]
    expect(provisionalInput.provider).toBe('telegram')
    expect(provisionalInput.providerFileId).toBe('pending')
    expect(provisionalInput.status).toBe('uploading')
    expect(provisionalInput.connectedAccountId).toBe('acc-tg')

    // 2. telegramStableId was stamped via prisma.file.update.
    const updateCalls = h.prismaMock.file.update.mock.calls
    const stampCall = updateCalls.find((c) => c[0]?.data?.telegramStableId)
    expect(stampCall).toBeDefined()
    expect(stampCall![0].data.telegramStableId).toBe(provisionalId)
    expect(stampCall![0].data.telegramStableId.length).toBeGreaterThan(0)

    // 3. The caption was built with the file id as stableId and the resolved
    //    logical path, then passed to uploadTelegramDocument.
    expect(h.buildCaption).toHaveBeenCalledTimes(1)
    const captionArgs = h.buildCaption.mock.calls[0]
    expect(captionArgs[0]).toBe(provisionalId)
    expect(captionArgs[1]).toBe('Movies/movie.mkv')

    expect(h.uploadTelegram).toHaveBeenCalledTimes(1)
    const uploadArgs = h.uploadTelegram.mock.calls[0][1]
    expect(uploadArgs.caption).toBe(`9drive:id=${provisionalId}\n9drive:path=Movies/movie.mkv`)
    expect(uploadArgs.name).toBe('movie.mkv')
    expect(uploadArgs.mimeType).toBe('video/x-matroska')

    // 4. The provisional row was flipped to active (no second `prisma.file.create`).
    const activeCall = updateCalls.find((c) => c[0]?.data?.status === 'active')
    expect(activeCall).toBeDefined()
    expect(activeCall![0].data.providerFileId).toBe('telegram://channel-1/100')

    // 5. The import completed and linked the file id.
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.status).toBe('completed')
    expect(finalRow.fileId).toBe(provisionalId)
  })

  it('encodes the caption without 9drive:path when logicalPathForFileId returns null', async () => {
    h.logicalPath.mockResolvedValueOnce(null)
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: telegramAccount('acc-tg'),
      folderStorageLocation: { id: 'loc-1', folderId: 'movies', connectedAccountId: 'acc-tg', provider: 'telegram', providerFolderId: 'tg-flat' },
    })

    await processRemoteImportJob(job())

    const uploadArgs = h.uploadTelegram.mock.calls[0][1]
    // The mock buildCaption returns id-only when logicalPath is null.
    expect(uploadArgs.caption).toMatch(/^9drive:id=.+/)
    expect(uploadArgs.caption).not.toContain('9drive:path=')
  })

  it('soft-deletes the provisional row when the Telegram upload fails', async () => {
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: telegramAccount('acc-tg'),
      folderStorageLocation: { id: 'loc-1', folderId: 'movies', connectedAccountId: 'acc-tg', provider: 'telegram', providerFolderId: 'tg-flat' },
    })
    h.uploadTelegram.mockRejectedValueOnce(new Error('TELEGRAM_NETWORK'))

    await processRemoteImportJob(job())

    // Find the soft-delete update call (status: 'deleted', deletedAt: <Date>).
    const deleteCall = h.prismaMock.file.update.mock.calls.find(
      (c) => c[0]?.data?.status === 'deleted' && c[0]?.data?.deletedAt instanceof Date,
    )
    expect(deleteCall).toBeDefined()

    // The import should not have been marked completed.
    const finalRow = h.rows.get('import-1')!
    expect(finalRow.status).not.toBe('completed')
  })

  it('links RemoteImport.fileId to the File row so a retry can find it', async () => {
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: telegramAccount('acc-tg'),
      folderStorageLocation: { id: 'loc-1', folderId: 'movies', connectedAccountId: 'acc-tg', provider: 'telegram', providerFolderId: 'tg-flat' },
    })

    await processRemoteImportJob(job())

    const finalRow = h.rows.get('import-1')!
    const provisionalId = h.createdFileIds[0]
    expect(finalRow.fileId).toBe(provisionalId)
  })
})
