import { beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 5 — the sync/ingest fast path. Identical caption ciphertext must NOT
// be decrypted; a changed payload is decrypted + reconciled; an unreadable one
// is reported (never thrown, never guessed at).
const TEST_KEY = 'test-telegram-metadata-master-key-32chars!'

function setEnv(enabled: boolean, key = TEST_KEY) {
  process.env.TELEGRAM_METADATA_ENCRYPTION_ENABLED = String(enabled)
  process.env.TELEGRAM_METADATA_MASTER_KEY = key
  process.env.TELEGRAM_CRYPTO_SALT = '9drive-telegram-test'
  process.env.TELEGRAM_OBFUSCATE_FILENAME_ENABLED = 'true'
  process.env.TELEGRAM_OBFUSCATE_FILE_EXTENSION = 'true'
}

vi.mock('../../config/prisma.js', () => ({ prisma: { file: { update: vi.fn(async () => ({})) } } }))

beforeEach(() => {
  vi.resetModules()
  setEnv(true)
})

const load = async () => ({
  crypto: await import('./telegram-crypto.service.js'),
  cache: await import('./telegram-metadata-cache.js'),
})

describe('resolveCaptionMeta — sync fast path', () => {
  it('skips decryption entirely when the caption ciphertext equals the cache', async () => {
    const { cache } = await load()
    // Undecryptable-on-purpose payload: returning `cached` proves the fast
    // path short-circuited before any crypto ran.
    const garbage = '9drive:meta=v1:not-a-real-payload'
    expect(cache.resolveCaptionMeta(garbage, garbage)).toEqual({ status: 'cached' })
  })

  it('decrypts and returns the recovery metadata when the ciphertext differs', async () => {
    const { crypto, cache } = await load()
    const stale = crypto.serializeTelegramMetaLine({ name: 'old.mkv', path: 'Movies/old.mkv' })
    const fresh = crypto.serializeTelegramMetaLine({ name: 'new.mkv', path: 'Movies/new.mkv' })

    const result = cache.resolveCaptionMeta(fresh, stale)
    expect(result.status).toBe('changed')
    expect(result.status === 'changed' && result.meta).toMatchObject({ name: 'new.mkv', path: 'Movies/new.mkv' })
  })

  it('reports a failure (never throws) when the payload is tampered with', async () => {
    const { crypto, cache } = await load()
    const line = crypto.serializeTelegramMetaLine({ name: 'movie.mkv', path: 'Movies/movie.mkv' })
    // The line is `9drive:meta=v1:<iv>:<tag>:<cipher>` — flip a bit in the
    // trailing ciphertext so GCM's auth tag no longer verifies.
    const cut = line.lastIndexOf(':')
    const flipped = Buffer.from(line.slice(cut + 1), 'base64url')
    flipped[0] ^= 0xff
    const tampered = `${line.slice(0, cut + 1)}${flipped.toString('base64url')}`

    const result = cache.resolveCaptionMeta(tampered, line)
    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.code).toBe('TELEGRAM_METADATA_DECRYPT_FAILED')
  })

  it('reports a failure for an unsupported format version', async () => {
    const { cache } = await load()
    const result = cache.resolveCaptionMeta('9drive:meta=v9:aa:bb:cc', null)
    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.code).toBe('TELEGRAM_METADATA_UNSUPPORTED_VERSION')
  })

  it('treats a caption with no encrypted metadata as "none" (legacy captions unchanged)', async () => {
    const { cache } = await load()
    expect(cache.resolveCaptionMeta(null, 'whatever')).toEqual({ status: 'none' })
  })

  it('does not decrypt with a wrong key — reports the auth-tag failure', async () => {
    const { crypto } = await load()
    const line = crypto.serializeTelegramMetaLine({ name: 'movie.mkv', path: 'Movies/movie.mkv' })

    // Re-import everything under a different master key.
    vi.resetModules()
    setEnv(true, 'a-completely-different-master-key-32ch!')
    const { resolveCaptionMeta } = await import('./telegram-metadata-cache.js')
    const result = resolveCaptionMeta(line, null)
    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.code).toBe('TELEGRAM_METADATA_DECRYPT_FAILED')
  })

  it('refuses to read encrypted metadata when encryption is disabled', async () => {
    const { crypto } = await load()
    const line = crypto.serializeTelegramMetaLine({ name: 'movie.mkv', path: 'Movies/movie.mkv' })

    vi.resetModules()
    setEnv(false)
    const { resolveCaptionMeta } = await import('./telegram-metadata-cache.js')
    const result = resolveCaptionMeta(line, null)
    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.code).toBe('TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED')
    // The fast path still short-circuits without touching the key.
    expect(resolveCaptionMeta(line, line)).toEqual({ status: 'cached' })
  })
})

describe('inspectCaptionMeta', () => {
  it('finds the meta line inside a multi-line caption and passes a cached match', async () => {
    const { crypto, cache } = await load()
    const line = crypto.serializeTelegramMetaLine({ name: 'movie.mkv', path: 'Movies/movie.mkv' })
    const caption = `9drive:id=file-1\n${line}\n9drive:path=Movies/movie.mkv`

    expect(cache.inspectCaptionMeta(caption, line)).toBeNull()
    expect(cache.inspectCaptionMeta('9drive:id=file-1\n9drive:path=Movies/movie.mkv', null)).toBeNull()
  })

  it('returns the failure code for an unreadable payload', async () => {
    const { cache } = await load()
    const failure = cache.inspectCaptionMeta('9drive:id=file-1\n9drive:meta=v1:not-a-payload', null)
    expect(failure?.code).toBe('TELEGRAM_METADATA_MALFORMED')
  })
})
