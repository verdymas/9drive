import { describe, expect, it, vi, beforeEach } from 'vitest'
import { currentPeriodMonth, resolveSafetyBudgets } from './worker-usage.service.js'

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    remoteFetchWorker: { findFirst: vi.fn() },
    remoteFetchWorkerUsage: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))

describe('worker usage budgets', () => {
  beforeEach(() => vi.clearAllMocks())

  it('period month buckets UTC YYYY-MM', () => {
    expect(currentPeriodMonth(new Date(Date.UTC(2026, 9, 12)))).toBe('2026-10')
  })

  it('resolves worker override over driver default', () => {
    const withOverride = resolveSafetyBudgets({ driver: 'deno', reqBudgetMonthly: 10n, egressBudgetBytesMonthly: 20n })
    expect(withOverride.maxRequests).toBe(10n)
    expect(withOverride.maxEgressBytes).toBe(20n)
  })

  it('falls back to conservative driver defaults below published limits', () => {
    const deno = resolveSafetyBudgets({ driver: 'deno' })
    expect(deno.maxRequests).toBeLessThan(1_000_000n)
    expect(deno.maxEgressBytes).toBeLessThan(BigInt(20 * 1024 * 1024 * 1024))
  })

  it('unknown driver has no budget (null = unbounded)', () => {
    const unknown = resolveSafetyBudgets({ driver: 'unknown-driver' })
    expect(unknown.maxRequests).toBeNull()
    expect(unknown.maxEgressBytes).toBeNull()
  })
})
