import { beforeEach, describe, expect, it, vi } from 'vitest'
import { planBatchUploads, selectAccount } from './storage-routing.service.js'

// ── Mocks: isolate the planner from prisma + quota sync ──────────────────────
// vi.mock factories are hoisted above the imports, so any spy/object they
// close over must come from vi.hoisted (see remote-import.service.test.ts).
const h = vi.hoisted(() => {
  const now = new Date('2026-08-07T00:00:00.000Z')
  const account = (id: string, provider: string, availableBytes: bigint | null, stale = false, autoAllocationEnabled = true, status = 'connected') => ({
    id,
    userId: 'user-1',
    providerConfigId: null,
    provider,
    providerAccountId: `${provider}-${id}`,
    email: `${id}@example.com`,
    displayName: null,
    avatarUrl: null,
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    scopes: [],
    status,
    autoAllocationEnabled,
    lastError: null,
    reauthRequiredAt: status === 'reauth_required' ? new Date('2026-08-18T00:00:00.000Z') : null,
    lastAuthErrorCode: status === 'reauth_required' ? 'GOOGLE_OAUTH_INVALID_GRANT' : null,
    createdAt: now,
    updatedAt: now,
    storageAccount: {
      id: `sa-${id}`,
      connectedAccountId: id,
      totalBytes: null,
      usedBytes: 0n,
      availableBytes,
      trashBytes: null,
      // Fresh now (never triggers re-sync); stale uses an old timestamp.
      lastSyncedAt: stale ? new Date('2020-01-01T00:00:00.000Z') : now,
      createdAt: now,
      updatedAt: now,
    },
  })

  const prismaMock = {
    connectedAccount: {
      // Honest-ish in-memory filter: keeps the S3-exclusion and pin tests
      // meaningful without reproducing Prisma's full query engine.
      findMany: vi.fn(async ({ where }: { where: any }) => {
        const all = h.allAccounts
        return all.filter((a) => {
          if (where?.userId && a.userId !== where.userId) return false
          if (where?.status) {
            const wanted = typeof where.status === 'object' && 'in' in where.status ? where.status.in : [where.status]
            if (!wanted.includes(a.status)) return false
          }
          if (where?.provider) {
            const wanted = typeof where.provider === 'object' && 'in' in where.provider ? where.provider.in : [where.provider]
            if (!wanted.includes(a.provider)) return false
          }
          if (where?.id && a.id !== where.id) return false
          if (where?.autoAllocationEnabled !== undefined && a.autoAllocationEnabled !== where.autoAllocationEnabled) return false
          return true
        })
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        return { id: where.id, ...data }
      }),
    },
    uploadRoutingPolicy: {
      upsert: vi.fn(async () => ({
        id: 'policy-1',
        userId: 'user-1',
        mode: 'most_available',
        priorityAccountIds: [],
        roundRobinCursor: 0,
        createdAt: now,
        updatedAt: now,
      })),
      update: vi.fn(async () => ({})),
    },
  }

  return { prismaMock, account, allAccounts: [], now }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

// syncGoogleQuota is never expected to run in these tests (accounts are fresh);
// a mock that records calls and fails loudly if invoked accidentally.
vi.mock('../google/google.service.js', () => ({
  syncGoogleQuota: vi.fn(async () => {
    throw new Error('syncGoogleQuota should not be called in these tests')
  }),
}))

// Import AFTER the mocks are registered (vi.mock is hoisted; imports re-order).
import { syncGoogleQuota } from '../google/google.service.js'

/** Prime the mock DB with the given accounts (all fresh, most_available). */
function setupAccounts(accounts: ReturnType<typeof h.account>[]) {
  h.allAccounts.length = 0
  h.allAccounts.push(...accounts)
  ;(h.prismaMock.uploadRoutingPolicy.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: 'policy-1',
    userId: 'user-1',
    mode: 'most_available',
    priorityAccountIds: [],
    roundRobinCursor: 0,
    createdAt: h.now,
    updatedAt: h.now,
  })
}

describe('planBatchUploads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.allAccounts.length = 0
  })

  it('reserves space so a batch uses multiple accounts, never overcommitting one', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 200n)])
    const result = await planBatchUploads('user-1', [
      { fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 80n },
      { fileName: 'b.bin', mimeType: 'application/octet-stream', sizeBytes: 80n },
    ])
    // Both files fit on acc-b (200n) — most_available keeps them together.
    expect(result.plans).toEqual([
      { fileName: 'a.bin', accountId: 'acc-b', provider: 'google_drive', reason: null },
      { fileName: 'b.bin', accountId: 'acc-b', provider: 'google_drive', reason: null },
    ])
    expect(result.totalBytes).toBe(160n)
    expect(result.totalRoutedBytes).toBe(160n)
    expect(result.unroutedBytes).toBe(0n)
  })

  it('spreads a batch across accounts when one cannot hold everything', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 200n)])
    const result = await planBatchUploads('user-1', [
      { fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 100n },
      { fileName: 'b.bin', mimeType: 'application/octet-stream', sizeBytes: 150n },
    ])
    // Largest-first: b.bin (150n) takes acc-b, leaving 50n — a.bin (100n)
    // cannot join it and spills to acc-a. Both files route, to different accounts.
    expect(result.plans).toEqual([
      { fileName: 'a.bin', accountId: 'acc-a', provider: 'google_drive', reason: null },
      { fileName: 'b.bin', accountId: 'acc-b', provider: 'google_drive', reason: null },
    ])
    expect(result.unroutedBytes).toBe(0n)
  })

  it('routes a file too big for the first account to the second', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 200n)])
    const result = await planBatchUploads('user-1', [{ fileName: 'big.bin', mimeType: 'application/octet-stream', sizeBytes: 150n }])
    expect(result.plans).toEqual([{ fileName: 'big.bin', accountId: 'acc-b', provider: 'google_drive', reason: null }])
    expect(result.unroutedBytes).toBe(0n)
  })

  it('marks the overflow file insufficient and reports unroutedBytes', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 200n)])
    const result = await planBatchUploads('user-1', [
      { fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 100n },
      { fileName: 'b.bin', mimeType: 'application/octet-stream', sizeBytes: 250n },
    ])
    expect(result.plans).toEqual([
      { fileName: 'a.bin', accountId: 'acc-b', provider: 'google_drive', reason: null },
      { fileName: 'b.bin', accountId: null, provider: null, reason: 'insufficient' },
    ])
    expect(result.totalRoutedBytes).toBe(100n)
    expect(result.unroutedBytes).toBe(250n)
  })

  it('treats an unknown (null) quota account as eligible', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', null)])
    const result = await planBatchUploads('user-1', [{ fileName: 'any.bin', mimeType: 'application/octet-stream', sizeBytes: 10_000n }])
    expect(result.plans).toEqual([{ fileName: 'any.bin', accountId: 'acc-a', provider: 'google_drive', reason: null }])
  })

  it('re-syncs a stale account before planning', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n, true)])
    ;(syncGoogleQuota as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 10n }])
    expect(syncGoogleQuota).toHaveBeenCalledWith('acc-a')
    expect(result.plans[0].accountId).toBe('acc-a')
  })

  it('still routes when quota sync fails (null quota = eligible) and records lastError', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n, true)])
    ;(syncGoogleQuota as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('quota api down'))
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 10n }])
    expect(result.plans[0].accountId).toBe('acc-a')
    expect(h.prismaMock.connectedAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastError: 'quota api down' }) }),
    )
  })

  it('advances the round-robin cursor by the routable file count', async () => {
    const accounts = [h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 200n)]
    setupAccounts(accounts)
    ;(h.prismaMock.uploadRoutingPolicy.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'policy-1',
      userId: 'user-1',
      mode: 'round_robin',
      priorityAccountIds: [],
      roundRobinCursor: 1,
      createdAt: h.now,
      updatedAt: h.now,
    })
    const result = await planBatchUploads('user-1', [
      { fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 10n },
      { fileName: 'b.bin', mimeType: 'application/octet-stream', sizeBytes: 10n },
    ])
    // Cursor 1 rotates to start at acc-b; files land acc-b then acc-a.
    expect(result.plans.map((p) => p.accountId)).toEqual(['acc-b', 'acc-a'])
    expect(h.prismaMock.uploadRoutingPolicy.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { roundRobinCursor: 3 },
    })
  })

  it('orders by priorityAccountIds in priority mode', async () => {
    const accounts = [h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 200n)]
    setupAccounts(accounts)
    ;(h.prismaMock.uploadRoutingPolicy.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'policy-1',
      userId: 'user-1',
      mode: 'priority',
      priorityAccountIds: ['acc-a'],
      roundRobinCursor: 0,
      createdAt: h.now,
      updatedAt: h.now,
    })
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 10n }])
    // acc-a has less free space but is first in priority order.
    expect(result.plans[0].accountId).toBe('acc-a')
  })

  it('never plans S3 accounts', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n), h.account('acc-s3', 's3', 10_000n)])
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 50n }])
    expect(result.plans).toEqual([{ fileName: 'a.bin', accountId: 'acc-a', provider: 'google_drive', reason: null }])
  })

  it('marks all files no_accounts when a non-google pin is given', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n), h.account('acc-s3', 's3', 10_000n)])
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 50n }], 'acc-s3')
    expect(result.plans).toEqual([{ fileName: 'a.bin', accountId: null, provider: null, reason: 'no_accounts' }])
    expect(result.totalRoutedBytes).toBe(0n)
    expect(result.unroutedBytes).toBe(50n)
  })

  it('prefers a soft-pinned account but falls back when it cannot hold the file', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 200n)])
    // acc-a is pinned and can hold 80n — it is chosen over acc-b.
    const small = await planBatchUploads('user-1', [{ fileName: 's.bin', mimeType: 'application/octet-stream', sizeBytes: 80n }], 'acc-a')
    expect(small.plans[0]).toMatchObject({ accountId: 'acc-a', reason: null })
    // acc-a cannot hold 150n — the pin falls back to acc-b instead of failing.
    const big = await planBatchUploads('user-1', [{ fileName: 'b.bin', mimeType: 'application/octet-stream', sizeBytes: 150n }], 'acc-a')
    expect(big.plans[0]).toMatchObject({ accountId: 'acc-b', reason: null })
  })

  it('rejects duplicate file names without routing either occurrence', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n)])
    const result = await planBatchUploads('user-1', [
      { fileName: 'dup.bin', mimeType: 'application/octet-stream', sizeBytes: 10n },
      { fileName: 'dup.bin', mimeType: 'application/octet-stream', sizeBytes: 10n },
    ])
    expect(result.plans.every((p) => p.reason === 'duplicate' && p.accountId === null)).toBe(true)
    expect(result.totalRoutedBytes).toBe(0n)
    expect(result.unroutedBytes).toBe(20n)
  })

  it('returns zeroed totals for an empty batch', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n)])
    const result = await planBatchUploads('user-1', [])
    expect(result).toEqual({ plans: [], totalBytes: 0n, totalRoutedBytes: 0n, unroutedBytes: 0n })
  })

  it('excludes autoAllocationEnabled:false accounts from planning (all-OFF → all files unroutable)', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 500n, false, false), h.account('acc-b', 'google_drive', 200n, false, false)])
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 10n }])
    expect(result.plans).toEqual([{ fileName: 'a.bin', accountId: null, provider: null, reason: 'no_accounts' }])
    expect(result.unroutedBytes).toBe(10n)
  })

  it('excludes autoAllocationEnabled:false accounts even when they have the most space', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 500n, false, false), h.account('acc-b', 'google_drive', 50n, false, true)])
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 30n }])
    expect(result.plans).toEqual([{ fileName: 'a.bin', accountId: 'acc-b', provider: 'google_drive', reason: null }])
  })

  it('keeps a manual (soft) pin on an autoAllocationEnabled:false account authoritative', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 500n, false, false), h.account('acc-b', 'google_drive', 200n, false, true)])
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 30n }], 'acc-a')
    expect(result.plans).toEqual([{ fileName: 'a.bin', accountId: 'acc-a', provider: 'google_drive', reason: null }])
  })
})

describe('selectAccount — Auto Allocation eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.allAccounts.length = 0
    ;(h.prismaMock.uploadRoutingPolicy.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'policy-1',
      userId: 'user-1',
      mode: 'most_available',
      priorityAccountIds: [],
      roundRobinCursor: 0,
      createdAt: h.now,
      updatedAt: h.now,
    })
  })

  it('excludes autoAllocationEnabled:false accounts from most_available routing', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 500n, false, false), h.account('acc-b', 'google_drive', 200n, false, true)])
    const selected = await selectAccount('user-1', 30n)
    expect(selected?.id).toBe('acc-b')
  })

  it('round-robin with B disabled rotates A,C,A,C — no cursor skip, no broken rotation', async () => {
    const accounts = [
      h.account('acc-a', 'google_drive', 100n, false, true),
      h.account('acc-b', 'google_drive', 100n, false, false),
      h.account('acc-c', 'google_drive', 100n, false, true),
    ]
    setupAccounts(accounts)
    let cursor = 0
    ;(h.prismaMock.uploadRoutingPolicy.upsert as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      id: 'policy-1',
      userId: 'user-1',
      mode: 'round_robin',
      priorityAccountIds: ['acc-a', 'acc-b', 'acc-c'],
      roundRobinCursor: cursor,
      createdAt: h.now,
      updatedAt: h.now,
    }))
    ;(h.prismaMock.uploadRoutingPolicy.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: { roundRobinCursor: number } }) => {
      cursor = data.roundRobinCursor
      return { id: 'policy-1' }
    })
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      const selected = await selectAccount('user-1', 10n)
      expect(selected).not.toBeNull()
      seen.push(selected!.id)
    }
    // Disabled acc-b must never appear; rotation stays A,C,A,C.
    expect(seen).toEqual(['acc-a', 'acc-c', 'acc-a', 'acc-c'])
  })

  it('priority mode ignores autoAllocationEnabled:false accounts', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 100n, false, false), h.account('acc-b', 'google_drive', 200n, false, true)])
    ;(h.prismaMock.uploadRoutingPolicy.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'policy-1',
      userId: 'user-1',
      mode: 'priority',
      priorityAccountIds: ['acc-a'],
      roundRobinCursor: 0,
      createdAt: h.now,
      updatedAt: h.now,
    })
    const selected = await selectAccount('user-1', 10n)
    expect(selected?.id).toBe('acc-b')
  })
})

describe('routing eligibility — REAUTH_REQUIRED', () => {
  it('selectAccount picks the healthy account over a reauth one with an existing mapping (A reauth, B healthy)', async () => {
    setupAccounts([
      h.account('acc-a', 'google_drive', 500n, false, true, 'reauth_required'),
      h.account('acc-b', 'google_drive', 100n, false, true),
    ])
    // Even though acc-a has both more space and a preferred folder location
    // (mapping exists), broken auth must exclude it — B wins.
    const selected = await selectAccount('user-1', 10n, new Map(), undefined, true, ['acc-a'])
    expect(selected?.id).toBe('acc-b')
  })

  it('selectAccount returns null when every enabled account is reauth', async () => {
    setupAccounts([
      h.account('acc-a', 'google_drive', 500n, false, true, 'reauth_required'),
      h.account('acc-b', 'google_drive', 300n, false, true, 'reauth_required'),
    ])
    const selected = await selectAccount('user-1', 10n)
    expect(selected).toBeNull()
  })

  it('planBatchUploads excludes reauth accounts even with a manual pin', async () => {
    setupAccounts([h.account('acc-a', 'google_drive', 500n, false, true, 'reauth_required')])
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 10n }], 'acc-a')
    expect(result.plans[0]).toEqual({ fileName: 'a.bin', accountId: null, provider: null, reason: 'no_accounts' })
  })

  it('planBatchUploads routes to the healthy account when the pinned one is reauth', async () => {
    setupAccounts([
      h.account('acc-a', 'google_drive', 500n, false, true, 'reauth_required'),
      h.account('acc-b', 'google_drive', 100n, false, true),
    ])
    const result = await planBatchUploads('user-1', [{ fileName: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 10n }], 'acc-a')
    expect(result.plans[0].accountId).toBe('acc-b')
  })

  it('keeps S3 accounts unaffected by the reauth concept (status stays connected)', async () => {
    setupAccounts([h.account('acc-s3', 's3', 500n, false, true)])
    const selected = await selectAccount('user-1', 10n)
    expect(selected?.id).toBe('acc-s3')
  })
})
