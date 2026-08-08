import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sync E2E — spec §69: A/Mov+A2 + B/Mov+B2 → Sync All → ONE virtual Mov with
 * two mappings and all files in one virtual tree; repeat idempotent; delete a
 * file on A → A-only soft-delete, B untouched; delete A/Mov physically →
 * A mapping removed while B's survives; add account C → existing Mov reused.
 *
 * The Drive fake is a shared TREE (both accounts list the same physical tree,
 * like the real spec scenario), and the in-memory prisma fake enforces the
 * real unique constraints.
 */

// ---------- fake prisma ----------
const h = vi.hoisted(() => {
  // Real unique-constraint enforcement in the in-memory fake.
  type Row = Record<string, any>
  const db = {
    folders: [] as Row[],
    locations: [] as Row[],
    files: [] as Row[],
    runs: [] as Row[],
  }
  const uid = (() => { let n = 0; return () => `id-${++n}` })()

  function uniqueFolders(f: Row): boolean {
    return !db.folders.some(
      (o) => o.userId === f.userId && (o.parentId ?? null) === (f.parentId ?? null) && o.normalizedName === f.normalizedName && o.normalizedName !== null,
    )
  }
  function uniqueLocs(l: Row): boolean {
    return !db.locations.some((o) => o.folderId === l.folderId && o.connectedAccountId === l.connectedAccountId)
  }

  function isP2002(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  }
  function duplicateError(): Error & { code: string } {
    return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
  }

  const prisma = {
    connectedAccount: {
      findFirst: async ({ where }: any) => {
        const acct = ACCOUNTS.find((x) => x.id === where.id && x.userId === where.userId && x.status === where.status)
        return acct ? { ...acct } : null
      },
      findMany: async ({ where }: any) =>
        ACCOUNTS.filter((x) => x.userId === where.userId && x.status === where.status).map((a) => ({ ...a })),
      findUniqueOrThrow: async ({ where }: any) => {
        const acct = ACCOUNTS.find((x) => x.id === where.id)
        if (!acct) throw new TypeError('account not found')
        return { ...acct }
      },
    },
    syncRun: {
      create: async ({ data }: any) => {
        const r = { id: uid(), ...data, startedAt: new Date() }
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
        if (!uniqueFolders(data)) throw duplicateError()
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
        // Enforce normalizedName unique if the update changes it.
        const next = { ...f, ...data }
        if (next.normalizedName !== null && db.folders.some((o) => o.id !== next.id && o.userId === next.userId && (o.parentId ?? null) === (next.parentId ?? null) && o.normalizedName === next.normalizedName)) throw duplicateError()
        Object.assign(f, data)
        return { ...f }
      },
    },
    folderStorageLocation: {
      create: async ({ data }: any) => {
        if (!uniqueLocs(data)) throw duplicateError()
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
          // `{ id: { in: [...] } }` — the reconciler pre-selects ids.
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
    s3StorageConfig: {
      findFirst: async () => null,
    },
    storageAccount: { upsert: async ({ create, update }: any) => ({ ...update, ...create }) },
    $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  }

  // Folder matcher with `normalizedName OR legacy` semantics used by the reconciler.
  function fitFolder(where: any): (f: Row) => boolean {
    return (f: Row) => {
      if (where.userId !== undefined && f.userId !== where.userId) return false
      if (where.parentId !== undefined && (f.parentId ?? null) !== (where.parentId ?? null)) return false
      if (where.deletedAt !== undefined) {
        const expectNull = where.deletedAt === null
        if ((f.deletedAt ?? null) === null !== expectNull) return false
      }
      if (where.normalizedName !== undefined) {
        const norm = where.normalizedName
        if (norm !== null) { if (f.normalizedName !== norm) return false }
        else { if (!(f.normalizedName === null && String(f.name).trim().toLowerCase() === norm)) return false }
      }
      // For composite OR branches, approximate: match if any branch fits.
      if (Array.isArray(where.OR)) {
        return where.OR.some((branch: any) => fitFolder(branch)(f))
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
          if (not === null && l.lastSeenSyncRunId === null) return false // must be non-null
          else if (not !== null && l.lastSeenSyncRunId === not) return false
        }
      }
      return true
    }
  }
  function fitFile(where: any): (f: Row) => boolean {
    return (f: Row) => {
      if (where.connectedAccountId !== undefined && f.connectedAccountId !== where.connectedAccountId) return false
      if (where.providerFileId !== undefined) {
        if (Array.isArray(where.providerFileId)) {
          if (!where.providerFileId.includes(f.providerFileId)) return false
        } else if (typeof where.providerFileId === 'object' && where.providerFileId.in) {
          if (!where.providerFileId.in.includes(f.providerFileId)) return false
        } else if (f.providerFileId !== where.providerFileId) return false
      }
      if (where.userId !== undefined && f.userId !== where.userId) return false
      if (where.status !== undefined && f.status !== where.status) return false
      if (where.lastSeenSyncRunId !== undefined) {
        const { notIn, not } = where.lastSeenSyncRunId
        if (notIn && notIn.includes(f.lastSeenSyncRunId)) return false
        if (not !== undefined) {
          if (not === null && f.lastSeenSyncRunId === null) return false // must be non-null
          else if (not !== null && f.lastSeenSyncRunId === not) return false
        }
      }
      return true
    }
  }

  return { prisma, db, uid }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prisma }))

// ---------- provider fake (per-account trees) ----------
const driveH = vi.hoisted(() => {
  const calls: string[] = []
  // drives[accountId] → { files: { list: vi.fn() } }
  const drives: Record<string, { files: { list: any } }> = {}
  const driveFor = (accountId: string) => {
    if (!drives[accountId]) drives[accountId] = { files: { list: vi.fn() } }
    return drives[accountId]
  }
  return { calls, drives, driveFor }
})
vi.mock('googleapis', () => ({ google: { drive: (opts: any) => driveForUrl(opts) } }))
// per-account drive resolution: auth object carries accountId.
const driveForUrl = (opts: any) => driveH.drives[opts?.auth?.accountId ?? 'acc-a']
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

// ---------- per-account fake trees ----------
type FakeItem = { id: string; name: string; mimeType: string; size?: string }
const FOLDER = 'application/vnd.google-apps.folder'
// accountId → parentId → { folders, files }
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

/** Install the per-account list impl for all known accounts. */
function installDriveFakes() {
  for (const accountId of ACCOUNTS.map((a) => a.id)) {
    const drive = driveH.driveFor(accountId)
    drive.files.list.mockImplementation(async (params: { q: string; pageToken?: string }) => {
      driveH.calls.push(params.q)
      const m = params.q.match(/'([^']+)' in parents/)
      const parentId = m ? m[1] : ''
      const isFolders = params.q.includes(`mimeType = '${FOLDER}'`)
      const dir = treeFor(accountId).get(parentId)
      const items = (isFolders ? dir?.folders : dir?.files) ?? []
      return { data: { files: items.map((f) => ({ ...f })) } }
    })
  }
}

const ACCOUNTS = [
  { id: 'acc-a', userId: 'u1', provider: 'google_drive', status: 'connected' },
  { id: 'acc-b', userId: 'u1', provider: 'google_drive', status: 'connected' },
]

// ---------- system under test ----------
import { runSyncAll, runAccountSync } from './sync.service.js'
import { ensureGoogleAppFolder } from '../google/google.service.js'

beforeEach(() => {
  h.db.folders.length = 0
  h.db.locations.length = 0
  h.db.files.length = 0
  h.db.runs.length = 0
  driveH.calls.length = 0
  TREES.clear()
})

describe('sync E2E (§69)', () => {
  it('A/Mov+A2 + B/Mov+B2 → single virtual Mov, 2 mappings, files merged', async () => {
    // A: Mov + Mov/Action; B: Mov + Mov/Drama — different physical trees.
    addFolder('acc-a', 'app-root', 'f-mov', 'Mov')
    addFolder('acc-a', 'f-mov', 'f-act', 'Action')
    addFolder('acc-b', 'app-root', 'f-mov', 'Mov')
    addFolder('acc-b', 'f-mov', 'f-drm', 'Drama')
    addFile('acc-a', 'f-mov', 'f-a1', 'A1.mp4', '10')
    addFile('acc-a', 'f-mov', 'f-a2', 'A2.mp4', '20')
    addFile('acc-a', 'f-act', 'f-a3', 'A3.mp4', '30')
    addFile('acc-b', 'f-mov', 'f-b1', 'B1.mp4', '40')
    addFile('acc-b', 'f-mov', 'f-b2', 'B2.mp4', '50')
    addFile('acc-b', 'f-drm', 'f-b3', 'B3.mp4', '60')
    installDriveFakes()

    const { results } = await runSyncAll('u1')
    const completed = results.filter((r) => r.status === 'completed')
    expect(completed).toHaveLength(2)

    const movs = h.db.folders.filter((f) => f.name === 'Mov')
    const acts = h.db.folders.filter((f) => f.name === 'Action')
    const drms = h.db.folders.filter((f) => f.name === 'Drama')
    expect(movs).toHaveLength(1)
    expect(acts).toHaveLength(1)
    expect(drms).toHaveLength(1)
    const movId = movs[0].id
    const actId = acts[0].id

    // ONE virtual Mov with TWO mappings (A and B physically both have a Mov).
    const movLocs = h.db.locations.filter((l) => l.folderId === movId)
    expect(movLocs).toHaveLength(2)
    expect(movLocs.map((l) => l.connectedAccountId).sort()).toEqual(['acc-a', 'acc-b'])
    // Action exists only on A → one mapping; Drama only on B → one mapping.
    expect(h.db.locations.filter((l) => l.folderId === actId)).toHaveLength(1)
    expect(h.db.locations.filter((l) => l.folderId === drms[0].id)).toHaveLength(1)

    const files = h.db.files.filter((f) => f.status === 'active')
    expect(files).toHaveLength(6)
    // Files from A AND B merged under ONE virtual Mov folder.
    const movFiles = files.filter((f) => f.folderId === movId)
    expect(movFiles).toHaveLength(4)
    expect(movFiles.map((f) => f.name).sort()).toEqual(['A1.mp4', 'A2.mp4', 'B1.mp4', 'B2.mp4'])
    // Action files under the single Action virtual folder.
    expect(files.filter((f) => f.folderId === actId).map((f) => f.name)).toEqual(['A3.mp4'])

    // Quota sync ran (best-effort).
    expect(vi.mocked(ensureGoogleAppFolder)).toHaveBeenCalledTimes(2)
  })

  it('repeat Sync All is idempotent — same rows reused', async () => {
    addFolder('acc-a', 'app-root', 'f-mov', 'Mov')
    addFolder('acc-b', 'app-root', 'f-mov', 'Mov')
    addFile('acc-a', 'f-mov', 'f-a1', 'A1.mp4', '10')
    addFile('acc-b', 'f-mov', 'f-b1', 'B1.mp4', '40')
    installDriveFakes()

    await runSyncAll('u1')
    const folders1 = h.db.folders.length
    const locs1 = h.db.locations.length
    const files1 = h.db.files.length
    expect(folders1).toBe(1)
    expect(locs1).toBe(2)

    const { results } = await runSyncAll('u1')
    const completed = results.filter((r) => r.status === 'completed')
    expect(completed).toHaveLength(2)

    expect(h.db.folders.length).toBe(folders1)
    expect(h.db.locations.length).toBe(locs1)
    expect(h.db.files.length).toBe(files1)
  })

  it('delete a file on A → A-only soft-delete, B untouched', async () => {
    addFolder('acc-a', 'app-root', 'f-mov', 'Mov')
    addFolder('acc-b', 'app-root', 'f-mov', 'Mov')
    addFile('acc-a', 'f-mov', 'f-a1', 'A1.mp4', '10')
    addFile('acc-b', 'f-mov', 'f-b1', 'B1.mp4', '40')
    installDriveFakes()

    await runSyncAll('u1')

    // A deletes A1: remove from A's tree.
    const aMovDir = treeFor('acc-a').get('f-mov')!
    aMovDir.files = aMovDir.files.filter((f) => f.id !== 'f-a1')

    const aRes = await runAccountSync('u1', 'acc-a')
    expect(aRes.status).toBe('completed')

    const a1 = h.db.files.find((f) => f.providerFileId === 'f-a1')
    const b1 = h.db.files.find((f) => f.providerFileId === 'f-b1')
    expect(a1.status).toBe('deleted')
    expect(a1.deletedAt).toBeTruthy()
    expect(b1.status).toBe('active')
    expect(b1.deletedAt).toBeNull()
  })

  it('delete A/Mov physical → A mapping removed, virtual Mov + B mapping remain', async () => {
    addFolder('acc-a', 'app-root', 'f-mov', 'Mov')
    addFolder('acc-b', 'app-root', 'f-mov', 'Mov')
    addFile('acc-a', 'f-mov', 'f-a1', 'A1.mp4', '10')
    addFile('acc-b', 'f-mov', 'f-b1', 'B1.mp4', '40')
    installDriveFakes()

    await runSyncAll('u1')
    const movId = h.db.folders.find((f) => f.name === 'Mov')!.id

    // A deletes the whole Mov folder physically.
    treeFor('acc-a').get('app-root')!.folders = treeFor('acc-a').get('app-root')!.folders.filter((f) => f.id !== 'f-mov')

    await runAccountSync('u1', 'acc-a')

    const aLoc = h.db.locations.find((l) => l.connectedAccountId === 'acc-a')
    const bLoc = h.db.locations.find((l) => l.connectedAccountId === 'acc-b')
    expect(aLoc).toBeUndefined()
    expect(bLoc).toBeTruthy()
    // Virtual Mov folder survives with B's mapping.
    expect(h.db.folders.find((f) => f.id === movId)).toBeTruthy()
    // A's file under the folder was soft-deleted too.
    const a1 = h.db.files.find((f) => f.providerFileId === 'f-a1')
    expect(a1.status).toBe('deleted')
  })

  it('add account C → existing Mov reused (no duplicate virtual folder)', async () => {
    addFolder('acc-a', 'app-root', 'f-mov', 'Mov')
    addFolder('acc-b', 'app-root', 'f-mov', 'Mov')
    addFile('acc-a', 'f-mov', 'f-a1', 'A1.mp4', '10')
    addFile('acc-b', 'f-mov', 'f-b1', 'B1.mp4', '40')

    ACCOUNTS.push({ id: 'acc-c', userId: 'u1', provider: 'google_drive', status: 'connected' })
    try {
      addFolder('acc-c', 'app-root', 'f-mov', 'Mov')
      addFile('acc-c', 'f-mov', 'f-c1', 'C1.mp4', '70')
      installDriveFakes()

      await runSyncAll('u1')

      const movs = h.db.folders.filter((f) => f.name === 'Mov')
      expect(movs).toHaveLength(1)
      const movLocs = h.db.locations.filter((l) => l.folderId === movs[0].id)
      expect(movLocs).toHaveLength(3)
      expect(movLocs.map((l) => l.connectedAccountId).sort()).toEqual(['acc-a', 'acc-b', 'acc-c'])
    } finally {
      ACCOUNTS.pop()
    }
  })
})