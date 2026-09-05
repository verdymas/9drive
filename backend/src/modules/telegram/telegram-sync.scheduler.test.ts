import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  prismaMock: {
    connectedAccount: { findMany: vi.fn() },
  },
}))

vi.mock('./telegram-sync.queue.js', () => ({
  enqueueTelegramSync: h.enqueueMock,
}))

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

// Pin the scheduler's config. `env.ts` parses `.env` once at import, so
// mutating `process.env` in a beforeEach does nothing — these tests used
// to pass only because `z.coerce.boolean()` turned the string "false"
// into true. With `booleanEnv` reading it correctly, a developer whose
// `.env` disables auto-sync would otherwise fail the suite.
vi.mock('../../config/env.js', () => ({
  env: {
    TELEGRAM_SYNC_AUTO_ENABLED: true,
    TELEGRAM_SYNC_INTERVAL_MINUTES: 30,
    TELEGRAM_SYNC_FULL_EVERY_MINUTES: 360,
  },
}))

import {
  isSchedulerRunning,
  startTelegramSyncScheduler,
  stopTelegramSyncScheduler,
  triggerSweepOnce,
} from './telegram-sync.scheduler.js'

beforeEach(() => {
  vi.clearAllMocks()
  stopTelegramSyncScheduler()
})

afterEach(() => {
  stopTelegramSyncScheduler()
})

describe('triggerSweepOnce', () => {
  it('enqueues a sync for accounts that have never synced', async () => {
    h.prismaMock.connectedAccount.findMany.mockResolvedValueOnce([
      { id: 'acc-1', telegramSyncStates: [] },
      { id: 'acc-2', telegramSyncStates: [{ status: 'up_to_date', lastScanAt: new Date() }] },
    ])
    h.enqueueMock.mockResolvedValue({ jobId: 'x', queued: true })

    const result = await triggerSweepOnce()

    expect(result.enqueued).toBe(1)
    expect(h.enqueueMock).toHaveBeenCalledTimes(1)
    expect(h.enqueueMock).toHaveBeenCalledWith({ accountId: 'acc-1', trigger: 'auto', full: true })
  })

  it('skips accounts that already have a syncing state row', async () => {
    h.prismaMock.connectedAccount.findMany.mockResolvedValueOnce([
      { id: 'acc-1', telegramSyncStates: [{ status: 'syncing', lastScanAt: new Date() }] },
    ])
    const result = await triggerSweepOnce()
    expect(result.enqueued).toBe(0)
    expect(h.enqueueMock).not.toHaveBeenCalled()
  })

  it('re-enqueues an account whose last scan is older than the interval', async () => {
    const staleDate = new Date(Date.now() - 60 * 60 * 1000) // 1h old
    h.prismaMock.connectedAccount.findMany.mockResolvedValueOnce([
      { id: 'acc-1', telegramSyncStates: [{ status: 'up_to_date', lastScanAt: staleDate }] },
    ])
    h.enqueueMock.mockResolvedValue({ jobId: 'x', queued: true })

    const result = await triggerSweepOnce()

    expect(result.due).toBe(1)
    expect(h.enqueueMock).toHaveBeenCalledTimes(1)
  })
})

describe('startTelegramSyncScheduler', () => {
  it('starts a timer when auto sync is enabled', () => {
    expect(isSchedulerRunning()).toBe(false)
    startTelegramSyncScheduler()
    expect(isSchedulerRunning()).toBe(true)
    stopTelegramSyncScheduler()
  })

  it('idempotent — calling twice does not double-start', () => {
    startTelegramSyncScheduler()
    startTelegramSyncScheduler()
    expect(isSchedulerRunning()).toBe(true)
    stopTelegramSyncScheduler()
  })

  it('stopTelegramSyncScheduler is safe when no timer is active', () => {
    expect(() => stopTelegramSyncScheduler()).not.toThrow()
  })
})