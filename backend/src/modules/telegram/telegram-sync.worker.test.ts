import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const workerInstances: any[] = []
  return {
    workerInstances,
    WorkerMock: vi.fn().mockImplementation(function (queueName: string, processor: any, opts: any) {
      const inst = {
        queueName,
        processor,
        opts,
        on: vi.fn(),
        close: vi.fn(async () => {}),
      }
      workerInstances.push(inst)
      return inst
    }),
    findUniqueMock: vi.fn(),
    runTelegramSyncMock: vi.fn(),
  }
})

vi.mock('bullmq', () => ({
  Worker: h.WorkerMock,
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    connectedAccount: {
      findUnique: h.findUniqueMock,
    },
  },
}))

vi.mock('./telegram-sync.service.js', () => ({
  runTelegramSync: h.runTelegramSyncMock,
}))

import { env } from '../../config/env.js'
import {
  processTelegramSyncJob,
  startTelegramSyncWorker,
  stopTelegramSyncWorker,
} from './telegram-sync.worker.js'

describe('telegram-sync.worker', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await stopTelegramSyncWorker()
    h.workerInstances.length = 0
  })

  it('uses env.TELEGRAM_SYNC_CONCURRENCY for worker concurrency', () => {
    const worker = startTelegramSyncWorker()
    expect(worker).toBeTruthy()
    expect(h.WorkerMock).toHaveBeenCalledWith(
      'telegram-sync',
      expect.any(Function),
      expect.objectContaining({
        concurrency: env.TELEGRAM_SYNC_CONCURRENCY,
      }),
    )
  })

  it('processes a job successfully by resolving userId and delegating to runTelegramSync', async () => {
    h.findUniqueMock.mockResolvedValueOnce({ userId: 'user-123' })
    h.runTelegramSyncMock.mockResolvedValueOnce({
      id: 'run-1',
      status: 'completed',
      scannedCount: 5,
    })

    const job = {
      data: {
        accountId: 'acc-1',
        trigger: 'manual',
        full: false,
      },
    } as any

    const result = await processTelegramSyncJob(job)

    expect(h.findUniqueMock).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      select: { userId: true },
    })
    expect(h.runTelegramSyncMock).toHaveBeenCalledWith('user-123', 'acc-1', {
      trigger: 'manual',
      full: false,
    })
    expect(result).toEqual({
      id: 'run-1',
      status: 'completed',
      scannedCount: 5,
    })
  })

  it('throws STORAGE_ACCOUNT_NOT_FOUND when connected account is missing', async () => {
    h.findUniqueMock.mockResolvedValueOnce(null)

    const job = {
      data: {
        accountId: 'missing-acc',
        trigger: 'auto',
        full: true,
      },
    } as any

    await expect(processTelegramSyncJob(job)).rejects.toMatchObject({
      code: 'STORAGE_ACCOUNT_NOT_FOUND',
      status: 404,
    })
  })

  it('allows concurrent execution for different accounts', async () => {
    h.findUniqueMock.mockImplementation(async ({ where }: any) => {
      return { userId: `user-for-${where.id}` }
    })

    let resolveAcc1: any
    let resolveAcc2: any
    const p1 = new Promise((resolve) => {
      resolveAcc1 = resolve
    })
    const p2 = new Promise((resolve) => {
      resolveAcc2 = resolve
    })

    h.runTelegramSyncMock.mockImplementation(async (_userId: string, accountId: string) => {
      if (accountId === 'acc-1') return p1
      if (accountId === 'acc-2') return p2
      return Promise.resolve()
    })

    const job1Promise = processTelegramSyncJob({
      data: { accountId: 'acc-1', trigger: 'auto', full: false },
    } as any)
    const job2Promise = processTelegramSyncJob({
      data: { accountId: 'acc-2', trigger: 'auto', full: false },
    } as any)

    // Yield control briefly so both async tasks reach runTelegramSync
    await vi.waitFor(() => {
      expect(h.runTelegramSyncMock).toHaveBeenCalledTimes(2)
    })

    expect(h.runTelegramSyncMock).toHaveBeenNthCalledWith(1, 'user-for-acc-1', 'acc-1', {
      trigger: 'auto',
      full: false,
    })
    expect(h.runTelegramSyncMock).toHaveBeenNthCalledWith(2, 'user-for-acc-2', 'acc-2', {
      trigger: 'auto',
      full: false,
    })

    resolveAcc1({ status: 'completed' })
    resolveAcc2({ status: 'completed' })

    await expect(job1Promise).resolves.toEqual({ status: 'completed' })
    await expect(job2Promise).resolves.toEqual({ status: 'completed' })
  })
})
