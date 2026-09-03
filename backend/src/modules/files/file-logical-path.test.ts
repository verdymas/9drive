import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const prismaMock = {
    file: { findFirst: vi.fn() },
    folder: { findMany: vi.fn() },
  }
  return { prismaMock }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

import { logicalPathForFileId, pathFromAncestry } from './file-logical-path.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pathFromAncestry', () => {
  it('builds a path for a root-level file', () => {
    expect(pathFromAncestry({ name: 'note.md', folder: null })).toBe('note.md')
  })

  it('builds a path with a single folder parent', () => {
    expect(
      pathFromAncestry({
        name: 'architecture.md',
        folder: { id: 'f1', name: 'docs', parentId: null },
      }),
    ).toBe('docs/architecture.md')
  })

  it('returns null when the filename contains forbidden characters', () => {
    expect(
      pathFromAncestry({
        name: 'bad:name.md',
        folder: { id: 'f1', name: 'docs', parentId: null },
      }),
    ).toBeNull()
  })
})

describe('logicalPathForFileId', () => {
  it('walks the full folder ancestry and joins the filename', async () => {
    h.prismaMock.file.findFirst.mockResolvedValueOnce({ name: 'architecture.md', folderId: 'docs' })
    h.prismaMock.folder.findMany.mockResolvedValueOnce([
      { id: 'projects', name: 'Projects', parentId: null },
      { id: 'appv', name: 'APP-V', parentId: 'projects' },
      { id: 'docs', name: 'docs', parentId: 'appv' },
    ])
    const path = await logicalPathForFileId('user-1', 'file-1')
    expect(path).toBe('Projects/APP-V/docs/architecture.md')
  })

  it('returns just the filename when the file has no folder', async () => {
    h.prismaMock.file.findFirst.mockResolvedValueOnce({ name: 'note.md', folderId: null })
    const path = await logicalPathForFileId('user-1', 'file-1')
    expect(path).toBe('note.md')
  })

  it('returns null when the file does not exist', async () => {
    h.prismaMock.file.findFirst.mockResolvedValueOnce(null)
    const path = await logicalPathForFileId('user-1', 'missing')
    expect(path).toBeNull()
  })

  it('returns null when the filename is empty', async () => {
    h.prismaMock.file.findFirst.mockResolvedValueOnce({ name: '', folderId: null })
    const path = await logicalPathForFileId('user-1', 'file-1')
    expect(path).toBeNull()
  })
})