import { beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 7 — the security utility. The master key must never appear in any
// output; `convert-legacy` must edit metadata only (no re-upload, physical
// filename preserved).
const TEST_KEY = 'test-telegram-metadata-master-key-32chars!'

function setEnv(enabled: boolean) {
  process.env.TELEGRAM_METADATA_ENCRYPTION_ENABLED = String(enabled)
  process.env.TELEGRAM_METADATA_MASTER_KEY = TEST_KEY
  process.env.TELEGRAM_CRYPTO_SALT = '9drive-telegram-test'
  process.env.TELEGRAM_OBFUSCATE_FILENAME_ENABLED = 'true'
  process.env.TELEGRAM_OBFUSCATE_FILE_EXTENSION = 'true'
}

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(async () => ({})),
  audit: vi.fn(async () => undefined),
  logicalPath: vi.fn(async () => 'Movies/movie.mkv'),
  getConfig: vi.fn(async () => ({ channelId: 'channel-1' })),
  updateCaption: vi.fn(async () => ({ ok: true, changed: true, channelId: 'channel-1', messageId: 100 })),
}))

vi.mock('../../config/prisma.js', () => ({ prisma: { file: { findFirst: h.findFirst, update: h.update } } }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: h.audit }))
vi.mock('../files/file-logical-path.js', () => ({ logicalPathForFileId: h.logicalPath }))
vi.mock('./telegram.service.js', () => ({ getTelegramConfig: h.getConfig }))
vi.mock('./telegram-caption.service.js', () => ({ updateTelegramDocumentCaption: h.updateCaption }))

const FILE = {
  id: 'file-1',
  name: 'movie.mkv',
  mimeType: 'video/x-matroska',
  sizeBytes: 1000n,
  connectedAccountId: 'acc-tg',
  telegramStableId: 'file-1',
  providerFileId: 'telegram://channel-1/100',
  encryptedMetadata: null,
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  setEnv(true)
  h.findFirst.mockResolvedValue(FILE)
})

describe('telegram-security.service', () => {
  it('status never exposes key material', async () => {
    const { getTelegramSecurityStatus } = await import('./telegram-security.service.js')
    const status = getTelegramSecurityStatus()
    expect(status).toEqual({ encryption: 'configured', filenameObfuscation: 'enabled', extensionObfuscation: true })
    expect(JSON.stringify(status)).not.toContain(TEST_KEY)
  })

  it('reports "invalid" for a too-short key instead of failing open', async () => {
    process.env.TELEGRAM_METADATA_MASTER_KEY = 'too-short'
    const { getTelegramSecurityStatus } = await import('./telegram-security.service.js')
    expect(getTelegramSecurityStatus().encryption).toBe('invalid')
  })

  it('builds a paste-ready caption that leaks neither the key nor the logical name', async () => {
    const { buildEncryptedCaptionForFile } = await import('./telegram-security.service.js')
    const out = await buildEncryptedCaptionForFile('user-1', 'file-1')

    expect(out.caption).toContain('9drive:id=file-1')
    expect(out.caption).toContain('9drive:meta=v1:')
    // The path is encrypted inside 9drive:meta — it must not also appear in
    // cleartext as a 9drive:path= line, and the logical name/path strings
    // must not leak into the caption in any other form.
    expect(out.caption).not.toContain('9drive:path=')
    expect(out.caption).not.toContain('Movies/movie.mkv')
    expect(out.caption).not.toContain('movie.mkv')
    expect(out.metaLine).toMatch(/^9drive:meta=v1:/)
    expect(out.physicalFilename).toMatch(/^tg_[a-f0-9]{32}\.bin$/)
    expect(JSON.stringify(out)).not.toContain(TEST_KEY)
    // The DB row is untouched — the user pastes it, the next sync reconciles.
    expect(h.update).not.toHaveBeenCalled()
  })

  it('round-trips its own payload through decrypt', async () => {
    const { buildEncryptedCaptionForFile, decryptMetadataPayload } = await import('./telegram-security.service.js')
    const { metaLine } = await buildEncryptedCaptionForFile('user-1', 'file-1')
    const meta = await decryptMetadataPayload('user-1', metaLine)
    expect(meta).toMatchObject({ name: 'movie.mkv', path: 'Movies/movie.mkv' })
  })

  it('convert-legacy edits the caption and caches the ciphertext without renaming the document', async () => {
    const { convertFileToEncryptedCaption } = await import('./telegram-security.service.js')
    const result = await convertFileToEncryptedCaption('user-1', 'file-1')

    expect(result).toMatchObject({ changed: true, channelId: 'channel-1', messageId: 100 })
    const metaArg = h.updateCaption.mock.calls[0][4]
    expect(metaArg).toMatch(/^9drive:meta=v1:/)

    const written = h.update.mock.calls[0][0].data
    expect(written.encryptedMetadata).toBe(metaArg)
    expect(written.cryptoVersion).toBe('v1')
    // No content re-upload and no physical rename.
    expect(written).not.toHaveProperty('physicalFilename')
  })

  it('refuses every operation when encryption is not enabled', async () => {
    setEnv(false)
    const m = await import('./telegram-security.service.js')
    await expect(m.buildEncryptedCaptionForFile('user-1', 'file-1')).rejects.toThrowError(/not enabled/i)
    await expect(m.decryptMetadataPayload('user-1', '9drive:meta=v1:a:b:c')).rejects.toThrowError(/not enabled/i)
    await expect(m.convertFileToEncryptedCaption('user-1', 'file-1')).rejects.toThrowError(/not enabled/i)
    expect(h.updateCaption).not.toHaveBeenCalled()
  })

  it('404s for a file the caller does not own', async () => {
    h.findFirst.mockResolvedValue(null)
    const { buildEncryptedCaptionForFile } = await import('./telegram-security.service.js')
    await expect(buildEncryptedCaptionForFile('user-1', 'someone-elses-file')).rejects.toMatchObject({ status: 404 })
  })

  it('refuses convert-legacy for a legacy row with no stable id', async () => {
    h.findFirst.mockResolvedValue({ ...FILE, telegramStableId: null })
    const { convertFileToEncryptedCaption } = await import('./telegram-security.service.js')
    await expect(convertFileToEncryptedCaption('user-1', 'file-1')).rejects.toMatchObject({ status: 409 })
    expect(h.updateCaption).not.toHaveBeenCalled()
  })
})
