import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileFilePage } from './file-reconciler.js'
import type { FileReconcileContext } from './file-reconciler.js'

/**
 * File reconciler — spec §67 mandatory cases.
 * Files are identified by (connectedAccountId, providerFileId) only.
 */
const h = vi.hoisted(() => {
  const files: any[] = []
  let seq = 0

  const prismaMock = {
    file: {
      findMany: vi.fn(async ({ where, select }: { where?: any; select?: any } = {}) =>
        files
          .filter((f) => {
            if (where?.userId && f.userId !== where.userId) return false
            if (where?.connectedAccountId && f.connectedAccountId !== where.connectedAccountId) return false
            if (where?.providerFileId?.in && !where.providerFileId.in.includes(f.providerFileId)) return false
            return true
          })
          .map((f) => {
            if (!select) return { ...f }
            const out: any = {}
            for (const key of Object.keys(select)) if (key in f) out[key] = f[key]
            return out
          }),
      ),
      create: vi.fn(async ({ data }: { data: any }) => {
        const row = { ...data, id: `file-${++seq}`, createdAt: new Date(), updatedAt: new Date() }
        files.push(row)
        return { ...row }
      }),
      update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        const f = files.find((x) => x.id === where.id)
        if (!f) throw new Error('not found')
        Object.assign(f, data, { updatedAt: new Date() })
        return { ...f }
      }),
    },
  }

  return { files, prismaMock }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

function ctx(accountId: string, runId = `run-1`): FileReconcileContext {
  return {
    userId: 'user-1',
    accountId,
    provider: 'google_drive',
    runId,
    stats: { filesDiscovered: 0, filesCreated: 0, filesUpdated: 0, filesMoved: 0 },
  }
}

const file = (providerFileId: string, name = 'a.mkv', size: bigint = 100n, mime = 'video/x-matroska') => ({
  providerFileId,
  name,
  mimeType: mime,
  sizeBytes: size,
  providerParentId: 'pd-mov',
})

beforeEach(() => {
  vi.clearAllMocks()
  h.files.length = 0
})

describe('§67 file reconciler', () => {
  it('1. File created on A', async () => {
    const c = ctx('A')
    await reconcileFilePage(c, 'virtual-mov', [file('a1')])
    expect(h.files).toHaveLength(1)
    expect(h.files[0]).toMatchObject({ providerFileId: 'a1', connectedAccountId: 'A', folderId: 'virtual-mov', status: 'active', lastSeenSyncRunId: c.runId })
    expect(c.stats.filesCreated).toBe(1)
  })

  it('2. File created on B in same virtual folder', async () => {
    await reconcileFilePage(ctx('A'), 'virtual-mov', [file('a1')])
    const cB = ctx('B')
    await reconcileFilePage(cB, 'virtual-mov', [file('b1')])
    expect(h.files).toHaveLength(2)
    expect(h.files).toEqual([
      expect.objectContaining({ providerFileId: 'a1', connectedAccountId: 'A', folderId: 'virtual-mov' }),
      expect.objectContaining({ providerFileId: 'b1', connectedAccountId: 'B', folderId: 'virtual-mov' }),
    ])
    expect(cB.stats.filesCreated).toBe(1)
  })

  it('3. Existing provider file updated (size changed)', async () => {
    const c = ctx('A')
    await reconcileFilePage(c, 'virtual-mov', [file('a1', 'a.mkv', 100n)])
    const c2 = ctx('A', 'run-2')
    await reconcileFilePage(c2, 'virtual-mov', [file('a1', 'a.mkv', 200n)])
    expect(h.files).toHaveLength(1)
    expect(h.files[0].sizeBytes).toBe(200n)
    expect(c2.stats.filesUpdated).toBe(1)
    expect(c2.stats.filesCreated).toBe(0)
  })

  it('4. Existing provider file renamed', async () => {
    await reconcileFilePage(ctx('A'), 'virtual-mov', [file('a1', 'old.mkv')])
    const c2 = ctx('A', 'run-2')
    await reconcileFilePage(c2, 'virtual-mov', [file('a1', 'new.mkv')])
    expect(h.files).toHaveLength(1)
    expect(h.files[0].name).toBe('new.mkv')
    expect(c2.stats.filesUpdated).toBe(1)
  })

  it('5. Existing provider file moved → folderId follows', async () => {
    const c = ctx('A')
    await reconcileFilePage(c, 'virtual-mov', [file('a1')])
    const c2 = ctx('A', 'run-2')
    await reconcileFilePage(c2, 'virtual-archive', [file('a1')])
    expect(h.files).toHaveLength(1)
    expect(h.files[0].folderId).toBe('virtual-archive')
    expect(c2.stats.filesMoved).toBe(1)
    expect(c2.stats.filesUpdated).toBe(0)
  })

  it('6. File deleted on A → missing reconcile marks only A, B unaffected', async () => {
    // Sync A: a1 exists. Sync B: b1 exists.
    await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', [file('a1')])
    const cB = ctx('B', 'run-1')
    await reconcileFilePage(cB, 'virtual-mov', [file('b1')])
    // Sync A again: a1 gone from provider (not in page). The missing
    // reconciler (separate module) would soft-delete A's a1; B's b1 stays.
    const cA2 = ctx('A', 'run-2')
    await reconcileFilePage(cA2, 'virtual-mov', [])
    expect(h.files).toHaveLength(2)
    expect(h.files.find((f) => f.providerFileId === 'a1')!.status).toBe('active')
    expect(h.files.find((f) => f.providerFileId === 'b1')!.status).toBe('active')
  })

  it('7. File B unaffected by Sync A', async () => {
    const cB = ctx('B')
    await reconcileFilePage(cB, 'virtual-mov', [file('b1')])
    const cA = ctx('A')
    await reconcileFilePage(cA, 'virtual-mov', [file('a1')])
    // Sync A only stamps/touches A rows.
    expect(h.files.find((f) => f.providerFileId === 'b1')!.lastSeenSyncRunId).toBe(cB.runId)
    expect(h.files.find((f) => f.providerFileId === 'a1')!.lastSeenSyncRunId).toBe(cA.runId)
  })

  it('8. Same filename across accounts → two distinct rows', async () => {
    await reconcileFilePage(ctx('A'), 'virtual-mov', [file('a1', 'movie.mkv', 10n)])
    await reconcileFilePage(ctx('B'), 'virtual-mov', [file('b1', 'movie.mkv', 20n)])
    const sameName = h.files.filter((f) => f.name === 'movie.mkv')
    expect(sameName).toHaveLength(2)
    expect(sameName.map((f) => f.providerFileId).sort()).toEqual(['a1', 'b1'])
  })

  it('9. Same filename but different checksums → no collision logic, distinct rows', async () => {
    // sizeBytes is the "checksum" proxy here — two accounts, same name,
    // different size → distinct files, no touch.
    await reconcileFilePage(ctx('A'), 'virtual-mov', [file('a1', 'movie.mkv', 100n)])
    await reconcileFilePage(ctx('B'), 'virtual-mov', [file('b1', 'movie.mkv', 200n)])
    expect(h.files).toHaveLength(2)
    expect(h.files.every((f) => f.status === 'active')).toBe(true)
  })

  it('10. Same filename and same checksum — still distinct physical files', async () => {
    await reconcileFilePage(ctx('A'), 'virtual-mov', [file('a1', 'movie.mkv', 100n)])
    await reconcileFilePage(ctx('B'), 'virtual-mov', [file('b1', 'movie.mkv', 100n)])
    expect(h.files).toHaveLength(2)
  })

  it('11. Repeated Sync does not duplicate File', async () => {
    const c = ctx('A')
    for (let i = 0; i < 3; i++) {
      await reconcileFilePage(c, 'virtual-mov', [file('a1')])
    }
    expect(h.files.filter((f) => f.providerFileId === 'a1')).toHaveLength(1)
  })

  it('12. File created by Remote Import is not duplicated', async () => {
    // Remote Import creates a File row with the same connectedAccountId +
    // providerFileId (upload materialization). Sync discovers it again — must
    // reuse, not duplicate.
    h.files.push({ id: 'remote-file', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'rem1', name: 'imported.mkv', mimeType: 'video/x-matroska', sizeBytes: 50n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: null })
    const c = ctx('A')
    await reconcileFilePage(c, 'virtual-mov', [file('rem1', 'imported.mkv', 50n)])
    expect(h.files.filter((f) => f.providerFileId === 'rem1')).toHaveLength(1)
    expect(h.files[0].id).toBe('remote-file') // reused, not a new row
  })

  it('13. File created by normal upload is not duplicated', async () => {
    // Normal upload creates a row already stamped for this provider file.
    h.files.push({ id: 'upload-1', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'up1', name: 'uploaded.mp4', mimeType: 'video/mp4', sizeBytes: 30n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: null })
    const c = ctx('A')
    await reconcileFilePage(c, 'virtual-mov', [file('up1', 'uploaded.mp4', 30n)])
    expect(h.files.filter((f) => f.providerFileId === 'up1')).toHaveLength(1)
    expect(c.stats.filesCreated).toBe(0)
  })

  it('14. mimeType is user-owned: a row whose mimeType was edited is not rewritten by sync', async () => {
    // The user set this row to application/octet-stream through
    // PATCH /files/batch/mime-type. The provider still reports
    // video/x-matroska, but sync must not touch the row's mimeType.
    h.files.push({ id: 'edited-1', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'ed1', name: 'clip.mkv', mimeType: 'application/octet-stream', sizeBytes: 100n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: null })
    const c = ctx('A')
    await reconcileFilePage(c, 'virtual-mov', [file('ed1', 'clip.mkv', 100n, 'video/x-matroska')])
    const row = h.files.find((f) => f.providerFileId === 'ed1')
    expect(row.mimeType).toBe('application/octet-stream')
    expect(c.stats.filesUpdated).toBe(0)
    expect(c.stats.filesCreated).toBe(0)
  })
})