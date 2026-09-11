import { beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_KEY = 'test-telegram-metadata-master-key-32chars!'

function setEnv() {
  process.env.TELEGRAM_METADATA_ENCRYPTION_ENABLED = 'true'
  process.env.TELEGRAM_METADATA_MASTER_KEY = TEST_KEY
  process.env.TELEGRAM_CRYPTO_SALT = '9drive-telegram-test'
  process.env.TELEGRAM_OBFUSCATE_FILENAME_ENABLED = 'true'
  process.env.TELEGRAM_OBFUSCATE_FILE_EXTENSION = 'true'
}

const h = vi.hoisted(() => ({
  prismaMock: {
    file: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    folder: { findFirst: vi.fn(), create: vi.fn() },
  },
}))

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn() }))
vi.mock('./telegram-usage.service.js', () => ({ syncTelegramUsage: vi.fn() }))
vi.mock('./telegram.service.js', async () => {
  const actual = await vi.importActual<typeof import('./telegram.service.js')>('./telegram.service.js')
  return { ...actual, getTelegramConfig: vi.fn(), withTelegramClient: vi.fn(), listTelegramDocuments: vi.fn() }
})

const document = {
  remoteId: 'telegram://4458806678/42',
  name: 'tg_opaque.bin',
  size: 1024,
  mimeType: 'video/x-matroska',
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  setEnv()
  h.prismaMock.file.findFirst.mockResolvedValue(null)
  h.prismaMock.file.create.mockResolvedValue({ id: 'new-file' })
  h.prismaMock.file.update.mockResolvedValue({ id: 'updated-file' })
  h.prismaMock.folder.findFirst.mockResolvedValue(null)
  h.prismaMock.folder.create.mockImplementation(async ({ data }: any) => ({ id: `${data.parentId ?? 'root'}/${data.name}` }))
})

describe('ingestTelegramDocument — encrypted metadata canonicalization', () => {
  it('recovers a double-prefixed caption into the existing stable-id file without duplication', async () => {
    const { serializeTelegramMetaLine } = await import('./telegram-crypto.service.js')
    const { ingestTelegramDocument } = await import('./telegram-ingest.service.js')
    const canonical = serializeTelegramMetaLine({
      name: 'episode-01.mkv',
      path: 'Movies/Anime/One Piece/episode-01.mkv',
    })
    const legacyCaption = `9drive:id=stable-1\n${canonical.replace('9drive:meta=', '9drive:meta=9drive:meta=')}`

    h.prismaMock.file.findFirst
      .mockResolvedValueOnce({ id: 'file-1', encryptedMetadata: null })
      .mockResolvedValueOnce({
        id: 'file-1',
        providerFileId: 'telegram://4458806678/old-message',
        name: 'tg_opaque.bin',
        folderId: 'recovered-folder',
        mimeType: 'video/x-matroska',
        sizeBytes: 512n,
        telegramStableId: 'stable-1',
      })

    const result = await ingestTelegramDocument('user-1', 'acc-1', document, legacyCaption)

    expect(result).toBe('updated')
    expect(h.prismaMock.file.create).not.toHaveBeenCalled()
    expect(h.prismaMock.folder.create.mock.calls.map((call) => call[0].data.name)).toEqual(['Movies', 'Anime', 'One Piece'])
    expect(h.prismaMock.file.update.mock.calls[0][0].data).toMatchObject({
      providerFileId: document.remoteId,
      name: 'episode-01.mkv',
      folderId: 'root/Movies/Anime/One Piece',
    })
    expect(h.prismaMock.file.update.mock.calls[1][0].data.encryptedMetadata).toMatch(/^v1:/)
  })
})
