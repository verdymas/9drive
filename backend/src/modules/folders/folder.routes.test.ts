import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { folderRouter } from './folder.routes.js'

// ── Mocks ────────────────────────────────────────────────────────────────────
// Drive the REAL folder routes (mounted on a real Express app) with an
// in-memory prisma fake and mocked provider boundaries, per the multi-storage
// spec §45-47: rename renames every physical location, move materializes the
// new parent per account, delete cleans up locations + files per provider, and
// listing exposes storageLocationCount + primaryLocation.
const h = vi.hoisted(() => {
  const now = new Date('2026-08-07T00:00:00.000Z')
  type Folder = {
    id: string
    userId: string
    name: string
    color: string
    iconUrl: string | null
    parentId: string | null
    providerFolderId: string | null
    normalizedName: string | null
    origin: string
    deletedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }
  type Location = {
    id: string
    folderId: string
    connectedAccountId: string
    provider: string
    providerFolderId: string
    createdAt: Date
    updatedAt: Date
  }
  type File = {
    id: string
    userId: string
    folderId: string | null
    connectedAccountId: string
    provider: string
    providerFileId: string
    name: string
    status: string
    deletedAt: Date | null
  }
  const accounts = [
    { id: 'acc-a', userId: 'user-1', provider: 'google_drive' },
    { id: 'acc-b', userId: 'user-1', provider: 'google_drive' },
    { id: 'acc-s3', userId: 'user-1', provider: 's3' },
  ]
  const folders: Folder[] = []
  const locations: Location[] = []
  const files: File[] = []
  let seq = 0

  const folder = (id: string, name: string, parentId: string | null = null, overrides: Partial<Folder> = {}) => {
    const row: Folder = {
      id, userId: 'user-1', name, color: '#3b82f6', iconUrl: 'https://api.iconify.design/lucide:folder.svg',
      parentId, providerFolderId: null, normalizedName: null, origin: 'user', deletedAt: null, createdAt: now, updatedAt: now, ...overrides,
    }
    folders.push(row)
    return row
  }
  const loc = (folderId: string, connectedAccountId: string, providerFolderId: string, provider = 'google_drive', updatedAt: Date = now) => {
    const row: Location = { id: `loc-${++seq}`, folderId, connectedAccountId, provider, providerFolderId, createdAt: now, updatedAt }
    locations.push(row)
    return row
  }
  const file = (id: string, folderId: string | null, connectedAccountId: string, provider: string, providerFileId: string, name: string) => {
    const row: File = { id, userId: 'user-1', folderId, connectedAccountId, provider, providerFileId, name, status: 'active', deletedAt: null }
    files.push(row)
    return row
  }

  const matchFolder = (f: Folder, where: any) => {
    if (where?.userId && f.userId !== where.userId) return false
    if (where?.deletedAt !== undefined) {
      if (where.deletedAt === null && f.deletedAt !== null) return false
      if (where.deletedAt !== null && f.deletedAt === null) return false
    }
    if (where?.parentId !== undefined && where.parentId !== null && f.parentId !== where.parentId) return false
    if (where?.parentId === null && f.parentId !== null) return false
    if (where?.id !== undefined) {
      if (typeof where.id === 'string' && f.id !== where.id) return false
      if (Array.isArray(where.id?.in) && !where.id.in.includes(f.id)) return false
    }
    if (where?.id?.not && f.id === where.id.not) return false
    return true
  }

  const prismaMock = {
    folder: {
      findMany: vi.fn(async ({ where, select }: { where?: any; select?: any } = {}) =>
        folders
          .filter((f) => matchFolder(f, where))
          .map((f) => ({
            ...f,
            ...(select?._count ? { _count: { storageLocations: locations.filter((l) => l.folderId === f.id).length } } : {}),
          })),
      ),
      findFirst: vi.fn(async ({ where }: { where?: any } = {}) => {
        const f = folders.find((x) => matchFolder(x, where) && (where?.normalizedName === undefined || x.normalizedName === where.normalizedName))
        return f ?? null
      }),
      findFirstOrThrow: vi.fn(async ({ where, include }: { where?: any; include?: any } = {}) => {
        const f = folders.find((x) => matchFolder(x, where))
        if (!f) throw new Error('Folder not found')
        const base = { ...f }
        if (include?.storageLocations) {
          return {
            ...base,
            storageLocations: locations.filter((l) => l.folderId === f.id).map((l) => ({
              ...l,
              connectedAccount: accounts.find((a) => a.id === l.connectedAccountId) ?? { id: l.connectedAccountId, provider: l.provider },
            })),
          }
        }
        return base
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        const row: Folder = {
          id: data.id ?? `folder-${++seq}`,
          userId: data.userId,
          name: data.name,
          color: data.color ?? '#3b82f6',
          iconUrl: data.iconUrl ?? 'https://api.iconify.design/lucide:folder.svg',
          parentId: data.parentId ?? null,
          providerFolderId: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }
        folders.push(row)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: { where?: any; data?: any }) => {
        const matched = folders.filter((f) => matchFolder(f, where))
        for (const f of matched) {
          Object.assign(f, data, { updatedAt: new Date() })
        }
        return { count: matched.length }
      }),
    },
    folderStorageLocation: {
      findMany: vi.fn(async ({ where, include }: { where?: any; include?: any } = {}) => {
        const rows = locations.filter((l) => {
          if (where?.folderId?.in && !where.folderId.in.includes(l.folderId)) return false
          if (where?.connectedAccountId && l.connectedAccountId !== where.connectedAccountId) return false
          return true
        })
        if (include?.connectedAccount) {
          return rows.map((l) => ({ ...l, connectedAccount: accounts.find((a) => a.id === l.connectedAccountId) ?? { id: l.connectedAccountId, provider: l.provider } }))
        }
        return rows
      }),
      deleteMany: vi.fn(async ({ where }: { where?: any } = {}) => {
        const before = locations.length
        for (let i = locations.length - 1; i >= 0; i--) {
          const l = locations[i]
          if (where?.folderId?.in && !where.folderId.in.includes(l.folderId)) continue
          locations.splice(i, 1)
        }
        return { count: before - locations.length }
      }),
    },
    file: {
      findMany: vi.fn(async ({ where, include }: { where?: any; include?: any } = {}) => {
        const rows = files.filter((f) => {
          if (where?.userId && f.userId !== where.userId) return false
          if (where?.status && f.status !== where.status) return false
          if (where?.provider && f.provider !== where.provider) return false
          if (where?.folderId?.in && !where.folderId.in.includes(f.folderId)) return false
          return true
        })
        if (include?.connectedAccount) {
          return rows.map((f) => ({ ...f, connectedAccount: accounts.find((a) => a.id === f.connectedAccountId) ?? { id: f.connectedAccountId, provider: f.provider } }))
        }
        return rows
      }),
      updateMany: vi.fn(async ({ where, data }: { where?: any; data?: any }) => {
        const matched = files.filter((f) => {
          if (where?.id?.in && !where.id.in.includes(f.id)) return false
          if (where?.userId && f.userId !== where.userId) return false
          return true
        })
        for (const f of matched) Object.assign(f, data)
        return { count: matched.length }
      }),
    },
    connectedAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => accounts.find((a) => a.id === where.id) ?? null),
    },
  }

  return {
    prismaMock, accounts, folders, locations, files, folder, loc, file, now,
    rename: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    deleteLoc: vi.fn(async () => undefined),
    root: vi.fn(async () => 'ROOT'),
    materialize: vi.fn(async (_userId: string, parentId: string, connectedAccountId: string) => ({
      location: { id: `loc-${parentId}-${connectedAccountId}`, folderId: parentId, connectedAccountId, provider: 'google_drive', providerFolderId: `parent-${parentId}-${connectedAccountId}` },
      createdCount: 1,
    })),
    deleteDriveFile: vi.fn(async () => ({})),
    deleteS3File: vi.fn(async () => undefined),
    refreshTelegramCaption: vi.fn(async () => undefined),
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

// The router mounts requireAuth at module scope — short-circuit it with a
// canned user so the route handlers run with req.user set.
vi.mock('../../middleware/auth.middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', sessionId: 'sess-1' }
    next()
  },
}))

vi.mock('../storage/provider-folder.service.js', () => ({
  renameProviderFolder: (...args: unknown[]) => h.rename(...args),
  moveProviderFolder: (...args: unknown[]) => h.move(...args),
  deleteProviderFolder: (...args: unknown[]) => h.deleteLoc(...args),
  ensureProviderRoot: (...args: unknown[]) => h.root(...args),
}))

vi.mock('../storage/folder-materialization.service.js', () => ({
  ensureFolderStorageLocation: (...args: unknown[]) => h.materialize(...args),
}))

vi.mock('../telegram/telegram-caption-refresh.js', () => ({
  refreshTelegramCaption: (...args: unknown[]) => h.refreshTelegramCaption(...args),
}))

// The delete route calls google.drive() directly for google files — mock the
// drive client factory so files.delete is captured.
vi.mock('googleapis', () => ({
  google: { drive: vi.fn(() => ({ files: { delete: (...args: unknown[]) => h.deleteDriveFile(...args) } })) },
}))

vi.mock('../google/google.service.js', () => ({
  getAuthedGoogleClient: vi.fn(async () => ({})),
  syncGoogleQuota: vi.fn(async () => undefined),
}))

vi.mock('../s3/s3.service.js', () => ({
  deleteS3Object: (...args: unknown[]) => h.deleteS3File(...args),
  syncS3Quota: vi.fn(async () => undefined),
}))

vi.mock('../../utils/audit.js', () => ({
  createAuditLog: vi.fn(async () => undefined),
}))

// ── App + HTTP harness ───────────────────────────────────────────────────────
let server: http.Server
let baseUrl: string

const app = express()
app.use(express.json())
app.use('/folders', folderRouter)

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/folders${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

function reset() {
  vi.clearAllMocks()
  h.folders.length = 0
  h.locations.length = 0
  h.files.length = 0
  h.rename.mockImplementation(async () => undefined)
  h.move.mockImplementation(async () => undefined)
  h.deleteLoc.mockImplementation(async () => undefined)
  h.root.mockImplementation(async () => 'ROOT')
  h.deleteDriveFile.mockImplementation(async () => ({}))
  h.deleteS3File.mockImplementation(async () => undefined)
  h.refreshTelegramCaption.mockImplementation(async () => undefined)
  h.materialize.mockImplementation(async (_userId: string, parentId: string, connectedAccountId: string) => ({
    location: { id: `loc-${parentId}-${connectedAccountId}`, folderId: parentId, connectedAccountId, provider: 'google_drive', providerFolderId: `parent-${parentId}-${connectedAccountId}` },
    createdCount: 1,
  }))
}

beforeAll(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('GET /folders — listing', () => {
  beforeEach(reset)

  it('exposes storageLocationCount and the most-recent primaryLocation per folder', async () => {
    h.folder('movies', 'Movies')
    h.loc('movies', 'acc-a', 'drive-movies-a', 'google_drive', new Date('2026-08-07T00:00:00.000Z'))
    h.loc('movies', 'acc-b', 'drive-movies-b', 'google_drive', new Date('2026-08-07T01:00:00.000Z'))
    h.folder('empty', 'Empty')

    const { status, json } = await api('GET', '/')
    expect(status).toBe(200)
    const movies = json.folders.find((f: any) => f.id === 'movies')
    expect(movies.storageLocationCount).toBe(2)
    // Most recent location wins the primary slot.
    expect(movies.primaryLocation).toMatchObject({ connectedAccountId: 'acc-b', provider: 'google_drive', providerFolderId: 'drive-movies-b' })
    const empty = json.folders.find((f: any) => f.id === 'empty')
    expect(empty.storageLocationCount).toBe(0)
    expect(empty.primaryLocation).toBeNull()
  })
})

describe('PATCH /folders/:id — rename', () => {
  beforeEach(reset)

  it('updates the virtual name once and renames every physical location on its own account', async () => {
    h.folder('movies', 'Movies')
    h.loc('movies', 'acc-a', 'drive-movies-a', 'google_drive')
    h.loc('movies', 'acc-b', 'drive-movies-b', 'google_drive')

    const { status, json } = await api('PATCH', '/movies', { name: 'Films' })

    expect(status).toBe(200)
    expect(json.folder.name).toBe('Films')
    expect(h.rename).toHaveBeenCalledTimes(2)
    // Each location renamed with the new name, on its own account.
    const calls = (h.rename as ReturnType<typeof vi.fn>).mock.calls
    const accountsRenamed = calls.map((c) => c[0].id).sort()
    expect(accountsRenamed).toEqual(['acc-a', 'acc-b'])
    for (const call of calls) expect(call[2]).toBe('Films')
    const providerIds = calls.map((c) => c[1]).sort()
    expect(providerIds).toEqual(['drive-movies-a', 'drive-movies-b'])
  })
})

describe('PATCH /folders/:id — move', () => {
  beforeEach(reset)

  it('materializes the new virtual parent per account, then moves each physical folder under it', async () => {
    h.folder('movies', 'Movies')
    h.folder('new-parent', 'New Parent')
    h.loc('movies', 'acc-a', 'drive-movies-a', 'google_drive')
    h.loc('movies', 'acc-b', 'drive-movies-b', 'google_drive')

    const { status, json } = await api('PATCH', '/movies', { parentId: 'new-parent' })

    expect(status).toBe(200)
    expect(json.folder.parentId).toBe('new-parent')
    // Parent materialized on BOTH accounts.
    expect(h.materialize).toHaveBeenNthCalledWith(1, 'user-1', 'new-parent', 'acc-a')
    expect(h.materialize).toHaveBeenNthCalledWith(2, 'user-1', 'new-parent', 'acc-b')
    // Each location moved under the account-specific parent location.
    const moveCalls = (h.move as ReturnType<typeof vi.fn>).mock.calls
    expect(moveCalls).toHaveLength(2)
    const moved = moveCalls.map((c) => ({ account: c[0].id, folder: c[1], parent: c[2] }))
    expect(moved).toContainEqual({ account: 'acc-a', folder: 'drive-movies-a', parent: 'parent-new-parent-acc-a' })
    expect(moved).toContainEqual({ account: 'acc-b', folder: 'drive-movies-b', parent: 'parent-new-parent-acc-b' })
  })

  it('moves to root via the provider root when parentId is null', async () => {
    h.folder('movies', 'Movies')
    h.loc('movies', 'acc-a', 'drive-movies-a', 'google_drive')

    const { status } = await api('PATCH', '/movies', { parentId: null })

    expect(status).toBe(200)
    expect(h.materialize).not.toHaveBeenCalled()
    expect(h.root).toHaveBeenCalledTimes(1)
    expect(h.move).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc-a' }), 'drive-movies-a', 'ROOT')
  })

  it('rejects moving a folder into itself or a descendant', async () => {
    h.folder('movies', 'Movies')
    h.folder('child', 'Child', 'movies')
    h.folder('grandchild', 'Grandchild', 'child')

    const self = await api('PATCH', '/movies', { parentId: 'movies' })
    expect(self.status).toBe(400)
    expect(self.json.code).toBe('FOLDER_INVALID_PARENT')

    const descendant = await api('PATCH', '/movies', { parentId: 'grandchild' })
    expect(descendant.status).toBe(400)
    expect(descendant.json.code).toBe('FOLDER_INVALID_PARENT')
  })
})

describe('DELETE /folders/:id', () => {
  beforeEach(reset)

  it('deletes files per provider, physical locations per account, then soft-deletes the tree', async () => {
    h.folder('movies', 'Movies')
    h.folder('child', 'Child', 'movies')
    h.loc('movies', 'acc-a', 'drive-movies-a', 'google_drive')
    h.loc('movies', 'acc-s3', 's3-movies-prefix', 's3')
    h.loc('child', 'acc-b', 'drive-child-b', 'google_drive')
    h.file('f-google', 'child', 'acc-a', 'google_drive', 'drive-file-1', 'a.mp4')
    h.file('f-s3', 'movies', 'acc-s3', 's3', 's3/key', 'b.mkv')

    const { status } = await api('DELETE', '/movies')

    expect(status).toBe(200)
    // Google file deleted via Drive; S3 file via deleteS3Object.
    expect(h.deleteDriveFile).toHaveBeenCalledWith({ fileId: 'drive-file-1' })
    expect(h.deleteS3File).toHaveBeenCalledTimes(1)
    // Every physical folder location deleted (S3 delete is a no-op inside the
    // service, but the route calls it for all locations).
    const deleteLocCalls = (h.deleteLoc as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]).sort()
    expect(deleteLocCalls).toEqual(['drive-child-b', 'drive-movies-a', 's3-movies-prefix'])
    // Location rows removed from the DB fake.
    expect(h.locations).toHaveLength(0)
    // Files + folders soft-deleted.
    expect(h.files.every((f) => f.status === 'deleted')).toBe(true)
    expect(h.folders.every((f) => f.deletedAt !== null)).toBe(true)
  })
})

describe('PATCH /folders/:id — Telegram caption fan-out', () => {
  beforeEach(reset)

  it('renames the virtual folder and refreshes the Telegram caption on every active Telegram descendant file', async () => {
    h.folder('movies', 'Movies')
    h.file('tg-file-1', 'movies', 'acc-a', 'telegram', 'telegram://channel-1/1', 'movie1.mkv')
    h.file('tg-file-2', 'movies', 'acc-a', 'telegram', 'telegram://channel-1/2', 'movie2.mkv')
    h.file('gdrive-file', 'movies', 'acc-a', 'google_drive', 'drive-file-1', 'movie3.mkv')

    const { status } = await api('PATCH', '/movies', { name: 'Films' })

    expect(status).toBe(200)
    // Fan-out ran for both Telegram descendants; non-Telegram files are
    // ignored even though they share the same folder.
    expect(h.refreshTelegramCaption).toHaveBeenCalledTimes(2)
    const refreshed = (h.refreshTelegramCaption as ReturnType<typeof vi.fn>).mock.calls
    const ids = refreshed.map((c) => c[1]).sort()
    expect(ids).toEqual(['tg-file-1', 'tg-file-2'])
    for (const call of refreshed) expect(call[0]).toBe('user-1')
  })

  it('moves the virtual folder and refreshes Telegram captions on descendants', async () => {
    h.folder('movies', 'Movies')
    h.folder('series', 'Series')
    h.file('tg-file-1', 'movies', 'acc-a', 'telegram', 'telegram://channel-1/1', 'ep.mkv')

    const { status } = await api('PATCH', '/movies', { parentId: 'series' })

    expect(status).toBe(200)
    expect(h.refreshTelegramCaption).toHaveBeenCalledTimes(1)
    expect(h.refreshTelegramCaption).toHaveBeenCalledWith('user-1', 'tg-file-1')
  })

  it('does not refresh captions when no body change is requested', async () => {
    h.folder('movies', 'Movies')
    h.file('tg-file-1', 'movies', 'acc-a', 'telegram', 'telegram://channel-1/1', 'ep.mkv')

    // PATCH with empty body — server ignores it.
    const { status } = await api('PATCH', '/movies', { color: '#000000' })

    expect(status).toBe(200)
    expect(h.refreshTelegramCaption).not.toHaveBeenCalled()
  })
})
