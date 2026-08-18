import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveUploadPlacement, rerouteOrFail } from './upload-placement.service.js'

// ── Mocks ────────────────────────────────────────────────────────────────────
// resolveUploadPlacement uses prisma (accounts, folder storage locations) and
// selectAccount (storage-routing) and ensureFolderStorageLocation
// (materialization). selectAccount is mocked to return a canned account;
// materialization is mocked to return a canned location.
const h = vi.hoisted(() => {
  const now = new Date('2026-08-07T00:00:00.000Z')
  const account = (id: string, provider: string, availableBytes: bigint | null, autoAllocationEnabled = true) => ({
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
    status: 'connected',
    autoAllocationEnabled,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    storageAccount: {
      id: `sa-${id}`,
      connectedAccountId: id,
      totalBytes: null,
      usedBytes: 0n,
      availableBytes,
      trashBytes: null,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  })

  const accounts: any[] = []
  const locations: Array<{ folderId: string; connectedAccountId: string }> = []

  const prismaMock = {
    connectedAccount: {
      findFirst: vi.fn(async ({ where, include }: { where: any; include?: { storageAccount?: boolean } }) => {
        // The allocation pre-check queries findFirst without id (by userId +
        // status + autoAllocationEnabled); the manual pin queries it by id.
        const match = accounts.find((a) => {
          if (where.id !== undefined) return a.id === where.id
          if (where.userId && a.userId !== where.userId) return false
          if (where.status && a.status !== where.status) return false
          if (where.autoAllocationEnabled !== undefined && a.autoAllocationEnabled !== where.autoAllocationEnabled) return false
          return true
        })
        if (!match) return null
        return include?.storageAccount ? { ...match, storageAccount: match.storageAccount ?? null } : match
      }),
    },
    folderStorageLocation: {
      findMany: vi.fn(async ({ where }: { where: { folderId?: string } }) => {
        return locations.filter((l) => !where.folderId || l.folderId === where.folderId)
      }),
    },
  }

  return { prismaMock, account, accounts, locations, now }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

// selectAccount mocked: returns the eligible account with the most space.
vi.mock('../uploads/storage-routing.service.js', () => ({
  selectAccount: vi.fn(async (_userId: string, sizeBytes: bigint) => {
    // Mirrors the real eligibility filter: autoAllocationEnabled must be true
    // (pre-routing exclusion), null quota = eligible, and the account must hold
    // `sizeBytes` (minus nothing — no reservations here).
    const eligible = h.accounts.filter((a) => {
      if (a.autoAllocationEnabled === false) return false
      const available = a.storageAccount?.availableBytes
      return available === null || available === undefined || available >= sizeBytes
    })
    const selected = [...eligible].sort((a, b) => {
      const ba = a.storageAccount?.availableBytes ?? null
      const bb = b.storageAccount?.availableBytes ?? null
      if (ba === null) return -1
      if (bb === null) return 1
      return Number(bb - ba)
    })[0] ?? null
    return selected
  }),
}))

// Materialization mocked: returns a canned location row.
vi.mock('./folder-materialization.service.js', () => ({
  ensureFolderStorageLocation: vi.fn(async (_userId: string, virtualFolderId: string, connectedAccountId: string) => ({
    location: {
      id: `loc-${virtualFolderId}-${connectedAccountId}`,
      folderId: virtualFolderId,
      connectedAccountId,
      provider: h.accounts.find((a) => a.id === connectedAccountId)?.provider ?? 'google_drive',
      providerFolderId: `provider-folder-${virtualFolderId}-${connectedAccountId}`,
    },
    createdCount: 1,
  })),
}))

// Provider root mocked for root-level (no folder) uploads.
vi.mock('./provider-folder.service.js', () => ({
  ensureProviderRoot: vi.fn(async () => 'ROOT'),
}))

import { ensureFolderStorageLocation } from './folder-materialization.service.js'
import { selectAccount as selectAccountMock } from '../uploads/storage-routing.service.js'

function reset() {
  vi.clearAllMocks()
  // The "rejects a manual pin" test overrides the shared findFirst; restore
  // its real implementation so it cannot leak into later tests.
  ;(h.prismaMock.connectedAccount.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({ where, include }: { where: any; include?: { storageAccount?: boolean } }) => {
    const match = h.accounts.find((a) => {
      if (where.id !== undefined) return a.id === where.id
      if (where.userId && a.userId !== where.userId) return false
      if (where.status && a.status !== where.status) return false
      if (where.autoAllocationEnabled !== undefined && a.autoAllocationEnabled !== where.autoAllocationEnabled) return false
      return true
    })
    if (!match) return null
    return include?.storageAccount ? { ...match, storageAccount: match.storageAccount ?? null } : match
  })
  // The "upload-1/upload-2" test queues mockResolvedValueOnce on selectAccount;
  // restore the default implementation (most-space eligible).
  selectAccountMock.mockImplementation(async (_userId: string, sizeBytes: bigint) => {
    const eligible = h.accounts.filter((a) => {
      if (a.autoAllocationEnabled === false) return false
      const available = a.storageAccount?.availableBytes
      return available === null || available === undefined || available >= sizeBytes
    })
    const selected = [...eligible].sort((a, b) => {
      const ba = a.storageAccount?.availableBytes ?? null
      const bb = b.storageAccount?.availableBytes ?? null
      if (ba === null) return -1
      if (bb === null) return 1
      return Number(bb - ba)
    })[0] ?? null
    return selected
  })
  h.accounts.length = 0
  h.locations.length = 0
}

function addLocation(folderId: string, connectedAccountId: string) {
  h.locations.push({ folderId, connectedAccountId })
}

describe('resolveUploadPlacement — Automatic', () => {
  beforeEach(async () => reset())

  it('Scenario A: picks the account with the folder location when quota ties are close (preference is only a tie-breaker)', async () => {
    // Drive A: 100GB free, has the destination folder. Drive B: 50GB free.
    h.accounts.push(h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 50n))
    addLocation('movies', 'acc-a')
    const placement = await resolveUploadPlacement('user-1', 'movies', undefined, 5n, undefined, 'multipart')
    expect(placement.connectedAccount.id).toBe('acc-a')
    expect(ensureFolderStorageLocation).toHaveBeenCalledWith('user-1', 'movies', 'acc-a')
  })

  it('Scenario B: quota is the hard filter — a folder-present account with 2GB loses to a 10GB account', async () => {
    // Drive A: 2GB free (has the folder). Drive B: 10GB free (no folder).
    h.accounts.push(h.account('acc-a', 'google_drive', 2n), h.account('acc-b', 'google_drive', 10n))
    addLocation('movies', 'acc-a')
    const placement = await resolveUploadPlacement('user-1', 'movies', undefined, 6n, undefined, 'multipart')
    // acc-a cannot hold 6GB; acc-b is chosen and materialized lazily.
    expect(placement.connectedAccount.id).toBe('acc-b')
    expect(ensureFolderStorageLocation).toHaveBeenCalledWith('user-1', 'movies', 'acc-b')
  })

  it('Scenario C: no eligible account → AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 1n), h.account('acc-b', 'google_drive', 1n))
    await expect(resolveUploadPlacement('user-1', 'movies', undefined, 10n, undefined, 'multipart')).rejects.toMatchObject({ code: 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' })
  })

  it('root-level upload (no folderId) resolves the provider root without materialization', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 100n))
    const placement = await resolveUploadPlacement('user-1', undefined, undefined, 5n, undefined, 'multipart')
    expect(placement.connectedAccount.id).toBe('acc-a')
    expect(placement.folderStorageLocation.providerFolderId).toBe('ROOT')
    expect(ensureFolderStorageLocation).not.toHaveBeenCalled()
  })

  it('mandatory scenario: folder mapping on OFF Drive A cannot win over ON Drive B (B materialized lazily)', async () => {
    // Drive A: 500 free, Movies mapping exists, Auto Allocation OFF.
    // Drive B: 200 free, no Movies mapping, Auto Allocation ON.
    h.accounts.push(h.account('acc-a', 'google_drive', 500n, false), h.account('acc-b', 'google_drive', 200n, true))
    addLocation('movies', 'acc-a')
    const placement = await resolveUploadPlacement('user-1', 'movies', undefined, 10n, undefined, 'multipart')
    expect(placement.connectedAccount.id).toBe('acc-b')
    expect(ensureFolderStorageLocation).toHaveBeenCalledWith('user-1', 'movies', 'acc-b')
  })

  it('all allocation-disabled accounts → AUTOMATIC_STORAGE_NO_ALLOCATION_ENABLED_ACCOUNT (no fallback to a disabled account)', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 500n, false), h.account('acc-b', 'google_drive', 200n, false))
    await expect(resolveUploadPlacement('user-1', 'movies', undefined, 10n, undefined, 'multipart')).rejects.toMatchObject({ code: 'AUTOMATIC_STORAGE_NO_ALLOCATION_ENABLED_ACCOUNT' })
    expect(ensureFolderStorageLocation).not.toHaveBeenCalled()
  })

  it('allocation-enabled accounts that are full still yield the quota error, not the allocation error', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 1n, true), h.account('acc-b', 'google_drive', 1n, true))
    await expect(resolveUploadPlacement('user-1', 'movies', undefined, 10n, undefined, 'multipart')).rejects.toMatchObject({ code: 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' })
  })
})

describe('resolveUploadPlacement — Manual (authoritative)', () => {
  beforeEach(async () => reset())

  it('Scenario D: uses the pinned account when it has space', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 200n))
    const placement = await resolveUploadPlacement('user-1', 'movies', 'acc-a', 5n, undefined, 'multipart')
    expect(placement.connectedAccount.id).toBe('acc-a')
    expect(ensureFolderStorageLocation).toHaveBeenCalledWith('user-1', 'movies', 'acc-a')
  })

  it('Scenario D: insufficient quota on the pinned account → STORAGE_ACCOUNT_INSUFFICIENT_QUOTA, no silent switch', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 2n), h.account('acc-b', 'google_drive', 200n))
    await expect(resolveUploadPlacement('user-1', 'movies', 'acc-a', 10n, undefined, 'multipart')).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_INSUFFICIENT_QUOTA' })
    expect(ensureFolderStorageLocation).not.toHaveBeenCalled()
  })

  it('rejects a manual pin that is not connected / not the user\'s', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 100n))
    ;(h.prismaMock.connectedAccount.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await expect(resolveUploadPlacement('user-1', 'movies', 'ghost', 5n, undefined, 'multipart')).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_NOT_ELIGIBLE' })
  })

  it('reservations count against the manual pin\'s quota check', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 10n))
    await expect(resolveUploadPlacement('user-1', 'movies', 'acc-a', 6n, new Map([['acc-a', 5n]]), 'multipart')).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_INSUFFICIENT_QUOTA' })
  })

  it('manual pin on an autoAllocationEnabled:false account is accepted when quota permits (flag ignored)', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 500n, false), h.account('acc-b', 'google_drive', 200n, true))
    const placement = await resolveUploadPlacement('user-1', 'movies', 'acc-a', 10n, undefined, 'multipart')
    expect(placement.connectedAccount.id).toBe('acc-a')
    expect(ensureFolderStorageLocation).toHaveBeenCalledWith('user-1', 'movies', 'acc-a')
  })

  it('manual pin on an autoAllocationEnabled:false account with insufficient quota → quota error, no silent switch', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 1n, false), h.account('acc-b', 'google_drive', 100n, true))
    await expect(resolveUploadPlacement('user-1', 'movies', 'acc-a', 10n, undefined, 'multipart')).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_INSUFFICIENT_QUOTA' })
    expect(ensureFolderStorageLocation).not.toHaveBeenCalled()
  })
})

describe('rerouteOrFail', () => {
  beforeEach(async () => reset())

  it('Scenario E: re-selects excluding tried accounts when the first pick no longer fits', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 5n), h.account('acc-b', 'google_drive', 50n))
    // First selection picked acc-a (canned most-space is acc-b... we force it
    // by calling with tried=[acc-a]: the mock still returns acc-b).
    const placement = await rerouteOrFail('user-1', 'movies', undefined, 10n, undefined, 'multipart', ['acc-a'])
    expect(placement.connectedAccount.id).toBe('acc-b')
  })

  it('manual mode never reroutes — surfaces the quota error as-is', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 2n))
    await expect(rerouteOrFail('user-1', 'movies', 'acc-a', 10n, undefined, 'multipart', ['acc-a'])).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_INSUFFICIENT_QUOTA' })
  })

  it('gives up after the reroute bound with AUTOMATIC_STORAGE_REROUTE_EXHAUSTED', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 5n), h.account('acc-b', 'google_drive', 50n))
    // Two previous tries already exhausted the bound.
    await expect(rerouteOrFail('user-1', 'movies', undefined, 10n, undefined, 'multipart', ['acc-a', 'acc-b'])).rejects.toMatchObject({ code: 'AUTOMATIC_STORAGE_REROUTE_EXHAUSTED' })
  })

  it('upload-1-on-A / upload-2-on-B land in the same virtual folder (files aggregated by folderId)', async () => {
    h.accounts.push(h.account('acc-a', 'google_drive', 100n), h.account('acc-b', 'google_drive', 100n))
    // Emulate two uploads routed to different accounts: first pick A, then B.
    selectAccountMock.mockResolvedValueOnce(h.accounts[0]).mockResolvedValueOnce(h.accounts[1])
    const first = await resolveUploadPlacement('user-1', 'movies', undefined, 10n, undefined, 'multipart')
    const second = await resolveUploadPlacement('user-1', 'movies', undefined, 10n, undefined, 'multipart')
    expect(first.connectedAccount.id).toBe('acc-a')
    expect(second.connectedAccount.id).toBe('acc-b')
    // Both place the file in the SAME virtual folder — a file created with
    // folderId = 'movies' on either account aggregates into one virtual folder.
    expect(first.folderStorageLocation.folderId).toBe('movies')
    expect(second.folderStorageLocation.folderId).toBe('movies')
    expect(ensureFolderStorageLocation).toHaveBeenNthCalledWith(1, 'user-1', 'movies', 'acc-a')
    expect(ensureFolderStorageLocation).toHaveBeenNthCalledWith(2, 'user-1', 'movies', 'acc-b')
  })
})
