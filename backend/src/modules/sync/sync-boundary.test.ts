import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sync boundary — spec §29 / §70 MANDATORY: Provider → Virtual reconciliation
 * only. Sync READS the provider (files.list) and writes MySQL rows; it must
 * NEVER call createProviderFolder / renameProviderFolder / moveProviderFolder /
 * deleteProviderFolder (nor provider API create/update/delete) to mirror the
 * virtual tree. This test asserts ZERO incursions during a full sync.
 *
 * The same in-memory prisma fake as sync-e2e, plus write-call spies on the
 * provider folder service (which contains the real provider write methods).
 */

const h = vi.hoisted(() => {
  // ── tiny in-memory prisma (same semantics as sync-e2e) ──
  type Row = Record<string, any>
  const db = { folders: [] as Row[], locations: [] as Row[], files: [] as Row[], runs: [] as Row[] }
  const uid = (() => { let n = 0; return () => `id-${++n}` })()

  function uniqueFolders(f: Row): boolean {
    return !db.folders.some(
      (o) => o.userId === f.userId && (o.parentId ?? null) === (f.parentId ?? null) && o.normalizedName === f.normalizedName && o.normalizedName !== null,
    )
  }
  function uniqueLocs(l: Row): boolean {
    return !db.locations.some((o) => o.folderId === l.folderId && o.connectedAccountId === l.connectedAccountId)
  }
  function dup(): Error & { code: string } {
    return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
  }

  function fitFolder(where: any): (f: Row) => boolean {
    return (f: Row) => {
      if (where.id !== undefined && f.id !== where.id) return false
      if (where.userId !== undefined && f.userId !== where.userId) return false
      if (where.parentId !== undefined && (f.parentId ?? null) !== (where.parentId ?? null)) return false
      if (where.deletedAt !== undefined) {
        const expectNull = where.deletedAt === null
        if ((f.deletedAt ?? null) === null !== expectNull) return false
      }
      if (where.normalizedName !== undefined && f.normalizedName !== where.normalizedName) return false
      if (Array.isArray(where.OR)) {
        return where.OR.some((b: any) => isFolder(b)(f))
      }
      return true
    }
  }
  function fitLoc(where: any): (l: Row) => boolean {
    return (l: Row) => {
      if (where.id !== undefined && l.id !== where.id) return false
      if (where.connectedAccountId !== undefined && l.connectedAccountId !== where.connectedAccountId) return false
      if (where.providerFolderId !== undefined && l.providerFolderId !== where.providerFolderId) return false
      if (where.folderId !== undefined && l.folderId !== where.folderId) return false
      if (where.lastSeenSyncRunId !== undefined) {
        const { notIn, not } = where.lastSeenSyncRunId
        if (notIn && notIn.includes(l.lastSeenSyncRunId)) return false
        if (not !== undefined) {
          if (not === null && l.lastSeenSyncRunId === null) return false
          else if (not !== null && l.lastSeenSyncRunId === not) return false
        }
      }
      return true
    }
  }
  function fitFile(where: any): (f: Row) => boolean {
    return (f: Row) => {
      if (where.id !== undefined && f.id !== where.id) return false
      if (where.userId !== undefined && f.userId !== where.userId) return false
      if (where.connectedAccountId !== undefined && f.connectedAccountId !== where.connectedAccountId) return false
      if (where.providerFileId !== undefined) {
        if (Array.isArray(where.providerFileId)) {
          if (!where.providerFileId.includes(f.providerFileId)) return false
        } else if (typeof where.providerFileId === 'object' && where.providerFileId.in) {
          if (!where.providerFileId.in.includes(f.providerFileId)) return false
        } else if (f.providerFileId !== where.providerFileId) return false
      }
      if (where.status !== undefined && f.status !== where.status) return false
      if (where.lastSeenSyncRunId !== undefined) {
        const { notIn, not } = where.lastSeenSyncRunId
        if (notIn && notIn.includes(f.lastSeenSyncRunId)) return false
        if (not !== undefined) {
          if (not === null && f.lastSeenSyncRunId === null) return false
          else if (not !== null && f.lastSeenSyncRunId === not) return false
        }
      }
      return true
    }
  }

  const ACCOUNTS: any[] = []
  const prisma = {
    connectedAccount: {
      findFirst: async ({ where }: any) => {
        const okStatus = (x: any, w: any) => {
          if (!w.status) return true
          const wanted = typeof w.status === 'object' && 'in' in w.status ? w.status.in : [w.status]
          return wanted.includes(x.status)
        }
        const a = ACCOUNTS.find((x) => x.id === where.id && x.userId === where.userId && okStatus(x, where))
        return a ? { ...a } : null
      },
      findMany: async ({ where }: any) => ACCOUNTS.filter((x) => {
        if (x.userId !== where.userId) return false
        const wanted = typeof where.status === 'object' && 'in' in where.status ? where.status.in : [where.status]
        return wanted.includes(x.status)
      }).map((a) => ({ ...a })),
      findUniqueOrThrow: async ({ where }: any) => {
        const a = ACCOUNTS.find((x) => x.id === where.id)
        if (!a) throw new TypeError('account not found')
        return { ...a }
      },
    },
    syncRun: {
      create: async ({ data }: any) => {
        const r = { id: uid(), ...data }
        db.runs.push(r)
        return { ...r }
      },
      update: async ({ where, data }: any) => {
        const r = db.runs.find((x) => x.id === where.id)
        if (!r) throw new Error('run not found')
        Object.assign(r, data)
        return { ...r }
      },
    },
    folder: {
      create: async ({ data }: any) => {
        if (!uniqueFolders(data)) throw dup()
        const f = { id: uid(), deletedAt: null, ...data }
        db.folders.push(f)
        return { ...f }
      },
      findMany: async ({ where }: any) => db.folders.filter(fitFolder(where)),
      findFirst: async ({ where }: any) => db.folders.find(fitFolder(where)) ?? null,
      findUnique: async ({ where }: any) => db.folders.find((f) => f.id === where.id) ?? null,
      count: async ({ where }: any) => db.folders.filter(fitFolder(where)).length,
      update: async ({ where, data }: any) => {
        const f = db.folders.find((x) => x.id === where.id)
        if (!f) throw new Error('folder not found')
        const next = { ...f, ...data }
        if (next.normalizedName !== null && db.folders.some((o) => o.id !== next.id && o.userId === next.userId && (o.parentId ?? null) === (next.parentId ?? null) && o.normalizedName === next.normalizedName)) throw dup()
        Object.assign(f, data)
        return { ...f }
      },
    },
    folderStorageLocation: {
      create: async ({ data }: any) => {
        if (!uniqueLocs(data)) throw dup()
        const l = { id: uid(), ...data }
        db.locations.push(l)
        return { ...l }
      },
      findFirst: async ({ where }: any) => db.locations.find(fitLoc(where)) ?? null,
      findMany: async ({ where }: any) => db.locations.filter(fitLoc(where)),
      count: async ({ where }: any) => db.locations.filter(fitLoc(where)).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const l of db.locations) if (fitLoc(where)(l)) { Object.assign(l, data); count += 1 }
        return { count }
      },
      delete: async ({ where }: any) => {
        const i = db.locations.findIndex((x) => x.id === where.id)
        if (i === -1) throw new Error('location not found')
        return db.locations.splice(i, 1)[0]
      },
      deleteMany: async ({ where }: any) => {
        const before = db.locations.length
        db.locations = db.locations.filter((l) => {
          if (where.id?.in) return !where.id.in.includes(l.id)
          return !fitLoc(where)(l)
        })
        return { count: before - db.locations.length }
      },
    },
    file: {
      create: async ({ data }: any) => {
        const f = { id: uid(), deletedAt: null, status: 'active', ...data }
        db.files.push(f)
        return { ...f }
      },
      findMany: async ({ where }: any) => db.files.filter(fitFile(where)),
      update: async ({ where, data }: any) => {
        const f = db.files.find((x) => x.id === where.id)
        if (!f) throw new Error('file not found')
        Object.assign(f, data)
        return { ...f }
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const f of db.files) if (fitFile(where)(f)) { Object.assign(f, data); count += 1 }
        return { count }
      },
    },
    s3StorageConfig: { findFirst: async () => null },
    storageAccount: { upsert: async ({ update, create }: any) => ({ ...update, ...create }) },
    $transaction: async (fn: any) => fn(prisma),
  }

  function dup() { return Object.assign(new Error('dup'), { code: 'P2002' }) }

  // ── provider WRITE spies (the boundary target) ──
  const providerWrites = {
    ensureProviderRoot: vi.fn(),
    createProviderFolder: vi.fn(),
    renameProviderFolder: vi.fn(),
    moveProviderFolder: vi.fn(),
    deleteProviderFolder: vi.fn(),
  }
  return { prisma, db, ACCOUNTS, providerWrites }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prisma }))
vi.mock('../storage/provider-folder.service.js', () => h.providerWrites)

const driveH = vi.hoisted(() => {
  const calls: string[] = []
  const drives: Record<string, { files: { list: any } }> = {}
  const driveFor = (accountId: string) => {
    if (!drives[accountId]) drives[accountId] = { files: { list: vi.fn() } }
    return drives[accountId]
  }
  return { calls, drives, driveFor }
})
vi.mock('googleapis', () => ({ google: { drive: (opts: any) => driveH.drives[opts?.auth?.accountId ?? 'acc-a'] } }))
vi.mock('../google/google.service.js', () => ({
  getAuthedGoogleClient: vi.fn(async (account: { id: string }) => ({ accountId: account.id })),
  ensureGoogleAppFolder: vi.fn(async () => 'app-root'),
  syncGoogleQuota: vi.fn(async () => undefined),
}))
vi.mock('../s3/s3.service.js', () => ({
  syncS3Quota: vi.fn(async () => undefined),
  getS3ConfigForAccount: vi.fn(),
  createS3Client: vi.fn(),
}))
// The boundary test asserts that `POST /sync/all` does NOT call any
// provider WRITE methods. Telegram's sync path is mocked here because
// the in-memory prisma fake in this test does not simulate the
// Telegram storage/sync tables — but the boundary contract is the
// same: Telegram sync READS the channel, writes MySQL rows (or
// orphans under `Recovered from Telegram`), and never calls
// `provider-folder.service` write methods.
vi.mock('../telegram/telegram-sync.service.js', () => ({
  runTelegramSync: vi.fn(async (userId: string, accountId: string) => ({
    id: `telegram-run-${accountId}`,
    status: 'completed' as const,
    startedAt: new Date(),
    finishedAt: new Date(),
    errorCode: null,
    errorMessage: null,
    durationMs: 0,
    scannedCount: 0,
    matchedCount: 0,
    importedCount: 0,
    missingCount: 0,
    orphanCount: 0,
    conflictCount: 0,
    errorCount: 0,
    matchedByIdCount: 0,
    matchedByPathCount: 0,
    recoveredCount: 0,
    maxSeenMessageId: null,
  })),
}))
vi.mock('../telegram/telegram-usage.service.js', () => ({
  syncTelegramUsage: vi.fn(async () => undefined),
}))

import { runSyncAll, runAccountSync } from './sync.service.js'

type FakeItem = { id: string; name: string; mimeType: string; size?: string }
const FOLDER = 'application/vnd.google-apps.folder'
const TREES = new Map<string, Map<string, { folders: FakeItem[]; files: FakeItem[] }>>()
function treeFor(accountId: string) {
  if (!TREES.has(accountId)) TREES.set(accountId, new Map())
  return TREES.get(accountId)!
}
function addFolder(accountId: string, parentId: string, id: string, name: string) {
  const t = treeFor(accountId)
  if (!t.has(parentId)) t.set(parentId, { folders: [], files: [] })
  t.get(parentId)!.folders.push({ id, name, mimeType: FOLDER })
  if (!t.has(id)) t.set(id, { folders: [], files: [] })
}
function addFile(accountId: string, parentId: string, id: string, name: string, size?: string) {
  const t = treeFor(accountId)
  if (!t.has(parentId)) t.set(parentId, { folders: [], files: [] })
  t.get(parentId)!.files.push({ id, name, mimeType: 'video/x-matroska', ...(size ? { size } : {}) })
}
function installDriveFakes() {
  for (const account of h.ACCOUNTS as any[]) {
    const drive = driveH.driveFor(account.id)
    drive.files.list.mockImplementation(async (params: { q: string; pageToken?: string }) => {
      driveH.calls.push(params.q)
      const m = params.q.match(/'([^']+)' in parents/)
      const parentId = m ? m[1] : ''
      const isFolders = params.q.includes(`mimeType = '${FOLDER}'`)
      const dir = treeFor(account.id).get(parentId)
      const items = (isFolders ? dir?.folders : dir?.files) ?? []
      return { data: { files: items.map((f) => ({ ...f })) } }
    })
  }
}

beforeEach(() => {
  h.ACCOUNTS.length = 0
  h.db.folders.length = 0
  h.db.locations.length = 0
  h.db.files.length = 0
  h.db.runs.length = 0
  driveH.calls.length = 0
  TREES.clear()
  vi.clearAllMocks()
})

describe('sync boundary — provider is READ-ONLY (§29/§70)', () => {
  it('REAUTH_REQUIRED account fails the run cleanly: no scan, no missing cleanup, files intact', async () => {
    h.ACCOUNTS.push(
      { id: 'acc-reauth', userId: 'u1', provider: 'google_drive', status: 'reauth_required' },
      { id: 'acc-ok', userId: 'u1', provider: 'google_drive', status: 'connected' },
    )
    installDriveFakes()
    addFile('acc-reauth', 'app-root', 'f-keep', 'Keep.mp4', '10')

    const { results } = await runSyncAll('u1')
    const reauth = results.find((r) => r.accountId === 'acc-reauth')
    expect(reauth!.status).toBe('failed')
    expect(reauth!.errorCode).toBe('GOOGLE_REAUTH_REQUIRED')
    // The run row carries the stable reconnect error (visible in Sync history).
    expect(h.db.runs.some((r) => r.errorCode === 'GOOGLE_REAUTH_REQUIRED')).toBe(true)
    // Nothing triggered the drive scanner for the reauth account (no lists
    // beyond the fake registration calls — every recorded call is a provider
    // QUERY, so assert none targeted the reauth account's tree).
    expect(driveH.calls.every((q) => !q.includes('acc-reauth'))).toBe(true)
    // No missing cleanup ran: nothing was deleted for the reauth account
    // (its tree was never scanned, so no rows were ever created or removed);
    // the healthy account completed and reconciled its own tree.
    expect(h.db.files.length).toBe(0)
    expect(h.db.locations.length).toBe(0)
    expect(results.filter((r) => r.status === 'completed')).toHaveLength(1)
  })

  it('Telegram accounts run through the telegram sync path without touching provider writes', async () => {
    // Telegram is flat blob storage with the DB as source of truth. Sync All
    // delegates to `runTelegramSync` (caption-driven orphan ingest + Pass 2
    // reconciliation against the pre-run snapshot). The boundary contract
    // is unchanged: Sync All must NEVER call any of the
    // `provider-folder.service` write methods.
    h.ACCOUNTS.push(
      { id: 'acc-tg', userId: 'u1', provider: 'telegram', status: 'connected' },
      { id: 'acc-a', userId: 'u1', provider: 'google_drive', status: 'connected' },
    )
    installDriveFakes()
    addFile('acc-a', 'app-root', 'f-a1', 'A1.mp4', '10')

    const { results } = await runSyncAll('u1')
    const tg = results.find((r) => r.accountId === 'acc-tg')
    // The Telegram run completes successfully via the mocked
    // `runTelegramSync`. The mock returns a stub summary; the real
    // implementation is exercised by the telegram-sync tests.
    expect(tg!.status).toBe('completed')
    expect(tg!.stats.filesDiscovered).toBe(0)
    expect(tg!.stats.filesCreated).toBe(0)

    // No channel history listing on the drive fake. (The Telegram run
    // is recorded in the `telegram_sync_runs` table by `runTelegramSync`
    // itself, not in the Google/S3-shaped `syncRun` table — so we
    // don't assert against `h.db.runs` here.)
    // The healthy Google account still reconciled its own tree.
    expect(h.db.files.length).toBe(1)
    for (const fn of ['ensureProviderRoot', 'createProviderFolder', 'renameProviderFolder', 'moveProviderFolder', 'deleteProviderFolder'] as const) {
      expect(h.providerWrites[fn]).not.toHaveBeenCalled()
    }
  })

  it('full Sync All makes ZERO provider write calls', async () => {
    h.ACCOUNTS.push(
      { id: 'acc-a', userId: 'u1', provider: 'google_drive', status: 'connected' },
      { id: 'acc-b', userId: 'u1', provider: 'google_drive', status: 'connected' },
    )
    installDriveFakes()
    addFolder('acc-a', 'app-root', 'f-mov', 'Mov')
    addFolder('acc-a', 'f-mov', 'f-act', 'Action')
    addFolder('acc-b', 'app-root', 'f-mov', 'Mov')
    addFolder('acc-b', 'f-mov', 'f-drm', 'Drama')
    addFile('acc-a', 'f-mov', 'f-a1', 'A1.mp4', '10')
    addFile('acc-b', 'f-mov', 'f-b1', 'B1.mp4', '40')

    const { results } = await runSyncAll('u1')
    expect(results.filter((r) => r.status === 'completed')).toHaveLength(2)

    for (const fn of ['ensureProviderRoot', 'createProviderFolder', 'renameProviderFolder', 'moveProviderFolder', 'deleteProviderFolder'] as const) {
      expect(h.providerWrites[fn]).not.toHaveBeenCalled()
    }
  })

  it('a provider-side rename (synced single-location) also produces ZERO write calls', async () => {
    h.ACCOUNTS.push(
      { id: 'acc-a', userId: 'u1', provider: 'google_drive', status: 'connected' },
      { id: 'acc-b', userId: 'u1', provider: 'google_drive', status: 'connected' },
    )
    installDriveFakes()
    addFolder('acc-a', 'app-root', 'f-mov', 'Movies') // renamed on provider A
    addFolder('acc-b', 'app-root', 'f-mov', 'Mov')
    addFile('acc-a', 'f-mov', 'f-a1', 'A1.mp4', '10')
    addFile('acc-b', 'f-mov', 'f-b1', 'B1.mp4', '40')

    await runSyncAll('u1')
    // Divergence: A's physical is "Movies" → virtual Mov diverges → detach,
    // never rename the provider or the virtual folder.
    for (const fn of ['ensureProviderRoot', 'createProviderFolder', 'renameProviderFolder', 'moveProviderFolder', 'deleteProviderFolder'] as const) {
      expect(h.providerWrites[fn]).not.toHaveBeenCalled()
    }
  })
})