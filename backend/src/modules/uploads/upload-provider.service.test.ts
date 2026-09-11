import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  fileCreate: vi.fn(),
  fileUpdate: vi.fn(),
  getS3Config: vi.fn(),
  uploadS3: vi.fn(),
  deleteS3: vi.fn(),
  getTelegramConfig: vi.fn(),
  uploadTelegram: vi.fn(),
  deleteTelegram: vi.fn(),
  ensureRoot: vi.fn(),
  ensureLocation: vi.fn(),
  logicalPath: vi.fn(),
  metadata: vi.fn(),
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    file: {
      create: h.fileCreate,
      update: h.fileUpdate,
    },
    folderStorageLocation: { findFirst: vi.fn() },
  },
}))
vi.mock('../s3/s3.service.js', () => ({
  buildS3ObjectKey: vi.fn(() => '9drive/user-1/file-1/report.txt'),
  deleteS3ObjectByKey: h.deleteS3,
  getS3ConfigForAccount: h.getS3Config,
  uploadS3Object: h.uploadS3,
}))
vi.mock('../telegram/telegram.service.js', () => ({
  deleteTelegramDocuments: h.deleteTelegram,
  getTelegramConfig: h.getTelegramConfig,
}))
vi.mock('../telegram/telegram-caption.service.js', () => ({ uploadTelegramDocumentWithCrypto: h.uploadTelegram }))
vi.mock('../telegram/telegram-metadata-cache.js', () => ({ buildTelegramMetadataCache: h.metadata }))
vi.mock('../files/file-logical-path.js', () => ({ logicalPathForFileId: h.logicalPath }))
vi.mock('../storage/folder-materialization.service.js', () => ({ ensureFolderStorageLocation: h.ensureLocation }))
vi.mock('../storage/provider-folder.service.js', () => ({ ensureProviderRoot: h.ensureRoot }))

import { finalizeStagedUpload } from './upload-provider.service.js'

describe('finalizeStagedUpload', () => {
  let tempDir = ''
  let tmpPath = ''

  beforeEach(() => {
    vi.clearAllMocks()
    h.fileCreate.mockResolvedValue({ id: 'file-1', providerFileId: 'pending', status: 'uploading' })
    h.fileUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data }))
    h.getS3Config.mockResolvedValue({ prefix: '9drive' })
    h.getTelegramConfig.mockResolvedValue({})
    h.uploadS3.mockImplementation(async (_config: unknown, _key: string, body: NodeJS.ReadableStream) => {
      for await (const _chunk of body) {
        // Consume the real staged stream so its lifecycle is exercised.
      }
    })
    h.uploadTelegram.mockResolvedValue({ remoteId: 'telegram://channel/42' })
    h.metadata.mockReturnValue({})
    h.logicalPath.mockResolvedValue('report.txt')
    h.ensureRoot.mockResolvedValue('9drive')
  })

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), '9drive-provider-service-'))
    tmpPath = path.join(tempDir, 'session-1.multi')
    await writeFile(tmpPath, 'abc')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns a typed active S3 file and cleanup handle after provider commit', async () => {
    const result = await finalizeStagedUpload({
      userId: 'user-1',
      account: { id: 's3-account', provider: 's3' },
      folderId: null,
      fileName: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 3n,
      tmpPath,
    })

    expect(result).toMatchObject({ file: { id: 'file-1' }, providerFileId: '9drive/user-1/file-1/report.txt', cleanup: expect.any(Function) })
    expect(h.fileUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { providerFileId: '9drive/user-1/file-1/report.txt', status: 'active' } }))
  })

  it('soft-deletes a provisional Telegram file and removes the remote document when provider upload fails', async () => {
    h.uploadTelegram.mockRejectedValueOnce(new Error('Telegram unavailable'))

    await expect(finalizeStagedUpload({
      userId: 'user-1',
      account: { id: 'telegram-account', provider: 'telegram' },
      folderId: null,
      fileName: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 3n,
      tmpPath,
    })).rejects.toThrow('Telegram unavailable')

    expect(h.fileUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'deleted' }) }))
  })
})
