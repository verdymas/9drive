import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { ensureFolderStorageLocation } from './folder-materialization.service.js'

// ── Mocks ────────────────────────────────────────────────────────────────────
// The materialization service talks to prisma (folders + location rows) and to
// provider-folder.service (create/ensure-root). Both are mocked in-memory.
const h = vi.hoisted(() => {
  // The service's isUniqueViolation uses `instanceof Prisma.PrismaClientKnownRequestError`,
  // so the mock must throw a REAL Prisma error. The hoisted block runs before
  // imports, so we cannot reference `Prisma` there; `p2002Ref` is bound to the
  // module-level function after imports, and the mock calls it at call time.
  let p2002Ref: ((message: string) => Error) | null = null
  const now = new Date('2026-08-07T00:00:00.000Z')
  const account = (id: string, provider: string) => ({
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
    createdAt: now,
    updatedAt: now,
  })

  // In-memory "DB": folders by id, locations keyed `folderId|accountId`.
  const folders: Array<{ id: string; name: string; parentId: string | null; userId: string; deletedAt: Date | null }> = []
  const locations: Array<{ id: string; folderId: string; connectedAccountId: string; provider: string; providerFolderId: string }> = []
  let locationSeq = 0

  const folder = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId, userId: 'user-1', deletedAt: null })

  const prismaMock = {
    connectedAccount: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId?: string; status?: string } }) => {
        const match = h.accounts.find((a) => a.id === where.id)
        if (!match) return null
        if (where.userId && match.userId !== where.userId) return null
        if (where.status && match.status !== where.status) return null
        return match
      }),
    },
    folder: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; deletedAt: null } }) => {
        return folders.filter((f) => f.userId === where.userId && f.deletedAt === null)
      }),
    },
    folderStorageLocation: {
      findUnique: vi.fn(async ({ where }: { where: { folderId_connectedAccountId: { folderId: string; connectedAccountId: string } } }) => {
        const key = `${where.folderId_connectedAccountId.folderId}|${where.folderId_connectedAccountId.connectedAccountId}`
        return locations.find((l) => `${l.folderId}|${l.connectedAccountId}` === key) ?? null
      }),
      findMany: vi.fn(async ({ where }: { where: { folderId?: { in: string[] }; connectedAccountId?: string } }) => {
        return locations.filter((l) => {
          if (where.folderId?.in && !where.folderId.in.includes(l.folderId)) return false
          if (where.connectedAccountId && l.connectedAccountId !== where.connectedAccountId) return false
          return true
        })
      }),
      create: vi.fn(async ({ data }: { data: { folderId: string; connectedAccountId: string; provider: string; providerFolderId: string } }) => {
        // Honest unique-key enforcement: the P2002 path is simulated by
        // throwing a real PrismaClientKnownRequestError when the pair already
        // exists (the service's isUniqueViolation uses instanceof).
        const dup = locations.some((l) => l.folderId === data.folderId && l.connectedAccountId === data.connectedAccountId)
        if (dup) {
          throw p2002Ref!('Unique constraint failed on the fields: (`folder_id`,`connected_account_id`)')
        }
        const row = {
          id: `loc-${++locationSeq}`,
          folderId: data.folderId,
          connectedAccountId: data.connectedAccountId,
          provider: data.provider,
          providerFolderId: data.providerFolderId,
        }
        locations.push(row)
        return row
      }),
    },
  }

  // Provider folder "ids" are deterministic: `${parent}/${name}` (mirrors the
  // real S3-style join in provider-folder.service; google ids are opaque but
  // unique per chain — the tests only assert structure, not real Drive ids).
  const providerCreated: Array<{ name: string; parent: string }> = []
  const providerMock = {
    ensureProviderRoot: vi.fn(async () => 'ROOT'),
    createProviderFolder: vi.fn(async (_account: unknown, name: string, parent: string) => {
      const id = `${parent}/${name}`
      providerCreated.push({ name, parent })
      return id
    }),
  }

  return { prismaMock, providerMock, account, folder, folders, locations, providerCreated, accounts: [], now, p2002Ref }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('./provider-folder.service.js', () => ({
  ensureProviderRoot: h.providerMock.ensureProviderRoot,
  createProviderFolder: h.providerMock.createProviderFolder,
}))

// Import AFTER mocks (vi.mock hoists).
import { createProviderFolder, ensureProviderRoot } from './provider-folder.service.js'

// Bind the real Prisma error constructor into the hoisted mock (call-time).
h.p2002Ref = (message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code: 'P2002', clientVersion: '6.19.3' })

/** Reset the in-memory DB + clear call records. */
function reset() {
  vi.clearAllMocks()
  // Tests that override the shared findFirst (to force "no account") must not
  // leak their implementation into the next test — restore the real one.
  ;(h.prismaMock.connectedAccount.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where: { id: string; userId?: string; status?: string } }) => {
    const match = h.accounts.find((a) => a.id === where.id)
    if (!match) return null
    if (where.userId && match.userId !== where.userId) return null
    if (where.status && match.status !== where.status) return null
    return match
  })
  ;(h.prismaMock.folderStorageLocation.findUnique as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where: { folderId_connectedAccountId: { folderId: string; connectedAccountId: string } } }) => {
    const key = `${where.folderId_connectedAccountId.folderId}|${where.folderId_connectedAccountId.connectedAccountId}`
    return h.locations.find((l) => `${l.folderId}|${l.connectedAccountId}` === key) ?? null
  })
  ;(h.providerMock.createProviderFolder as ReturnType<typeof vi.fn>).mockImplementation(async (_account: unknown, name: string, parent: string) => `${parent}/${name}`)
  ;(h.prismaMock.folderStorageLocation.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: { folderId: string; connectedAccountId: string; provider: string; providerFolderId: string } }) => {
    const dup = h.locations.some((l) => l.folderId === data.folderId && l.connectedAccountId === data.connectedAccountId)
    if (dup) {
      throw h.p2002Ref!('Unique constraint failed on the fields: (`folder_id`,`connected_account_id`)')
    }
    const row = { id: `loc-${h.locations.length + 1}`, folderId: data.folderId, connectedAccountId: data.connectedAccountId, provider: data.provider, providerFolderId: data.providerFolderId }
    h.locations.push(row)
    return row
  })
  h.folders.length = 0
  h.locations.length = 0
  h.providerCreated.length = 0
  h.accounts.length = 0
  h.accounts.push(h.account('acc-a', 'google_drive'), h.account('acc-b', 'google_drive'), h.account('acc-s3', 's3'))
}

function loc(folderId: string, accountId: string, providerFolderId: string, provider = 'google_drive') {
  h.locations.push({ id: `existing-${folderId}-${accountId}`, folderId, connectedAccountId: accountId, provider, providerFolderId })
}

describe('ensureFolderStorageLocation', () => {
  beforeEach(reset)

  it('rejects an account that is not the user\'s or not connected', async () => {
    h.accounts.push(h.account('acc-x', 'google_drive'))
    ;(h.prismaMock.connectedAccount.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await expect(ensureFolderStorageLocation('user-1', 'movies', 'acc-x')).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_NOT_ELIGIBLE' })
  })

  it('rejects a virtual folder that does not exist', async () => {
    h.folders.push(h.folder('movies', 'Movies'))
    await expect(ensureFolderStorageLocation('user-1', 'missing', 'acc-a')).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' })
  })

  it('returns the existing location immediately without provider calls (idempotent)', async () => {
    h.folders.push(h.folder('movies', 'Movies'))
    loc('movies', 'acc-a', 'drive-folder-movies')
    const result = await ensureFolderStorageLocation('user-1', 'movies', 'acc-a')
    expect(result).toEqual({ location: expect.objectContaining({ folderId: 'movies', providerFolderId: 'drive-folder-movies' }), createdCount: 0 })
    expect(createProviderFolder).not.toHaveBeenCalled()
    expect(ensureProviderRoot).not.toHaveBeenCalled()
  })

  it('materializes the full parent chain (Movies → Action → Marvel) on the account', async () => {
    h.folders.push(h.folder('movies', 'Movies'), h.folder('action', 'Action', 'movies'), h.folder('marvel', 'Marvel', 'action'))
    const result = await ensureFolderStorageLocation('user-1', 'marvel', 'acc-a')
    // Created 3 levels: Movies, Action, Marvel (chain root-first).
    expect(result.createdCount).toBe(3)
    expect(result.location.providerFolderId).toBe('ROOT/Movies/Action/Marvel')
    expect(createProviderFolder).toHaveBeenNthCalledWith(1, expect.anything(), 'Movies', 'ROOT')
    expect(createProviderFolder).toHaveBeenNthCalledWith(2, expect.anything(), 'Action', 'ROOT/Movies')
    expect(createProviderFolder).toHaveBeenNthCalledWith(3, expect.anything(), 'Marvel', 'ROOT/Movies/Action')
    // Every level persisted immediately.
    expect(h.locations).toHaveLength(3)
    expect(h.locations.map((l) => l.folderId)).toEqual(['movies', 'action', 'marvel'])
  })

  it('reuses existing ancestor locations and creates only the missing tail', async () => {
    h.folders.push(h.folder('movies', 'Movies'), h.folder('action', 'Action', 'movies'), h.folder('marvel', 'Marvel', 'action'))
    loc('movies', 'acc-a', 'drive-movies')
    const result = await ensureFolderStorageLocation('user-1', 'marvel', 'acc-a')
    expect(result.createdCount).toBe(2)
    expect(createProviderFolder).toHaveBeenNthCalledWith(1, expect.anything(), 'Action', 'drive-movies')
    expect(createProviderFolder).toHaveBeenNthCalledWith(2, expect.anything(), 'Marvel', 'drive-movies/Action')
  })

  it('gives different accounts different physical folders for the same virtual folder', async () => {
    h.folders.push(h.folder('movies', 'Movies'))
    // Account-aware provider ids (each account has its own physical folder).
    ;(createProviderFolder as ReturnType<typeof vi.fn>).mockImplementation(async (account: any, name: string, parent: string) => `${account?.id ?? ''}/${parent}/${name}`)
    const onA = await ensureFolderStorageLocation('user-1', 'movies', 'acc-a')
    const onB = await ensureFolderStorageLocation('user-1', 'movies', 'acc-b')
    expect(onA.location.connectedAccountId).toBe('acc-a')
    expect(onB.location.connectedAccountId).toBe('acc-b')
    expect(onA.location.providerFolderId).toBe('acc-a/ROOT/Movies')
    expect(onB.location.providerFolderId).toBe('acc-b/ROOT/Movies')
    expect(onA.location.providerFolderId).not.toBe(onB.location.providerFolderId)
    expect(h.locations).toHaveLength(2)
  })

  it('derives an S3 location from the prefix chain without provider creates', async () => {
    h.folders.push(h.folder('movies', 'Movies'), h.folder('action', 'Action', 'movies'))
    const result = await ensureFolderStorageLocation('user-1', 'action', 'acc-s3')
    // S3 createProviderFolder joins prefixes; ensureProviderRoot returns the prefix.
    expect(result.location.provider).toBe('s3')
    expect(result.location.providerFolderId).toBe('ROOT/Movies/Action')
    expect(result.createdCount).toBe(2)
  })

  it('recovers from a P2002 race by re-reading the concurrent row and continuing upward', async () => {
    h.folders.push(h.folder('movies', 'Movies'), h.folder('action', 'Action', 'movies'))
    // Simulate a concurrent upload having created the "movies" level after our
    // initial read: the first create() (for "movies") throws P2002, and the
    // re-read findUnique returns the winner's row.
    const createMock = h.prismaMock.folderStorageLocation.create as ReturnType<typeof vi.fn>
    createMock.mockImplementationOnce(async ({ data }: { data: { folderId: string } }) => {
      throw h.p2002Ref!('Unique constraint failed')
    })
    ;(h.prismaMock.folderStorageLocation.findUnique as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where: { folderId_connectedAccountId: { folderId: string; connectedAccountId: string } } }) => {
      const { folderId, connectedAccountId } = where.folderId_connectedAccountId
      const existing = h.locations.find((l) => l.folderId === folderId && l.connectedAccountId === connectedAccountId)
      // The winner's row for the movies level appears "concurrently".
      if (folderId === 'movies') return { id: 'winner-movies', folderId, connectedAccountId, provider: 'google_drive', providerFolderId: 'winner-drive-movies' }
      return existing ?? null
    })
    const result = await ensureFolderStorageLocation('user-1', 'action', 'acc-a')
    // Movies level reused the winner's row; Action was created under it.
    expect(result.createdCount).toBe(1)
    expect(result.location.providerFolderId).toBe('winner-drive-movies/Action')
    expect(createProviderFolder).toHaveBeenNthCalledWith(2, expect.anything(), 'Action', 'winner-drive-movies')
  })

  it('throws FOLDER_MATERIALIZATION_FAILED when the unique violation keeps repeating', async () => {
    h.folders.push(h.folder('movies', 'Movies'))
    const createMock = h.prismaMock.folderStorageLocation.create as ReturnType<typeof vi.fn>
    createMock.mockImplementation(async () => {
      throw h.p2002Ref!('Unique constraint failed')
    })
    ;(h.prismaMock.folderStorageLocation.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await expect(ensureFolderStorageLocation('user-1', 'movies', 'acc-a')).rejects.toMatchObject({ code: 'FOLDER_MATERIALIZATION_FAILED' })
  })

  it('is deterministic: calling twice creates only once', async () => {
    h.folders.push(h.folder('movies', 'Movies'))
    const first = await ensureFolderStorageLocation('user-1', 'movies', 'acc-a')
    const second = await ensureFolderStorageLocation('user-1', 'movies', 'acc-a')
    expect(first.location.id).toBe(second.location.id)
    expect(second.createdCount).toBe(0)
    expect(h.locations).toHaveLength(1)
    expect(createProviderFolder).toHaveBeenCalledTimes(1)
  })
})
