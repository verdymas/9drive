import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const prismaMock = {
    connectedAccount: { findFirst: vi.fn() },
    file: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    folder: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  }
  return { prismaMock }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('./telegram-usage.service.js', () => ({ syncTelegramUsage: vi.fn() }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn() }))
vi.mock('./telegram.service.js', async () => {
  const actual = await vi.importActual<typeof import('./telegram.service.js')>('./telegram.service.js')
  return {
    ...actual,
    listTelegramDocuments: vi.fn(),
    getTelegramConfig: vi.fn(),
    withTelegramClient: vi.fn(),
  }
})

import { ensureFolderPathBySegments, ingestTelegramDocument, joinLogicalPath } from './telegram-ingest.service.js'

const document = {
  remoteId: 'telegram://4458806678/42',
  name: 'architecture.md',
  size: 1024,
  mimeType: 'text/markdown',
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default folder.create returns a synthetic id derived from parent + name.
  h.prismaMock.folder.create.mockImplementation(async ({ data }: any) => ({ id: `${data.parentId ?? 'root'}/${data.name}` }))
  h.prismaMock.folder.findFirst.mockResolvedValue(null)
  h.prismaMock.file.findFirst.mockResolvedValue(null)
  h.prismaMock.file.create.mockResolvedValue({ id: 'new-file' })
  h.prismaMock.file.update.mockResolvedValue({ id: 'updated-file' })
})

describe('ingestTelegramDocument — by 9drive:id', () => {
  it('updates the matching logical file when the path changes', async () => {
    // By stable id — found.
    h.prismaMock.file.findFirst
      .mockResolvedValueOnce({ id: 'file-1', providerFileId: document.remoteId })

    // The second findFirst (inside updateFromParsed) reads the current row.
    h.prismaMock.file.findFirst.mockResolvedValueOnce({
      id: 'file-1',
      providerFileId: document.remoteId,
      name: 'old.md',
      folderId: 'oldFolder',
      mimeType: 'text/plain',
      sizeBytes: 100n,
      telegramStableId: 'stable-1',
    })

    const result = await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-1\n9drive:path=Projects/APP-V/docs/architecture.md',
    )

    expect(result).toBe('updated')
    expect(h.prismaMock.file.update).toHaveBeenCalledTimes(1)
    const args = h.prismaMock.file.update.mock.calls[0]?.[0]
    expect(args.data.name).toBe('architecture.md')
    // folder chain: Projects → APP-V → docs → leaf = 'root/Projects/APP-V/docs'
    expect(args.data.folderId).toBe('root/Projects/APP-V/docs')
  })

  it('returns "matched" when nothing changed', async () => {
    h.prismaMock.file.findFirst.mockResolvedValueOnce({ id: 'file-1', providerFileId: document.remoteId })
    h.prismaMock.file.findFirst.mockResolvedValueOnce({
      id: 'file-1',
      providerFileId: document.remoteId,
      name: 'architecture.md',
      folderId: 'root/Projects/APP-V/docs',
      mimeType: 'text/markdown',
      sizeBytes: 1024n,
      telegramStableId: 'stable-1',
    })
    h.prismaMock.folder.findFirst.mockImplementation(async () => {
      return { id: 'root/Projects/APP-V/docs', name: 'docs', parentId: 'root/Projects/APP-V', normalizedName: 'docs', deletedAt: null }
    })

    const result = await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-1\n9drive:path=Projects/APP-V/docs/architecture.md',
    )

    expect(result).toBe('matched')
    expect(h.prismaMock.file.update).not.toHaveBeenCalled()
  })
})

describe('ingestTelegramDocument — by providerFileId only', () => {
  it('creates a row when only the path is supplied', async () => {
    // No stable id match (case 1 → not found), then no providerFileId match
    // (case 2 → not found) → case 2 creates a row.
    h.prismaMock.file.findFirst.mockResolvedValue(null)

    const result = await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:path=Projects/APP-V/docs/architecture.md',
    )

    expect(result).toBe('inboxed') // no stable id, so it routes as inbox
    expect(h.prismaMock.file.create).toHaveBeenCalledTimes(1)
  })
})

describe('ingestTelegramDocument — no metadata', () => {
  it('routes to the inbox when the caption has no 9Drive keys', async () => {
    const result = await ingestTelegramDocument('user-1', 'acc-1', document, 'human caption, no metadata')
    expect(result).toBe('inboxed')
    expect(h.prismaMock.file.create).toHaveBeenCalledTimes(1)
  })

  it('returns "matched" when a physical-only row already exists', async () => {
    // caption=null → no stableId, no logicalPath → Case 3 only, which calls
    // findFirst by providerFileId. A single mocked call returns the existing row.
    h.prismaMock.file.findFirst
      .mockResolvedValueOnce({ id: 'existing', mimeType: 'text/markdown', sizeBytes: 1024n, providerFileId: document.remoteId })

    const result = await ingestTelegramDocument('user-1', 'acc-1', document, null)
    expect(result).toBe('matched')
  })
})

describe('ensureFolderPathBySegments', () => {
  it('reuses existing folders and creates missing ones', async () => {
    h.prismaMock.folder.findFirst
      .mockResolvedValueOnce({ id: 'p1', name: 'Projects', parentId: null, normalizedName: 'projects', deletedAt: null })
      .mockResolvedValueOnce(null)

    const result = await ensureFolderPathBySegments('user-1', ['Projects', 'APP-V'])
    // folder.create default mock returns `${parentId ?? 'root'}/${name}` → 'p1/APP-V'
    expect(result).toBe('p1/APP-V')
  })

  it('returns null when segments is empty', async () => {
    expect(await ensureFolderPathBySegments('user-1', [])).toBeNull()
  })

  it('returns the parent when a later segment is too long', async () => {
    h.prismaMock.folder.findFirst.mockResolvedValueOnce({ id: 'p1', name: 'OK', parentId: null, normalizedName: 'ok', deletedAt: null })
    const result = await ensureFolderPathBySegments('user-1', ['OK', 'x'.repeat(256)])
    expect(result).toBe('p1')
  })
})

describe('joinLogicalPath', () => {
  it('builds a logical path from segments', () => {
    expect(joinLogicalPath(['A', 'B', 'file.md'])).toBe('A/B/file.md')
  })
  it('returns null for invalid segments', () => {
    expect(joinLogicalPath(['A', 'B:C'])).toBeNull()
  })
})