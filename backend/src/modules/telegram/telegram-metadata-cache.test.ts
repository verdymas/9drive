import { beforeEach, describe, expect, it, vi } from 'vitest'

// env.ts parses at import time → set vars before the dynamic import, and
// resetModules between behavior-matrix cases (Phase 4: the upload paths must
// persist ciphertext + an opaque physical name when crypto is enabled, and
// must leave the columns untouched when it is off).
const TEST_KEY = 'test-telegram-metadata-master-key-32chars!'

const INPUT = { fileId: 'file-1', name: 'movie.mkv', path: 'Movies/movie.mkv', mimeType: 'video/x-matroska', size: 1000n }

function setEnv(opts: { encryption: boolean; obfuscate: boolean }) {
  process.env.TELEGRAM_METADATA_ENCRYPTION_ENABLED = String(opts.encryption)
  process.env.TELEGRAM_OBFUSCATE_FILENAME_ENABLED = String(opts.obfuscate)
  process.env.TELEGRAM_METADATA_MASTER_KEY = TEST_KEY
  process.env.TELEGRAM_CRYPTO_SALT = '9drive-telegram-test'
  process.env.TELEGRAM_OBFUSCATE_FILE_EXTENSION = 'true'
}

const updateMock = vi.fn(async () => ({}))
vi.mock('../../config/prisma.js', () => ({ prisma: { file: { update: (...a: unknown[]) => updateMock(...(a as [])) } } }))

beforeEach(() => {
  vi.resetModules()
  updateMock.mockClear()
})

describe('buildTelegramMetadataCache', () => {
  it('persists ciphertext, fingerprint, version and an opaque physical name when enabled', async () => {
    setEnv({ encryption: true, obfuscate: true })
    const { buildTelegramMetadataCache } = await import('./telegram-metadata-cache.js')
    const cache = buildTelegramMetadataCache(INPUT)

    expect(cache.cryptoVersion).toBe('v1')
    expect(cache.metadataFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(cache.encryptedMetadata).toMatch(/^9drive:meta=v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
    // The cached ciphertext must not leak the logical name or path.
    expect(cache.encryptedMetadata).not.toContain('movie.mkv')
    expect(cache.encryptedMetadata).not.toContain('Movies')
    expect(cache.physicalFilename).toMatch(/^tg_[a-f0-9]{32}\.bin$/)
    expect(cache.physicalFilename).not.toContain('movie')
  })

  it('writes nothing when encryption and obfuscation are both disabled (legacy plaintext preserved)', async () => {
    setEnv({ encryption: false, obfuscate: false })
    const { buildTelegramMetadataCache, persistTelegramMetadataCache } = await import('./telegram-metadata-cache.js')
    expect(buildTelegramMetadataCache(INPUT)).toEqual({})
    await persistTelegramMetadataCache('user-1', 'file-1', INPUT)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('obfuscates the filename without encrypting when only obfuscation is on', async () => {
    setEnv({ encryption: false, obfuscate: true })
    const { buildTelegramMetadataCache } = await import('./telegram-metadata-cache.js')
    const cache = buildTelegramMetadataCache(INPUT)
    expect(cache.physicalFilename).toMatch(/^tg_[a-f0-9]{32}\.bin$/)
    expect(cache.encryptedMetadata).toBeUndefined()
    expect(cache.metadataFingerprint).toBeUndefined()
  })

  it('re-encrypts only when the fingerprint changed (rename)', async () => {
    setEnv({ encryption: true, obfuscate: true })
    const { refreshTelegramMetadataCache } = await import('./telegram-metadata-cache.js')
    const { calculateMetadataFingerprint } = await import('./telegram-crypto.service.js')
    const current = calculateMetadataFingerprint(INPUT)

    expect(await refreshTelegramMetadataCache('user-1', 'file-1', INPUT, current)).toBe(false)
    expect(updateMock).not.toHaveBeenCalled()

    const renamed = { ...INPUT, name: 'renamed.mkv', path: 'Movies/renamed.mkv' }
    expect(await refreshTelegramMetadataCache('user-1', 'file-1', renamed, current)).toBe(true)
    expect(updateMock).toHaveBeenCalledTimes(1)
  })
})
