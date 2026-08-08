import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileQueuedRow, failStalledProcessing } from './queue-reconcile.js'

// ── Mocks: isolate reconcile from prisma + bullmq ────────────────────────────
const h = vi.hoisted(() => {
  const prismaMock = {
    remoteImport: {
      findMany: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  }
  return {
    prismaMock,
    getJobByIdMock: vi.fn(),
    nowSpy: vi.fn(() => 2_000_000_000_000), // a fixed "now"
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

vi.mock('./queue.js', () => ({
  getJobById: (...args: unknown[]) => h.getJobByIdMock(...args),
}))

vi.mock('../../config/env.js', () => ({
  env: {
    REMOTE_IMPORT_QUEUE_START_TIMEOUT_SECONDS: 300,
    REMOTE_IMPORT_WORKER_HEARTBEAT_TIMEOUT_SECONDS: 120,
  },
}))

/** A fake BullMQ job with a controllable `getState()`. */
function fakeJob(state: string) {
  return { id: 'import-1:1', getState: async () => state }
}

const staleQueuedRow = {
  id: 'import-1',
  status: 'queued',
  stage: 'waiting',
  jobId: 'import-1:1',
  attempt: 1,
  queuedAt: new Date(2_000_000_000_000 - 400_000), // 400s ago (> 300s timeout)
  heartbeatAt: null,
  fileName: 'movie.mkv',
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(h.prismaMock.remoteImport.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  ;(h.prismaMock.remoteImport.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 })
})

describe('reconcileQueuedRow', () => {
  it('fails a queued row whose execution job is missing from Redis', async () => {
    ;(h.getJobByIdMock as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const action = await reconcileQueuedRow(staleQueuedRow)
    expect(action).toBe('failed-missing')
    expect(h.prismaMock.remoteImport.updateMany).toHaveBeenCalledWith({
      where: { id: 'import-1', status: 'queued', stage: 'waiting' },
      data: expect.objectContaining({ status: 'failed', errorCode: 'REMOTE_IMPORT_QUEUE_JOB_MISSING' }),
    })
  })

  it('flips a queued row to processing when its job is active', async () => {
    ;(h.getJobByIdMock as ReturnType<typeof vi.fn>).mockResolvedValue(fakeJob('active'))
    const action = await reconcileQueuedRow(staleQueuedRow)
    expect(action).toBe('processing')
    expect(h.prismaMock.remoteImport.updateMany).toHaveBeenCalledWith({
      where: { id: 'import-1', status: 'queued' },
      data: expect.objectContaining({ status: 'processing', heartbeatAt: expect.any(Date) }),
    })
  })

  it('fails a queued row whose execution job failed before pickup', async () => {
    ;(h.getJobByIdMock as ReturnType<typeof vi.fn>).mockResolvedValue(fakeJob('failed'))
    const action = await reconcileQueuedRow(staleQueuedRow)
    expect(action).toBe('failed')
    expect(h.prismaMock.remoteImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorCode: 'REMOTE_IMPORT_QUEUE_JOB_FAILED' }) }),
    )
  })

  it('keeps a queued row waiting (job legitimately waiting) — never blind-fails', async () => {
    ;(h.getJobByIdMock as ReturnType<typeof vi.fn>).mockResolvedValue(fakeJob('waiting'))
    const action = await reconcileQueuedRow(staleQueuedRow)
    expect(action).toBe('kept')
    expect(h.prismaMock.remoteImport.updateMany).not.toHaveBeenCalled()
  })

  it('keeps a queued row when the job is delayed (backoff waiting)', async () => {
    ;(h.getJobByIdMock as ReturnType<typeof vi.fn>).mockResolvedValue(fakeJob('delayed'))
    const action = await reconcileQueuedRow(staleQueuedRow)
    expect(action).toBe('kept')
    expect(h.prismaMock.remoteImport.updateMany).not.toHaveBeenCalled()
  })

  it('mirrors completed when the job finished but the DB was never finalised', async () => {
    ;(h.getJobByIdMock as ReturnType<typeof vi.fn>).mockResolvedValue(fakeJob('completed'))
    const action = await reconcileQueuedRow(staleQueuedRow)
    expect(action).toBe('completed')
    expect(h.prismaMock.remoteImport.updateMany).toHaveBeenCalledWith({
      where: { id: 'import-1', status: 'queued' },
      data: expect.objectContaining({ status: 'completed', completedAt: expect.any(Date) }),
    })
  })

  it('skips silently when Redis is unreachable', async () => {
    ;(h.getJobByIdMock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))
    const action = await reconcileQueuedRow(staleQueuedRow)
    expect(action).toBe('skipped')
    expect(h.prismaMock.remoteImport.updateMany).not.toHaveBeenCalled()
  })

  it('skips unknown job states (no blind write)', async () => {
    ;(h.getJobByIdMock as ReturnType<typeof vi.fn>).mockResolvedValue(fakeJob('unknown'))
    const action = await reconcileQueuedRow(staleQueuedRow)
    expect(action).toBe('skipped')
    expect(h.prismaMock.remoteImport.updateMany).not.toHaveBeenCalled()
  })
})

describe('failStalledProcessing', () => {
  it('fails a processing row whose heartbeat is stale', async () => {
    const row = {
      ...staleQueuedRow,
      status: 'processing',
      stage: 'remuxing',
      heartbeatAt: new Date(h.nowSpy() - 121_000), // > 120s heartbeat timeout
    }
    const failed = await failStalledProcessing(row, h.nowSpy())
    expect(failed).toBe(true)
    expect(h.prismaMock.remoteImport.updateMany).toHaveBeenCalledWith({
      where: { id: 'import-1', status: 'processing', stage: 'remuxing' },
      data: expect.objectContaining({ status: 'failed', errorCode: 'REMOTE_IMPORT_WORKER_STALLED' }),
    })
  })

  it('keeps a processing row whose heartbeat is fresh', async () => {
    const row = {
      ...staleQueuedRow,
      status: 'processing',
      stage: 'downloading',
      // 10s before the SAME clock the function is called with (fixed h.nowSpy).
      heartbeatAt: new Date(h.nowSpy() - 10_000),
    }
    const failed = await failStalledProcessing(row, h.nowSpy())
    expect(failed).toBe(false)
    expect(h.prismaMock.remoteImport.updateMany).not.toHaveBeenCalled()
  })

  it('defends against a missing heartbeat (treated as stale)', async () => {
    const row = { ...staleQueuedRow, status: 'processing', heartbeatAt: null }
    const failed = await failStalledProcessing(row, h.nowSpy())
    expect(failed).toBe(true)
  })
})