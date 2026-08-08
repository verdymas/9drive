import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyStats, completeSyncRun, createSyncRun, failSyncRun, cancelSyncRun, listRecentSyncRuns } from './sync-run.service.js'

const h = vi.hoisted(() => {
  const runs: any[] = []
  return {
    runs,
    prismaMock: {
      syncRun: {
        create: vi.fn(async ({ data }: { data: any }) => {
          const seq = runs.length + 1
          const row = { id: `run-${seq}`, ...data, createdAt: new Date(1_700_000_000_000 + seq), updatedAt: new Date() }
          runs.push(row)
          return row
        }),
        update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
          const run = runs.find((r) => r.id === where.id)
          if (!run) throw new Error('not found')
          Object.assign(run, data)
          return run
        }),
        findMany: vi.fn(async ({ where, take }: { where?: any; take?: number } = {}) =>
          runs
            .filter((r) => (where?.userId ? r.userId === where.userId : true))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take),
        ),
      },
    },
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

describe('sync-run.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.runs.length = 0
  })
  afterEach(() => vi.restoreAllMocks())

  it('createSyncRun starts a run as running', async () => {
    const run = await createSyncRun({ userId: 'u1', connectedAccountId: 'a1', provider: 'google_drive' })
    expect(run.status).toBe('running')
    expect(h.prismaMock.syncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', connectedAccountId: 'a1', provider: 'google_drive' }) }),
    )
  })

  it('completeSyncRun stamps completed + stats', async () => {
    const run = await createSyncRun({ userId: 'u1', connectedAccountId: 'a1', provider: 'google_drive' })
    const done = await completeSyncRun(run.id, { ...emptyStats(), foldersDiscovered: 3, filesDiscovered: 7, filesCreated: 4, mappingsCreated: 2 })
    expect(done.status).toBe('completed')
    expect(done.foldersDiscovered).toBe(3)
    expect(done.mappingsCreated).toBe(2)
  })

  it('failSyncRun records error code/message', async () => {
    const run = await createSyncRun({ userId: 'u1', connectedAccountId: 'a1', provider: 'google_drive' })
    const failed = await failSyncRun(run.id, 'SYNC_PROVIDER_LIST_FAILED', 'listing failed')
    expect(failed.status).toBe('failed')
    expect(failed.errorCode).toBe('SYNC_PROVIDER_LIST_FAILED')
  })

  it('cancelSyncRun marks cancelled', async () => {
    const run = await createSyncRun({ userId: 'u1', connectedAccountId: 'a1', provider: 'google_drive' })
    const cancelled = await cancelSyncRun(run.id)
    expect(cancelled.status).toBe('cancelled')
  })

  it('listRecentSyncRuns returns newest first', async () => {
    await createSyncRun({ userId: 'u1', connectedAccountId: 'a1', provider: 'google_drive' })
    await createSyncRun({ userId: 'u1', connectedAccountId: 'a2', provider: 'google_drive' })
    const list = await listRecentSyncRuns('u1', 10)
    expect(list).toHaveLength(2)
    expect(list[0].connectedAccountId).toBe('a2')
  })
})