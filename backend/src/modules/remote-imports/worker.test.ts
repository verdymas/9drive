import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeDelayedError extends Error {
    constructor() {
      super('bullmq:movedToDelayed')
      this.name = 'DelayedError'
    }
  }

  class FakeWorker {
    static instances: FakeWorker[] = []
    readonly processor: (...args: any[]) => Promise<unknown>
    readonly concurrency: number

    constructor(_queueName: string, processor: (...args: any[]) => Promise<unknown>, options: { concurrency: number }) {
      this.processor = processor
      this.concurrency = options.concurrency
      FakeWorker.instances.push(this)
    }

    on() {
      return this
    }

    close = vi.fn(async () => undefined)
  }

  const records = new Map<string, { id: string; userId: string }>()
  const prismaMock = {
    remoteImport: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => records.get(where.id) ?? null),
      update: vi.fn(async () => undefined),
    },
  }

  return {
    FakeDelayedError,
    FakeWorker,
    records,
    prismaMock,
    processMock: vi.fn(),
  }
})

vi.mock('bullmq', () => ({ Worker: h.FakeWorker, DelayedError: h.FakeDelayedError }))
vi.mock('../../config/env.js', () => ({
  env: {
    REDIS_URL: 'redis://test',
    REMOTE_IMPORT_PER_USER_CONCURRENCY: 2,
    REMOTE_IMPORT_DIRECT_CONCURRENCY: 4,
    REMOTE_IMPORT_HLS_JOB_CONCURRENCY: 4,
  },
}))
vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('../remote-fetch-workers/index.js', () => ({}))
vi.mock('./queue.js', () => ({}))
vi.mock('./processor.js', () => ({ processRemoteImportJob: h.processMock }))

import { createRemoteImportWorker } from './worker.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function fakeJob(importId: string, moveEvents: string[]) {
  const job = {
    id: `${importId}~1`,
    data: { importId },
    state: 'active',
    moveToDelayed: vi.fn(async (timestamp: number, token?: string) => {
      job.state = 'delayed'
      moveEvents.push(`${importId}:moved:${timestamp}:${token}`)
    }),
  }
  return job
}

describe('Remote Import worker deferrals', () => {
  beforeEach(() => {
    h.records.clear()
    h.FakeWorker.instances.length = 0
    h.prismaMock.remoteImport.findUnique.mockClear()
    h.prismaMock.remoteImport.update.mockClear()
    h.processMock.mockReset()
  })

  it('delays jobs beyond the per-user limit and resumes them after active jobs finish', async () => {
    for (const importId of ['A', 'B', 'C', 'D']) h.records.set(importId, { id: importId, userId: 'user-1' })

    const running = new Map<string, ReturnType<typeof deferred>>()
    const started = new Map<string, ReturnType<typeof deferred>>()
    for (const importId of ['A', 'B']) {
      running.set(importId, deferred())
      started.set(importId, deferred())
    }
    h.processMock.mockImplementation(async (job: { data: { importId: string } }) => {
      const run = running.get(job.data.importId)
      if (!run) return
      started.get(job.data.importId)!.resolve()
      await run.promise
    })

    const worker = createRemoteImportWorker('direct')
    const moveEvents: string[] = []
    const jobA = fakeJob('A', moveEvents)
    const jobB = fakeJob('B', moveEvents)
    const jobC = fakeJob('C', moveEvents)
    const jobD = fakeJob('D', moveEvents)
    const activeA = worker.processor(jobA, 'token-A')
    const activeB = worker.processor(jobB, 'token-B')
    await Promise.all([started.get('A')!.promise, started.get('B')!.promise])

    const deferredC = worker.processor(jobC, 'token-C')
    const deferredD = worker.processor(jobD, 'token-D')
    await expect(deferredC).rejects.toMatchObject({ name: 'DelayedError' })
    await expect(deferredD).rejects.toMatchObject({ name: 'DelayedError' })

    expect(moveEvents).toHaveLength(2)
    expect(moveEvents.every((event) => event.includes(':moved:'))).toBe(true)
    expect(moveEvents).toEqual(expect.arrayContaining([
      expect.stringContaining('C:moved:'),
      expect.stringContaining(':token-C'),
      expect.stringContaining('D:moved:'),
      expect.stringContaining(':token-D'),
    ]))
    expect(jobC.state).toBe('delayed')
    expect(jobD.state).toBe('delayed')
    expect(h.processMock).toHaveBeenCalledTimes(2)

    running.get('A')!.resolve()
    running.get('B')!.resolve()
    await Promise.all([activeA, activeB])

    await worker.processor(jobC, 'token-C-retry')
    await worker.processor(jobD, 'token-D-retry')
    expect(h.processMock).toHaveBeenCalledTimes(4)
  })

  it('delays a temporary resource shortage without failing the import', async () => {
    h.records.set('resource-starved', { id: 'resource-starved', userId: 'user-1' })
    h.processMock.mockResolvedValue('deferred')
    const worker = createRemoteImportWorker('direct')
    const moveEvents: string[] = []
    const job = fakeJob('resource-starved', moveEvents)

    const execution = worker.processor(job, 'resource-token')
    await expect(execution).rejects.toMatchObject({ name: 'DelayedError' })

    expect(moveEvents).toHaveLength(1)
    expect(moveEvents[0]).toContain('resource-starved:moved:')
    expect(moveEvents[0]).toContain(':resource-token')
    expect(job.state).toBe('delayed')
    expect(h.processMock).toHaveBeenCalledTimes(1)
  })
})
