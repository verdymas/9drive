import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebDavMetadataCache } from './webdav-metadata-cache.js'

const h = vi.hoisted(() => ({
  folderFindFirst: vi.fn(),
  folderFindMany: vi.fn(),
  fileFindFirst: vi.fn(),
  fileFindMany: vi.fn(),
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    folder: { findFirst: h.folderFindFirst, findMany: h.folderFindMany },
    file: { findFirst: h.fileFindFirst, findMany: h.fileFindMany },
  },
}))

const movies = {
  id: 'folder-movies',
  parentId: null,
  provider: 'google_drive',
  name: 'Movies',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  deletedAt: null,
}

const unicodeFile = {
  id: 'file-cafe',
  folderId: 'folder-movies',
  provider: 's3',
  providerFileId: 'provider-cafe',
  name: 'café.txt',
  mimeType: 'text/plain',
  sizeBytes: 12n,
  status: 'active',
  createdAt: new Date('2026-01-03T00:00:00.000Z'),
  updatedAt: new Date('2026-01-04T00:00:00.000Z'),
}

const folderMetadataSelect = {
  id: true,
  parentId: true,
  provider: true,
  providerFolderId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
}

const fileMetadataSelect = {
  id: true,
  folderId: true,
  connectedAccountId: true,
  provider: true,
  providerFileId: true,
  name: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  updatedAt: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.folderFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.parentId === null && where.deletedAt === null && where.name === 'Movies') return movies
    return null
  })
  h.fileFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.folderId === 'folder-movies' && where.status === 'active' && where.name === 'café.txt') return unicodeFile
    return null
  })
  h.folderFindMany.mockImplementation(async () => [])
  h.fileFindMany.mockImplementation(async () => [])
})

function isolatedMetadataCache() {
  return new WebDavMetadataCache({ ttlMs: 0, maxEntries: 0, logger: () => undefined })
}

describe('VirtualFileSystem exact WebDAV path lookups', () => {
  it('treats root as a virtual resource without querying a sibling collection', async () => {
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ metadataCache: isolatedMetadataCache() })

    await expect(fs.resolvePath('/')).resolves.toBeNull()
    expect(h.folderFindMany).not.toHaveBeenCalled()
    expect(h.fileFindMany).not.toHaveBeenCalled()
    expect(h.folderFindFirst).not.toHaveBeenCalled()
    expect(h.fileFindFirst).not.toHaveBeenCalled()
  })

  it('resolves nested Unicode file names with exact child predicates', async () => {
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ metadataCache: isolatedMetadataCache() })

    await expect(fs.resolvePath('/Movies/café.txt')).resolves.toMatchObject({
      id: 'file-cafe',
      type: 'file',
      name: 'café.txt',
      sizeBytes: 12n,
    })

    expect(h.folderFindFirst).toHaveBeenCalledWith({
      where: { parentId: null, deletedAt: null, name: 'Movies' },
      select: folderMetadataSelect,
    })
    expect(h.fileFindFirst).toHaveBeenCalledWith({
      where: { folderId: 'folder-movies', status: 'active', name: 'café.txt' },
      select: fileMetadataSelect,
    })
    expect(h.folderFindMany).not.toHaveBeenCalled()
    expect(h.fileFindMany).not.toHaveBeenCalled()
  })

  it('keeps folder-before-file precedence for a name collision', async () => {
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ metadataCache: isolatedMetadataCache() })
    const collisionFolder = { ...movies, id: 'folder-collision', parentId: null, name: 'Movies' }
    h.folderFindFirst.mockResolvedValueOnce(collisionFolder)
    h.folderFindFirst.mockResolvedValueOnce({ ...movies, id: 'folder-child', parentId: 'folder-collision', name: 'same-name' })

    await expect(fs.resolvePath('/Movies/same-name')).resolves.toMatchObject({
      id: 'folder-child',
      type: 'folder',
    })
    expect(h.fileFindFirst).not.toHaveBeenCalled()
  })

  it('does not resolve deleted folders or files', async () => {
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ metadataCache: isolatedMetadataCache() })

    await expect(fs.resolvePath('/Deleted')).resolves.toBeNull()
    expect(h.folderFindFirst).toHaveBeenCalledWith({
      where: { parentId: null, deletedAt: null, name: 'Deleted' },
      select: folderMetadataSelect,
    })

    h.folderFindFirst.mockResolvedValueOnce(movies)
    await expect(fs.resolvePath('/Movies/deleted.txt')).resolves.toBeNull()
    expect(h.fileFindFirst).toHaveBeenCalledWith({
      where: { folderId: 'folder-movies', status: 'active', name: 'deleted.txt' },
      select: fileMetadataSelect,
    })
  })

  it('does not load every sibling when resolving a deep path in a large directory', async () => {
    h.folderFindMany.mockRejectedValue(new Error('sibling collection scan is forbidden'))
    h.fileFindMany.mockRejectedValue(new Error('sibling collection scan is forbidden'))

    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ metadataCache: isolatedMetadataCache() })

    await expect(fs.resolvePath('/Movies/café.txt')).resolves.toMatchObject({ id: 'file-cafe', type: 'file' })
    expect(h.folderFindMany).not.toHaveBeenCalled()
    expect(h.fileFindMany).not.toHaveBeenCalled()
  })

  it('lists WebDAV file metadata without hydrating a connected account', async () => {
    const listedFile = {
      ...unicodeFile,
      connectedAccountId: 'account-s3',
      connectedAccount: {
        id: 'account-s3',
        accessTokenEncrypted: 'must-not-be-selected',
        refreshTokenEncrypted: 'must-not-be-selected',
      },
    }
    h.fileFindMany.mockImplementationOnce(async ({ select }: { select?: Record<string, boolean> }) => {
      if (!select) return [listedFile]
      return [Object.fromEntries(Object.keys(select).map((key) => [key, listedFile[key as keyof typeof listedFile]]))]
    })

    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ metadataCache: isolatedMetadataCache() })
    const listed = await fs.listFilesUnder('folder-movies')

    expect(listed[0]).toMatchObject({ id: 'file-cafe', name: 'café.txt', provider: 's3', sizeBytes: 12n })
    expect(listed[0]).not.toHaveProperty('connectedAccount')
    expect(h.fileFindMany).toHaveBeenCalledWith({
      where: { folderId: 'folder-movies', status: 'active' },
      select: fileMetadataSelect,
    })
  })

  it('keeps directory enumeration names and metadata separate from exact resolution', async () => {
    h.folderFindMany.mockResolvedValueOnce([
      { ...movies, id: 'folder-action', parentId: 'folder-movies', name: 'Action' },
    ])
    h.fileFindMany.mockResolvedValueOnce([
      { ...unicodeFile, connectedAccountId: 'account-s3', name: 'listed.txt' },
    ])

    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ metadataCache: isolatedMetadataCache() })
    const [folders, files] = await Promise.all([fs.listFoldersUnder('folder-movies'), fs.listFilesUnder('folder-movies')])

    expect(folders.map((folder) => folder.name)).toEqual(['Action'])
    expect(folders[0]).toMatchObject({ id: 'folder-action', provider: 'google_drive' })
    expect(files.map((file) => file.name)).toEqual(['listed.txt'])
    expect(files[0]).toMatchObject({ id: 'file-cafe', provider: 's3', mimeType: 'text/plain', sizeBytes: 12n })
    expect(h.folderFindMany).toHaveBeenCalledWith({
      where: { parentId: 'folder-movies', deletedAt: null },
      select: folderMetadataSelect,
    })
  })

  it('loads provider-account data only for the file selected for streaming', async () => {
    const streamableFile = {
      ...unicodeFile,
      connectedAccountId: 'account-s3',
      connectedAccount: { id: 'account-s3', provider: 's3', secretAccessKeyEncrypted: 'selected-for-stream' },
    }
    h.fileFindFirst.mockResolvedValueOnce(streamableFile)

    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ metadataCache: isolatedMetadataCache() })
    const loaded = await fs.getFileForStreaming('file-cafe')

    expect(loaded?.connectedAccount).toMatchObject({ id: 'account-s3', secretAccessKeyEncrypted: 'selected-for-stream' })
    expect(h.fileFindFirst).toHaveBeenCalledWith({
      where: { id: 'file-cafe', status: 'active' },
      include: { connectedAccount: true },
    })
  })

  it('reuses exact metadata lookups across requests through a bounded TTL cache', async () => {
    const metadataCache = new WebDavMetadataCache({ ttlMs: 1_000, maxEntries: 20, logger: () => undefined })
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ namespace: 'namespace-a', metadataCache })

    await expect(fs.resolvePath('/Movies/café.txt')).resolves.toMatchObject({ id: 'file-cafe' })
    fs.reset()
    await expect(fs.resolvePath('/Movies/café.txt')).resolves.toMatchObject({ id: 'file-cafe' })

    expect(h.folderFindFirst).toHaveBeenCalledTimes(2)
    expect(h.fileFindFirst).toHaveBeenCalledTimes(1)
    expect(metadataCache.snapshot()).toMatchObject({ misses: 3, hits: 3, entries: 3 })
  })

  it('makes a renamed metadata row visible immediately after namespace invalidation', async () => {
    let currentName = 'café.txt'
    h.fileFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.folderId === 'folder-movies' && where.status === 'active' && where.name === currentName) {
        return { ...unicodeFile, name: currentName }
      }
      return null
    })
    const metadataCache = new WebDavMetadataCache({ ttlMs: 10_000, maxEntries: 20, logger: () => undefined })
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ namespace: 'namespace-a', metadataCache })

    await expect(fs.resolvePath('/Movies/café.txt')).resolves.toMatchObject({ id: 'file-cafe', name: 'café.txt' })
    currentName = 'renamed.txt'
    metadataCache.invalidateNamespace('namespace-a')
    fs.reset()

    await expect(fs.resolvePath('/Movies/café.txt')).resolves.toBeNull()
    await expect(fs.resolvePath('/Movies/renamed.txt')).resolves.toMatchObject({ id: 'file-cafe', name: 'renamed.txt' })
  })

  it('makes a deleted metadata row invisible after the configured TTL', async () => {
    let now = 1_000
    let available = true
    h.fileFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (available && where.folderId === 'folder-movies' && where.status === 'active' && where.name === 'café.txt') return unicodeFile
      return null
    })
    const metadataCache = new WebDavMetadataCache({ ttlMs: 100, maxEntries: 20, now: () => now, logger: () => undefined })
    const { VirtualFileSystem } = await import('./webdav-virtual-fs.js')
    const fs = new VirtualFileSystem({ namespace: 'namespace-a', metadataCache })

    await expect(fs.resolvePath('/Movies/café.txt')).resolves.toMatchObject({ id: 'file-cafe' })
    available = false
    fs.reset()
    now += 100

    await expect(fs.resolvePath('/Movies/café.txt')).resolves.toBeNull()
  })
})
