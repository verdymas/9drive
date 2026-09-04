import { beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 10 — WebDAV / Jellyfin regression (spec §58, §55).
//
// The contract: normal read paths NEVER decrypt Telegram metadata. Reads
// resolve by DB row and serve the logical name; the encrypted caption is a
// recovery cache that only sync ever touches.
//
// This asserts that structurally: the crypto module's mock factory flips a flag
// the first time anything in the import graph pulls it in. Exercising the whole
// WebDAV resolution path with the flag still false proves no decryption is
// reachable from here — through any module, not just the obvious one.

const h = vi.hoisted(() => ({ cryptoLoaded: { value: false } }))

vi.mock('../telegram/telegram-crypto.service.js', () => {
  h.cryptoLoaded.value = true
  const forbidden = () => {
    throw new Error('WebDAV read paths must not decrypt Telegram metadata.')
  }
  return {
    decryptMetadata: forbidden,
    decryptRecoveryMetadata: forbidden,
    generatePhysicalFilename: forbidden,
    telegramCryptoEnabled: forbidden,
  }
})

const account = { id: 'acc-1', provider: 'telegram', userId: 'user-1' }

const folders = [
  { id: 'f1', parentId: null, name: 'Movies', provider: 'telegram', deletedAt: null, createdAt: new Date(0), updatedAt: new Date(0) },
]

// The row carries a populated crypto cache on purpose: the read path must
// ignore `physicalFilename`/`encryptedMetadata` and serve `name`.
const files = [
  {
    id: 'file-1',
    folderId: 'f1',
    name: 'movie.mkv',
    provider: 'telegram',
    providerFileId: 'telegram://-100123/42',
    sizeBytes: 1024n,
    mimeType: 'video/x-matroska',
    status: 'active',
    connectedAccountId: 'acc-1',
    connectedAccount: account,
    physicalFilename: 'tg_deadbeefdeadbeefdeadbeefdeadbeef.bin',
    encryptedMetadata: '9drive:meta=v1:aaa:bbb:ccc',
    metadataFingerprint: 'fp',
    cryptoVersion: 'v1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
]

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    folder: {
      findMany: vi.fn(async ({ where }: any) => folders.filter((f) => f.parentId === (where.parentId ?? null))),
      findFirst: vi.fn(async ({ where }: any) => folders.find((f) => f.id === where.id) ?? null),
    },
    file: {
      findMany: vi.fn(async ({ where }: any) => files.filter((f) => f.folderId === (where.folderId ?? null))),
      findFirst: vi.fn(async ({ where }: any) => files.find((f) => f.id === where.id) ?? null),
    },
  },
}))

beforeEach(() => {
  h.cryptoLoaded.value = false
})

describe('WebDAV read path — no decryption (Phase 10)', () => {
  it('serves the logical DB name for a Telegram file and never loads the crypto module', async () => {
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem()

    const node = await fs.resolvePath('/Movies/movie.mkv')
    expect(node).toMatchObject({ type: 'file', provider: 'telegram', name: 'movie.mkv', sizeBytes: 1024n })

    const listed = await fs.listFilesUnder('f1')
    expect(listed.map((f) => f.name)).toEqual(['movie.mkv'])

    const streamed = await fs.getFileForStreaming('file-1')
    expect(streamed?.name).toBe('movie.mkv')

    expect(h.cryptoLoaded.value).toBe(false)
  })

  it('does not expose the opaque physical filename as an addressable path', async () => {
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem()

    expect(await fs.resolvePath('/Movies/tg_deadbeefdeadbeefdeadbeefdeadbeef.bin')).toBeNull()
    expect(h.cryptoLoaded.value).toBe(false)
  })
})
