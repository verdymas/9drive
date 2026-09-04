import { beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 6 — rename/move re-encrypts ONCE (fingerprint changed) and edits only
// the caption. The physical document, its bytes, and its opaque filename are
// never touched.
const TEST_KEY = 'test-telegram-metadata-master-key-32chars!'

function setEnv(enabled: boolean) {
  process.env.TELEGRAM_METADATA_ENCRYPTION_ENABLED = String(enabled)
  process.env.TELEGRAM_METADATA_MASTER_KEY = TEST_KEY
  process.env.TELEGRAM_CRYPTO_SALT = '9drive-telegram-test'
  process.env.TELEGRAM_OBFUSCATE_FILENAME_ENABLED = 'true'
  process.env.TELEGRAM_OBFUSCATE_FILE_EXTENSION = 'true'
}

const h = vi.hoisted(() => ({
  row: { value: null as Record<string, unknown> | null },
  findFirst: vi.fn(),
  update: vi.fn(async () => ({})),
  logicalPath: vi.fn(async () => 'Movies/renamed.mkv'),
  getConfig: vi.fn(async () => ({ channelId: 'channel-1' })),
  updateCaption: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../../config/prisma.js', () => ({ prisma: { file: { findFirst: h.findFirst, update: h.update } } }))
vi.mock('../files/file-logical-path.js', () => ({ logicalPathForFileId: h.logicalPath }))
vi.mock('./telegram.service.js', () => ({ getTelegramConfig: h.getConfig }))
vi.mock('./telegram-caption.service.js', () => ({ updateTelegramDocumentCaption: h.updateCaption }))

const BASE = {
  id: 'file-1',
  name: 'renamed.mkv',
  mimeType: 'video/x-matroska',
  sizeBytes: 1000n,
  connectedAccountId: 'acc-tg',
  telegramStableId: 'file-1',
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  setEnv(true)
})

describe('refreshTelegramCaption — protected metadata', () => {
  it('re-encrypts and caches once when the fingerprint changed, then edits the caption', async () => {
    h.findFirst.mockResolvedValue({ ...BASE, metadataFingerprint: 'stale-fingerprint', encryptedMetadata: null })
    const { refreshTelegramCaption } = await import('./telegram-caption-refresh.js')

    await refreshTelegramCaption('user-1', 'file-1')

    expect(h.update).toHaveBeenCalledTimes(1)
    const written = h.update.mock.calls[0][0].data
    expect(written.encryptedMetadata).toMatch(/^9drive:meta=v1:/)
    expect(written.metadataFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(written.cryptoVersion).toBe('v1')
    // Renaming in 9Drive must NOT rename the Telegram document.
    expect(written).not.toHaveProperty('physicalFilename')

    // The freshly-minted ciphertext is what goes into the caption.
    const metaArg = h.updateCaption.mock.calls[0][4]
    expect(metaArg).toBe(written.encryptedMetadata)
  })

  it('reuses the cached ciphertext without re-encrypting when the fingerprint matches', async () => {
    const { calculateMetadataFingerprint } = await import('./telegram-crypto.service.js')
    const fingerprint = calculateMetadataFingerprint({ fileId: 'file-1', name: 'renamed.mkv', path: 'Movies/renamed.mkv', mimeType: 'video/x-matroska', size: 1000n })
    h.findFirst.mockResolvedValue({ ...BASE, metadataFingerprint: fingerprint, encryptedMetadata: '9drive:meta=v1:cached' })
    const { refreshTelegramCaption } = await import('./telegram-caption-refresh.js')

    await refreshTelegramCaption('user-1', 'file-1')

    expect(h.update).not.toHaveBeenCalled()
    // The cached line is still sent so the edit never strips the meta line.
    expect(h.updateCaption.mock.calls[0][4]).toBe('9drive:meta=v1:cached')
  })

  it('does no crypto work at all when encryption is disabled', async () => {
    setEnv(false)
    h.findFirst.mockResolvedValue({ ...BASE, metadataFingerprint: null, encryptedMetadata: null })
    const { refreshTelegramCaption } = await import('./telegram-caption-refresh.js')

    await refreshTelegramCaption('user-1', 'file-1')

    expect(h.update).not.toHaveBeenCalled()
    expect(h.updateCaption.mock.calls[0][4]).toBeNull()
  })

  it('no-ops for a legacy row with no stable id', async () => {
    h.findFirst.mockResolvedValue({ ...BASE, telegramStableId: null, metadataFingerprint: null, encryptedMetadata: null })
    const { refreshTelegramCaption } = await import('./telegram-caption-refresh.js')

    await refreshTelegramCaption('user-1', 'file-1')

    expect(h.updateCaption).not.toHaveBeenCalled()
    expect(h.update).not.toHaveBeenCalled()
  })
})
