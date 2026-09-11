import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reconcileFilePage,
  classifyFilePage,
  emptyFileReconcileDiagnostics,
  mergeFilePageDiagnostics,
  STAMP_BATCH_SIZE,
} from './file-reconciler.js'
import type { FileReconcileContext, ExistingFileRow } from './file-reconciler.js'

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
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        let count = 0
        for (const f of files) {
          if (where?.id?.in && !where.id.in.includes(f.id)) continue
          if (where?.userId && f.userId !== where.userId) continue
          if (where?.connectedAccountId && f.connectedAccountId !== where.connectedAccountId) continue
          if (where?.status && f.status !== where.status) continue
          if (where?.lastSeenSyncRunId?.not !== undefined && f.lastSeenSyncRunId === where.lastSeenSyncRunId.not) continue
          Object.assign(f, data, { updatedAt: new Date() })
          count += 1
        }
        return { count }
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

const dbRow = (over: Partial<ExistingFileRow> & { providerFileId: string }): ExistingFileRow => ({
  id: `file-${over.providerFileId}`,
  name: 'a.mkv',
  mimeType: 'video/x-matroska',
  sizeBytes: 100n,
  folderId: 'virtual-mov',
  status: 'active',
  deletedAt: null,
  lastSeenSyncRunId: null,
  ...over,
})

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

/**
 * Explicit page classification. `classifyFilePage` is pure, so the exact
 * category for every row shape is asserted without a DB double. Phase 2's
 * batching safety depends on `unchanged` being the only stamp-only category.
 */
describe('file page classification', () => {
  const phys = file('a1')

  it('new: no existing row', () => {
    const out = classifyFilePage([], [phys], 'virtual-mov', 'run-1')
    expect(out).toEqual([{ category: 'new', physical: phys, row: null, moved: false }])
  })

  it('unchanged: identical row with a stale generation marker', () => {
    const row = dbRow({ providerFileId: 'a1', lastSeenSyncRunId: 'run-0' })
    const out = classifyFilePage([row], [phys], 'virtual-mov', 'run-1')
    expect(out[0].category).toBe('unchanged')
  })

  it('already_stamped: identical row already stamped by this run', () => {
    const row = dbRow({ providerFileId: 'a1', lastSeenSyncRunId: 'run-1' })
    const out = classifyFilePage([row], [phys], 'virtual-mov', 'run-1')
    expect(out[0].category).toBe('already_stamped')
  })

  it('changed: name or size differs', () => {
    expect(classifyFilePage([dbRow({ providerFileId: 'a1', name: 'old.mkv' })], [phys], 'virtual-mov', 'run-1')[0].category).toBe('changed')
    expect(classifyFilePage([dbRow({ providerFileId: 'a1', sizeBytes: 1n })], [phys], 'virtual-mov', 'run-1')[0].category).toBe('changed')
  })

  it('changed: moved to a different virtual parent', () => {
    const out = classifyFilePage([dbRow({ providerFileId: 'a1', folderId: 'virtual-other' })], [phys], 'virtual-mov', 'run-1')
    expect(out[0].category).toBe('changed')
    expect(out[0]).toMatchObject({ moved: true })
  })

  it('restored: soft-deleted row wins over changed/unchanged', () => {
    const row = dbRow({ providerFileId: 'a1', status: 'deleted', deletedAt: new Date(0) })
    const out = classifyFilePage([row], [phys], 'virtual-mov', 'run-1')
    expect(out[0].category).toBe('restored')
  })

  it('classifies a mixed page deterministically (one category per row)', () => {
    const existing = [
      dbRow({ providerFileId: 'same', lastSeenSyncRunId: 'run-0' }),
      dbRow({ providerFileId: 'stamped', lastSeenSyncRunId: 'run-1' }),
      dbRow({ providerFileId: 'renamed', name: 'old.mkv' }),
      dbRow({ providerFileId: 'deleted', status: 'deleted', deletedAt: new Date(0) }),
    ]
    const out = classifyFilePage(
      existing,
      [file('same'), file('stamped'), file('renamed'), file('deleted'), file('brand-new')],
      'virtual-mov',
      'run-1',
    )
    expect(out.map((c) => c.category)).toEqual(['unchanged', 'already_stamped', 'changed', 'restored', 'new'])
  })
})

/**
 * Page diagnostics: every category is counted, and the counters are the
 * measurement Phase 2 uses to show how many writes batching eliminated.
 */
describe('file page diagnostics', () => {
  it('counts each category and the row writes a page issued', async () => {
    h.files.push(
      { id: 'same', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'same', name: 'a.mkv', mimeType: 'video/x-matroska', sizeBytes: 100n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: 'run-0' },
      { id: 'stamped', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'stamped', name: 'a.mkv', mimeType: 'video/x-matroska', sizeBytes: 100n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: 'run-1' },
      { id: 'renamed', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'renamed', name: 'old.mkv', mimeType: 'video/x-matroska', sizeBytes: 100n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: 'run-0' },
      { id: 'deleted', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'deleted', name: 'a.mkv', mimeType: 'video/x-matroska', sizeBytes: 100n, status: 'deleted', folderId: 'virtual-mov', deletedAt: new Date(0), lastSeenSyncRunId: 'run-0' },
    )
    const diag = emptyFileReconcileDiagnostics()
    const c: FileReconcileContext = { ...ctx('A', 'run-1'), diagnostics: diag }
    const page = await reconcileFilePage(c, 'virtual-mov', [file('same'), file('stamped'), file('renamed'), file('deleted'), file('brand-new')])

    // 3 per-row writes (create + changed + restored) and 1 batched stamp.
    expect(page).toMatchObject({ scanned: 5, created: 1, changed: 1, restored: 1, unchanged: 1, alreadyStamped: 1, failed: 0, rowWrites: 3, batchWrites: 1, batchStamped: 1, dbWriteOps: 4 })
    expect(diag.pages).toBe(1)
    expect(diag.scanned).toBe(5)
    expect(diag.dbWriteOps).toBe(4)
  })

  it('empty page is a no-op that still records a page', async () => {
    const diag = emptyFileReconcileDiagnostics()
    const c: FileReconcileContext = { ...ctx('A'), diagnostics: diag }
    const page = await reconcileFilePage(c, 'virtual-mov', [])
    expect(page.scanned).toBe(0)
    expect(diag.pages).toBe(1)
    expect(h.prismaMock.file.findMany).not.toHaveBeenCalled()
  })

  it('mergeFilePageDiagnostics accumulates across pages', () => {
    const run = emptyFileReconcileDiagnostics()
    mergeFilePageDiagnostics(run, { scanned: 3, created: 1, changed: 0, restored: 0, unchanged: 2, alreadyStamped: 0, failed: 0, rowWrites: 1, batchWrites: 1, batchStamped: 2, dbWriteOps: 2 })
    mergeFilePageDiagnostics(run, { scanned: 2, created: 0, changed: 1, restored: 0, unchanged: 0, alreadyStamped: 1, failed: 0, rowWrites: 1, batchWrites: 0, batchStamped: 0, dbWriteOps: 1 })
    expect(run).toMatchObject({ pages: 2, scanned: 5, created: 1, changed: 1, unchanged: 2, alreadyStamped: 1, rowWrites: 2, batchWrites: 1, batchStamped: 2, dbWriteOps: 3 })
  })
})

/**
 * Phase 2 — batched generation stamping. Unchanged rows only need
 * `lastSeenSyncRunId`, so they must collapse into bounded `updateMany`
 * statements instead of one UPDATE per row, without changing any
 * create/change/restore/missing semantics.
 */
describe('batched generation stamping', () => {
  const seedUnchanged = (count: number, accountId = 'A', userId = 'user-1') => {
    for (let i = 0; i < count; i++) {
      h.files.push({ id: `u${i}`, userId, connectedAccountId: accountId, provider: 'google_drive', providerFileId: `p${i}`, name: 'a.mkv', mimeType: 'video/x-matroska', sizeBytes: 100n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: 'run-0' })
    }
    return Array.from({ length: count }, (_, i) => file(`p${i}`))
  }

  it('stamps a page of many unchanged rows with ONE updateMany and no per-row update', async () => {
    const page = await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', seedUnchanged(50))

    expect(h.prismaMock.file.updateMany).toHaveBeenCalledTimes(1)
    expect(h.prismaMock.file.update).not.toHaveBeenCalled()
    expect(page).toMatchObject({ unchanged: 50, rowWrites: 0, batchWrites: 1, batchStamped: 50, dbWriteOps: 1 })
    expect(h.files.every((f) => f.lastSeenSyncRunId === 'run-1')).toBe(true)
  })

  it('write count does not scale one-to-one with unchanged rows', async () => {
    const small = await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', seedUnchanged(10))
    expect(small.dbWriteOps).toBe(1)

    h.files.length = 0
    vi.clearAllMocks()
    const large = await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', seedUnchanged(400))
    // 40x the rows, still a single write statement.
    expect(large.unchanged).toBe(400)
    expect(large.dbWriteOps).toBe(1)
  })

  it('keeps SQL IN lists bounded: 1200 unchanged rows split into STAMP_BATCH_SIZE chunks', async () => {
    const page = await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', seedUnchanged(1200))

    expect(STAMP_BATCH_SIZE).toBe(500)
    expect(page.batchWrites).toBe(3)
    expect(page.batchStamped).toBe(1200)
    for (const call of h.prismaMock.file.updateMany.mock.calls) {
      expect((call[0] as any).where.id.in.length).toBeLessThanOrEqual(STAMP_BATCH_SIZE)
    }
  })

  it('batch where-clause is scoped by user, account, status and generation', async () => {
    await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', seedUnchanged(3))
    const where = (h.prismaMock.file.updateMany.mock.calls[0][0] as any).where
    expect(where).toMatchObject({
      userId: 'user-1',
      connectedAccountId: 'A',
      status: 'active',
      lastSeenSyncRunId: { not: 'run-1' },
    })
    expect(where.id.in.sort()).toEqual(['u0', 'u1', 'u2'])
  })

  it('never stamps another account or another user (cross-boundary safety)', async () => {
    // Account B and a different user hold rows with the SAME providerFileIds.
    const physical = seedUnchanged(3, 'A')
    seedUnchanged(3, 'B')
    h.files.push({ id: 'other-user', userId: 'user-2', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'p0', name: 'a.mkv', mimeType: 'video/x-matroska', sizeBytes: 100n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: 'run-0' })

    await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', physical)

    expect(h.files.filter((f) => f.connectedAccountId === 'A' && f.userId === 'user-1').every((f) => f.lastSeenSyncRunId === 'run-1')).toBe(true)
    expect(h.files.filter((f) => f.connectedAccountId === 'B').every((f) => f.lastSeenSyncRunId === 'run-0')).toBe(true)
    expect(h.files.find((f) => f.id === 'other-user')!.lastSeenSyncRunId).toBe('run-0')
  })

  it('mixed page: batches unchanged while new/changed/restored stay per-row', async () => {
    const unchanged = seedUnchanged(5)
    h.files.push(
      { id: 'ren', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'ren', name: 'old.mkv', mimeType: 'video/x-matroska', sizeBytes: 100n, status: 'active', folderId: 'virtual-mov', deletedAt: null, lastSeenSyncRunId: 'run-0' },
      { id: 'del', userId: 'user-1', connectedAccountId: 'A', provider: 'google_drive', providerFileId: 'del', name: 'a.mkv', mimeType: 'video/x-matroska', sizeBytes: 100n, status: 'deleted', folderId: 'virtual-mov', deletedAt: new Date(0), lastSeenSyncRunId: 'run-0' },
    )
    const c = ctx('A', 'run-1')
    const page = await reconcileFilePage(c, 'virtual-mov', [...unchanged, file('ren'), file('del'), file('new1')])

    expect(page).toMatchObject({ created: 1, changed: 1, restored: 1, unchanged: 5, rowWrites: 3, batchWrites: 1, batchStamped: 5 })
    expect(h.prismaMock.file.update).toHaveBeenCalledTimes(2)
    expect(h.prismaMock.file.create).toHaveBeenCalledTimes(1)
    // Per-row semantics preserved.
    expect(h.files.find((f) => f.id === 'ren')!.name).toBe('a.mkv')
    expect(h.files.find((f) => f.id === 'del')).toMatchObject({ status: 'active', deletedAt: null })
    expect(c.stats).toMatchObject({ filesCreated: 1, filesUpdated: 2 })
  })

  it('a batch DB failure propagates, is counted, and is logged', async () => {
    const physical = seedUnchanged(3)
    h.prismaMock.file.updateMany.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }))
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const diag = emptyFileReconcileDiagnostics()
    const c: FileReconcileContext = { ...ctx('A', 'run-1'), diagnostics: diag }

    await expect(reconcileFilePage(c, 'virtual-mov', physical)).rejects.toThrow('deadlock')

    expect(diag.failed).toBe(1)
    const failure = log.mock.calls.map((c) => JSON.parse(c[1] as string)).find((e) => e.event === 'sync.file.page_failed')
    expect(failure).toMatchObject({ errorCode: 'P2034', unchanged: 3 })
    // Rows keep the OLD generation marker, so the next run re-classifies them
    // as unchanged rather than treating them as missing.
    expect(h.files.every((f) => f.lastSeenSyncRunId === 'run-0')).toBe(true)
    log.mockRestore()
  })

  it('a stamp that matches fewer rows than classified is reported honestly', async () => {
    // Simulates a row changing between classification and the batched write:
    // the guarded where-clause simply skips it.
    const physical = seedUnchanged(3)
    h.prismaMock.file.updateMany.mockResolvedValueOnce({ count: 2 })
    const page = await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', physical)
    expect(page.unchanged).toBe(3)
    expect(page.batchStamped).toBe(2)
  })

  /** Mutate the store AFTER classification's findMany snapshot is taken. */
  const mutateAfterClassification = (fn: () => void) => {
    const real = h.prismaMock.file.findMany.getMockImplementation()!
    h.prismaMock.file.findMany.mockImplementationOnce(async (args: any) => {
      const rows = await real(args)
      fn()
      return rows
    })
  }

  it('a row soft-deleted between classification and the batch is skipped, not stamped', async () => {
    // The only rejections possible for an already-id-matched row are
    // `status != active` and "already stamped by this run". Both are safe:
    // missing reconciliation also filters on `status: 'active'`.
    const physical = seedUnchanged(3)
    mutateAfterClassification(() => { h.files[1].status = 'deleted' })

    const page = await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', physical)

    expect(page.unchanged).toBe(3)
    expect(page.batchStamped).toBe(2)
    expect(h.files[1].lastSeenSyncRunId).toBe('run-0')
  })

  it('a concurrent rename does NOT reject the stamp (name is not in the where)', async () => {
    const physical = seedUnchanged(2)
    mutateAfterClassification(() => { h.files[0].name = 'renamed-concurrently.mkv' })

    const page = await reconcileFilePage(ctx('A', 'run-1'), 'virtual-mov', physical)

    expect(page.batchStamped).toBe(2)
    // The rename survives — the batch only writes lastSeenSyncRunId.
    expect(h.files[0].name).toBe('renamed-concurrently.mkv')
    expect(h.files[0].lastSeenSyncRunId).toBe('run-1')
  })
})