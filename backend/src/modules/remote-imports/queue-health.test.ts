import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks: replace BullMQ with a fake Queue whose getWorkersCount is
// controllable, so the health probe can be exercised without Redis. ─────────
const h = vi.hoisted(() => {
  class FakeQueue {
    static last: FakeQueue | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getWorkersCount = vi.fn(async (): Promise<number> => 1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {
      FakeQueue.last = this
    }
  }
  return { FakeQueue }
})

vi.mock('bullmq', () => ({ Queue: h.FakeQueue }))

import { remoteImportQueueHealth } from './queue.js'

describe('remoteImportQueueHealth (§42 health signal)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (h.FakeQueue.last) {
      ;(h.FakeQueue.last.getWorkersCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)
    }
  })

  it('reports redis ok + worker ok while a worker is connected', async () => {
    expect(await remoteImportQueueHealth()).toEqual({ redis: 'ok', worker: 'ok' })
  })

  it('reports worker unknown when no worker is currently connected (soft signal)', async () => {
    ;(h.FakeQueue.last!.getWorkersCount as ReturnType<typeof vi.fn>).mockResolvedValue(0)
    expect(await remoteImportQueueHealth()).toEqual({ redis: 'ok', worker: 'unknown' })
  })

  it('reports redis down instead of throwing when Redis is unreachable', async () => {
    ;(h.FakeQueue.last!.getWorkersCount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(remoteImportQueueHealth()).resolves.toEqual({ redis: 'down', worker: 'unknown' })
  })
})