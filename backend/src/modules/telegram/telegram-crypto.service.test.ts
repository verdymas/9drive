import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// env.ts parses at import time, so the vars must be set BEFORE the first
// dynamic import of the module under test. One consistent config for the
// whole file; the wrong-key case re-imports with a changed key via
// vi.resetModules().
const TEST_KEY = 'test-telegram-metadata-master-key-32chars!'

beforeEach(() => {
  process.env.TELEGRAM_METADATA_ENCRYPTION_ENABLED = 'true'
  process.env.TELEGRAM_METADATA_MASTER_KEY = TEST_KEY
  process.env.TELEGRAM_CRYPTO_SALT = '9drive-telegram-test'
  process.env.TELEGRAM_OBFUSCATE_FILENAME_ENABLED = 'true'
  process.env.TELEGRAM_OBFUSCATE_FILE_EXTENSION = 'true'
})

const load = () => import('./telegram-crypto.service.js')

afterAll(() => {
  vi.resetModules()
})

describe('telegram-crypto.service — encryption', () => {
  it('round-trips encrypt → decrypt', async () => {
    const m = await load()
    const payload = m.encryptMetadata('{"name":"movie.mkv","size":"123"}')
    expect(payload).toMatch(/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
    expect(m.decryptMetadata(payload)).toBe('{"name":"movie.mkv","size":"123"}')
  })

  it('produces randomized ciphertext for identical plaintext (fresh IV)', async () => {
    const m = await load()
    const a = m.encryptMetadata('same-plaintext')
    const b = m.encryptMetadata('same-plaintext')
    expect(a).not.toBe(b)
    expect(m.decryptMetadata(a)).toBe('same-plaintext')
    expect(m.decryptMetadata(b)).toBe('same-plaintext')
  })

  it('detects tampering (auth tag mismatch)', async () => {
    const m = await load()
    const payload = m.encryptMetadata('secret-data')
    const [iv, tag, cipher] = payload.split(':')
    const flipped = Buffer.from(cipher, 'base64url')
    flipped[0] = flipped[0] ^ 0xff
    const tampered = `${iv}:${tag}:${flipped.toString('base64url')}`
    expect(() => m.decryptMetadata(tampered)).toThrowError(/decryption failed/i)
  })

  it('fails with a wrong key (auth tag mismatch)', async () => {
    const m = await load()
    const payload = m.encryptMetadata('protect-me')

    // Re-import the module graph with a DIFFERENT master key (fresh env parse).
    vi.resetModules()
    process.env.TELEGRAM_METADATA_MASTER_KEY = 'a-completely-different-master-key-32chars!'
    const other = await import('./telegram-crypto.service.js')
    expect(() => other.decryptMetadata(payload)).toThrowError(/decryption failed/i)

    // Restore the original key for the remaining tests.
    vi.resetModules()
    process.env.TELEGRAM_METADATA_MASTER_KEY = TEST_KEY
    await load()
  })

  it('rejects malformed payloads and unsupported versions', async () => {
    const m = await load()
    expect(() => m.decryptMetadata('not-a-payload')).toThrowError(/malformed/i)
    expect(() => m.decryptRecoveryMetadata('v2:aaa:bbb:ccc')).toThrowError(/unsupported telegram metadata version/i)
    expect(m.detectMetadataVersion('v1:xyz')).toBe('v1')
    expect(m.detectMetadataVersion('garbage')).toBeNull()
  })

  it('fails safely when encryption is disabled or the key is invalid', async () => {
    vi.resetModules()
    process.env.TELEGRAM_METADATA_ENCRYPTION_ENABLED = 'false'
    const off = await import('./telegram-crypto.service.js')
    expect(() => off.encryptMetadata('x')).toThrowError(/not enabled/i)
    expect(off.telegramCryptoStatus().encryption).toBe('notConfigured')

    vi.resetModules()
    process.env.TELEGRAM_METADATA_ENCRYPTION_ENABLED = 'true'
    process.env.TELEGRAM_METADATA_MASTER_KEY = 'short'
    const invalid = await import('./telegram-crypto.service.js')
    expect(invalid.telegramCryptoStatus().encryption).toBe('invalid')
    expect(() => invalid.encryptMetadata('x')).toThrowError(/at least 32 characters/i)

    vi.resetModules()
    process.env.TELEGRAM_METADATA_MASTER_KEY = TEST_KEY
    await load()
  })
})

describe('telegram-crypto.service — physical filename', () => {
  it('is stable for the same file id + key', async () => {
    const m = await load()
    const a = m.generatePhysicalFilename('abc-123')
    const b = m.generatePhysicalFilename('abc-123')
    expect(a).toBe(b)
    expect(a).toMatch(/^tg_[0-9a-f]{32}\.bin$/)
  })

  it('differs across file ids and hides the logical name', async () => {
    const m = await load()
    const a = m.generatePhysicalFilename('abc-123')
    const b = m.generatePhysicalFilename('xyz-999')
    expect(a).not.toBe(b)
    expect(a).not.toContain('episode-01')
  })

  it('keeps the logical extension when obfuscation is disabled', async () => {
    vi.resetModules()
    process.env.TELEGRAM_OBFUSCATE_FILE_EXTENSION = 'false'
    const m = await import('./telegram-crypto.service.js')
    const name = m.generatePhysicalFilename('abc-123', 'movie.mkv')
    expect(name).toMatch(/^tg_[0-9a-f]{32}\.mkv$/)

    vi.resetModules()
    process.env.TELEGRAM_OBFUSCATE_FILE_EXTENSION = 'true'
    await load()
  })
})

describe('telegram-crypto.service — fingerprint', () => {
  it('is stable for unchanged canonical metadata', async () => {
    const m = await load()
    const base = { fileId: 'abc', name: 'movie.mkv', path: 'Movies/movie.mkv', mimeType: 'video/x-matroska', size: 123456n }
    expect(m.calculateMetadataFingerprint(base)).toBe(m.calculateMetadataFingerprint(base))
  })

  it('changes on rename and move', async () => {
    const m = await load()
    const base = { fileId: 'abc', name: 'movie.mkv', path: 'Movies/movie.mkv', mimeType: 'video/x-matroska', size: 123456n }
    const renamed = m.calculateMetadataFingerprint({ ...base, name: 'new.mkv', path: 'Movies/new.mkv' })
    const moved = m.calculateMetadataFingerprint({ ...base, path: 'Movies/Anime/movie.mkv' })
    expect(renamed).not.toBe(m.calculateMetadataFingerprint(base))
    expect(moved).not.toBe(m.calculateMetadataFingerprint(base))
  })
})

describe('telegram-crypto.service — metadata serialization', () => {
  it('serializes a caption meta line and decrypts it back', async () => {
    const m = await load()
    const line = m.serializeTelegramMetaLine({
      name: 'episode-01.mkv',
      path: 'Movies/Anime/One Piece/episode-01.mkv',
      mimeType: 'video/x-matroska',
      size: 123456789n,
    })
    expect(line.startsWith('9drive:meta=v1:')).toBe(true)

    const recovered = m.decryptRecoveryMetadata(line)
    expect(recovered.name).toBe('episode-01.mkv')
    expect(recovered.path).toBe('Movies/Anime/One Piece/episode-01.mkv')
    expect(recovered.mimeType).toBe('video/x-matroska')
    expect(recovered.size).toBe('123456789')
  })

  it('accepts a raw payload (no key prefix)', async () => {
    const m = await load()
    const line = m.serializeTelegramMetaLine({ name: 'a.txt', path: null })
    const raw = line.slice('9drive:meta='.length)
    expect(m.decryptRecoveryMetadata(raw).name).toBe('a.txt')
  })

  it('rejects metadata with a missing name', async () => {
    const m = await load()
    const line = m.serializeTelegramMetaLine({ name: 'x.txt', path: null })
    const raw = m.stripMetaKeyPrefix(line)
    const tampered = raw.replace(m.detectMetadataVersion(raw)!, 'v1')
    // Rebuild a payload whose decrypted JSON lacks a name.
    const { encryptMetadata } = m
    const noName = encryptMetadata('{"path":"a/b.txt"}')
    expect(() => m.decryptRecoveryMetadata(`v1:${noName}`)).toThrowError(/valid name/i)
    void tampered
  })
})
