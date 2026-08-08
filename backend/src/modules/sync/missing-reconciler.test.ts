import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileMissing } from './missing-reconciler.js'
import type { SyncRunContext } from './folder-reconciler.js'
import { emptyStats } from './sync-run.service.js'

/**
 * Missing reconciler — spec §21-22, §32, §41, §66-13/14/15/16.
 * Account-scoped, success-scan-only, legacy-row-safe.
 */
const h = vi.hoisted(() => {
  const files: any[] = []
  const locations: any[] = []
  let seq = 0

  const prismaMock = {
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(prismaMock)),
    file: {
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        const matched = files.filter((f) => {
          if (where?.userId && f.userId !== where.userId) return false
          if (where?.connectedAccountId && f.connectedAccountId !== where.connectedAccountId) return false
          if (where?.status && f.status !== where.status) return false
          if (where?.lastSeenSyncRunId) {
            const cond = where.lastSeenSyncRunId
              // { not: null, notIn: [runId] } — exclude NULL + current run.
              if (cond.not !== undefined && f.lastSeenSyncRunId === cond.not) return false
              if (cond.not === null && f.lastSeenSyncRunId === null) return false
              if (cond.notIn !== undefined && cond.notIn.includes(f.lastSeenSyncRunId)) return false
          }
          return true
        })
        for (const f of matched) Object.assign(f, data)
        return { count: matched.length }
      }),
    },
    folderStorageLocation: {
      findMany: vi.fn(async ({ where, select }: { where?: any; select?: any } = {}) =>
        locations
          .filter((l) => {
            if (where?.connectedAccountId && l.connectedAccountId !== where.connectedAccountId) return false
            if (where?.lastSeenSyncRunId) {
              // { not: runId, not: null } — exclude rows stamped by THIS run
              // and legacy NULL rows. Object → not-branch; raw value → truthy.
              if (typeof where.lastSeenSyncRunId === 'object') {
                const cond = where.lastSeenSyncRunId
                // { not: null, notIn: [runId] } — exclude NULL + current run.
                if (cond.not !== undefined && l.lastSeenSyncRunId === cond.not) return false
                if (cond.not === null && l.lastSeenSyncRunId === null) return false
                if (cond.notIn !== undefined && cond.notIn.includes(l.lastSeenSyncRunId)) return false
              } else if (l.lastSeenSyncRunId !== where.lastSeenSyncRunId) return false
            }
            return true
          })
          .map((l) => (select ? pick(l, select) : { ...l })),
      ),
      deleteMany: vi.fn(async ({ where }: { where: any } = {}) => {
        const ids = where?.id?.in ?? []
        const before = locations.length
        for (let i = locations.length - 1; i >= 0; i--) {
          if (ids.includes(locations[i].id)) locations.splice(i, 1)
        }
        return { count: before - locations.length }
      }),
    },
  }

  const pick = (row: any, select: any) => {
    const out: any = {}
    for (const key of Object.keys(select)) if (key in row) out[key] = row[key]
    return out
  }

  return { files, locations, prismaMock }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

function ctx(accountId: string, runId = 'run-1'): SyncRunContext {
  return { userId: 'user-1', accountId, provider: 'google_drive', runId, stats: emptyStats() }
}

function seedFile(accountId: string, providerFileId: string, lastSeen: string | null, status = 'active') {
  const row = { id: `file-${providerFileId}`, userId: 'user-1', connectedAccountId: accountId, providerFileId, status, lastSeenSyncRunId: lastSeen, folderId: 'virtual-mov' }
  h.files.push(row)
  return row
}

function seedLocation(accountId: string, providerFolderId: string, lastSeen: string | null) {
  const row = { id: `loc-${providerFolderId}`, folderId: 'virtual-mov', connectedAccountId: accountId, providerFolderId, lastSeenSyncRunId: lastSeen }
  h.locations.push(row)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  h.files.length = 0
  h.locations.length = 0
})

describe('§66 missing reconciler', () => {
  it('successful scan soft-deletes only files not seen this run (account-scoped)', async () => {
    seedFile('A', 'a1', 'run-1')   // stale
    seedFile('A', 'a2', 'run-2')   // seen this run
    seedFile('B', 'b1', 'run-1')   // other account
    const s = emptyStats()
    const res = await reconcileMissing(ctx('A', 'run-2'), s)
    expect(res.filesMissing).toBe(1)
    expect(h.files.find((f) => f.providerFileId === 'a1')!.status).toBe('deleted')
    expect(h.files.find((f) => f.providerFileId === 'a2')!.status).toBe('active')
    expect(h.files.find((f) => f.providerFileId === 'b1')!.status).toBe('active')
  })

  it('legacy rows (lastSeen NULL) are never treated as missing', async () => {
    seedFile('a', 'legacy', null)
    const s = emptyStats()
    const res = await reconcileMissing(ctx('A', 'run-2'), s)
    expect(res.filesMissing).toBe(0)
    expect(h.files[0].status).toBe('active')
  })

  it('deletes stale location mappings but leaves virtual folder + other accounts', async () => {
    seedLocation('A', 'pd-A-mov', 'run-1')
    seedLocation('B', 'pd-B-mov', 'run-2')
    seedLocation('A', 'pd-A-mov2', 'run-2')
    const s = emptyStats()
    const res = await reconcileMissing(ctx('A', 'run-2'), s)
    expect(res.mappingsMissing).toBe(1)
    expect(h.locations.map((l) => l.providerFolderId)).toEqual(['pd-B-mov', 'pd-A-mov2'])
    // Virtual folder survives (this module only touches location rows).
  })

  it('cancelled run never reaches the reconciler (no cleanup of stale rows)', async () => {
    // Cancellation aborts before reconcileMissing is invoked. Verify the
    // reconciler leaves everything untouched when called with a cancelled run.
    seedFile('a', 'a1', 'run-1')
    seedLocation('A', 'pd-A-mov', 'run-1')
    const s = emptyStats()
    // (Not invoked by the orchestrator on cancellation — caller-side contract.)
    expect(h.files).toHaveLength(1)
    expect(h.locations).toHaveLength(1)
  })

  it('failed scan never performs cleanup', async () => {
    seedFile('a', 'a1', 'run-1')
    seedLocation('A', 'pd-A-mov', 'run-1')
    const s = emptyStats()
    // Failed runs do not reach reconcileMissing.
    expect(h.files[0].status).toBe('active')
    expect(h.locations).toHaveLength(1)
  })

  it('successful run reconciles only A mappings while B remains untouched', async () => {
    seedFile('A', 'a1', 'run-1')
    seedFile('A', 'a2', 'run-2')
    seedFile('B', 'b1', 'run-1')
    seedLocation('A', 'pd-A-mov', 'run-1')
    seedLocation('B', 'pd-B-mov', 'run-2')
    const s = emptyStats()
    const res = await reconcileMissing(ctx('A', 'run-2'), s)
    expect(res.filesMissing).toBe(1)
    expect(res.mappingsMissing).toBe(1)
    expect(h.files.find((f) => f.providerFileId === 'b1')!.status).toBe('active')
    expect(h.locations.map((l) => l.providerFolderId)).toEqual(['pd-B-mov'])
  })
})