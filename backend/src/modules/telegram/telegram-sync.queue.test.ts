import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const jobs: Record<string, { id: string; data: any; remove: () => Promise<void> }> = {}
  const FakeQueue = vi.fn(function FakeQueue() {
    return {
      add: vi.fn(async (name: string, data: any, opts: { jobId: string }) => {
        if (jobs[opts.jobId]) {
          // BullMQ would refuse / dedupe by jobId; emulate the "already exists" path.
          return { id: opts.jobId }
        }
        jobs[opts.jobId] = {
          id: opts.jobId,
          data: { name, ...data },
          remove: vi.fn(async () => {
            delete jobs[opts.jobId]
          }),
        }
        return { id: opts.jobId }
      }),
      getJob: vi.fn(async (jobId: string) => jobs[jobId] ?? null),
      close: vi.fn(),
      getWorkersCount: vi.fn(async () => 0),
    }
  })
  return { jobs, FakeQueue }
})

vi.mock('bullmq', () => ({ Queue: h.FakeQueue }))

import { closeTelegramSyncQueue, enqueueTelegramSync, getTelegramSyncJob, removeTelegramSyncJob, telegramSyncJobId } from './telegram-sync.queue.js'

beforeEach(() => {
  for (const k of Object.keys(h.jobs)) delete h.jobs[k]
})

describe('telegramSyncJobId', () => {
  it('uses different buckets for manual/auto/recovery', () => {
    expect(telegramSyncJobId('acc-1', 'manual')).not.toBe(telegramSyncJobId('acc-1', 'auto'))
    expect(telegramSyncJobId('acc-1', 'manual')).toBe(telegramSyncJobId('acc-1', 'recovery'))
  })
})

describe('enqueueTelegramSync', () => {
  it('queues a new job when none exists', async () => {
    const result = await enqueueTelegramSync({ accountId: 'acc-1', trigger: 'manual', full: false })
    expect(result.queued).toBe(true)
    expect(result.jobId).toContain('acc-1')
  })

  it('reports queued=false when a job for the same (accountId, trigger) is already queued', async () => {
    await enqueueTelegramSync({ accountId: 'acc-1', trigger: 'manual', full: false })
    const second = await enqueueTelegramSync({ accountId: 'acc-1', trigger: 'manual', full: false })
    expect(second.queued).toBe(false)
    expect(second.jobId).toBe(telegramSyncJobId('acc-1', 'manual'))
  })

  it('treats auto/manual triggers as independent queues', async () => {
    await enqueueTelegramSync({ accountId: 'acc-1', trigger: 'manual', full: false })
    const auto = await enqueueTelegramSync({ accountId: 'acc-1', trigger: 'auto', full: false })
    expect(auto.queued).toBe(true)
  })
})

describe('getTelegramSyncJob / removeTelegramSyncJob', () => {
  it('returns the live job when one exists', async () => {
    await enqueueTelegramSync({ accountId: 'acc-1', trigger: 'manual', full: false })
    const job = await getTelegramSyncJob('acc-1', 'manual')
    expect(job).not.toBeNull()
    expect(job?.id).toBe(telegramSyncJobId('acc-1', 'manual'))
  })

  it('returns null when no job is present', async () => {
    const job = await getTelegramSyncJob('acc-missing', 'auto')
    expect(job).toBeNull()
  })

  it('removes a queued job', async () => {
    await enqueueTelegramSync({ accountId: 'acc-1', trigger: 'manual', full: false })
    const removed = await removeTelegramSyncJob('acc-1', 'manual')
    expect(removed).toBe(true)
    expect(await getTelegramSyncJob('acc-1', 'manual')).toBeNull()
  })

  it('returns false when removing a non-existent job', async () => {
    expect(await removeTelegramSyncJob('acc-missing', 'manual')).toBe(false)
  })
})

describe('closeTelegramSyncQueue', () => {
  it('closes the queue without error', async () => {
    await expect(closeTelegramSyncQueue()).resolves.toBeUndefined()
  })
})