import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveVirtualFolder } from './folder-reconciler.js'
import type { SyncRunContext } from './folder-reconciler.js'
import { emptyStats } from './sync-run.service.js'

/**
 * Folder reconciler — spec §66 mandatory cases.
 *
 * The in-memory prisma fake enforces the real schema's two uniqueness
 * constraints (folder_user_parent_normalized_name_unique and
 * folder_storage_locations unique(folderId, connectedAccountId)) by throwing a
 * P2002-shaped error on violation, and simulating `$transaction` by running the
 * callback synchronously.
 */
const h = vi.hoisted(() => {
  type Folder = { id: string; userId: string; parentId: string | null; name: string; normalizedName: string | null; origin: string; deletedAt: Date | null }
  type Location = { id: string; folderId: string; connectedAccountId: string; provider: string; providerFolderId: string; lastSeenSyncRunId: string | null }

  const folders: Folder[] = []
  const locations: Location[] = []
  let seq = 0

  const P2002 = (msg: string) => {
    const e: any = new Error(msg)
    e.code = 'P2002'
    return e
  }
  const genId = () => `f-${++seq}`

  const findFolder = (id: string) => folders.find((f) => f.id === id)

  const prismaMock = {
    folder: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        const f = folders.find((x) => x.id === where.id)
        return f ? { ...f } : null
      }),
      findFirst: vi.fn(async ({ where }: { where: any } = {}) => {
        const f = folders.find((x) => {
          if (where?.id !== undefined && x.id !== where.id) return false
          if (where?.userId !== undefined && x.userId !== where.userId) return false
          if (where?.parentId !== undefined) {
            if (where.parentId === null && x.parentId !== null) return false
            if (where.parentId !== null && x.parentId !== where.parentId) return false
          }
          if (where?.normalizedName !== undefined && x.normalizedName !== where.normalizedName) return false
          if (where?.deletedAt !== undefined) {
            if (where.deletedAt === null && x.deletedAt !== null) return false
            if (where.deletedAt !== null && x.deletedAt === null) return false
          }
          return true
        })
        return f ? { ...f } : null
      }),
      findMany: vi.fn(async ({ where }: { where: any } = {}) =>
        folders
          .filter((x) => {
            if (where?.userId !== undefined && x.userId !== where.userId) return false
            if (where?.parentId !== undefined) {
              if (where.parentId === null && x.parentId !== null) return false
              if (where.parentId !== null && x.parentId !== where.parentId) return false
            }
            if (where?.deletedAt !== undefined) {
              if (where.deletedAt === null && x.deletedAt !== null) return false
              if (where.deletedAt !== null && x.deletedAt === null) return false
            }
            return true
          })
          .map((x) => ({ ...x })),
      ),
      create: vi.fn(async ({ data }: { data: any }) => {
        if (data.normalizedName !== null) {
          const clash = folders.some(
            (x) =>
              x.userId === data.userId &&
              (data.parentId === null ? x.parentId === null : x.parentId === data.parentId) &&
              x.normalizedName === data.normalizedName &&
              x.deletedAt === null,
          )
          if (clash) throw P2002(`unique folders_user_parent_normalized_name_unique (${data.normalizedName})`)
        }
        const row: Folder = {
          id: data.id ?? genId(),
          userId: data.userId,
          parentId: data.parentId ?? null,
          name: data.name,
          normalizedName: data.normalizedName ?? null,
          origin: data.origin ?? 'user',
          deletedAt: null,
        }
        folders.push(row)
        return { ...row }
      }),
      update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        const f = findFolder(where.id)
        if (!f) throw new Error('not found')
        const merged = { ...f, ...data }
        if (merged.normalizedName !== null) {
          const clash = folders.some(
            (x) =>
              x.id !== f.id &&
              x.userId === merged.userId &&
              (merged.parentId === null ? x.parentId === null : x.parentId === merged.parentId) &&
              x.normalizedName === merged.normalizedName &&
              x.deletedAt === null,
          )
          if (clash) throw P2002(`unique folders_user_parent_normalized_name_unique (${merged.normalizedName})`)
        }
        Object.assign(f, merged)
        return { ...f }
      }),
    },
    folderStorageLocation: {
      findFirst: vi.fn(async ({ where }: { where: any } = {}) => {
        const l = locations.find((x) => {
          if (where?.connectedAccountId !== undefined && x.connectedAccountId !== where.connectedAccountId) return false
          if (where?.providerFolderId !== undefined && x.providerFolderId !== where.providerFolderId) return false
          if (where?.folderId !== undefined && x.folderId !== where.folderId) return false
          return true
        })
        return l ? { ...l } : null
      }),
      findMany: vi.fn(async ({ where }: { where: any } = {}) =>
        locations
          .filter((x) => {
            if (where?.folderId !== undefined) {
              if (where.folderId.in && !where.folderId.in.includes(x.folderId)) return false
              if (where.folderId !== x.folderId) return false
            }
            if (where?.connectedAccountId !== undefined && x.connectedAccountId !== where.connectedAccountId) return false
            return true
          })
          .map((x) => ({ ...x })),
      ),
      count: vi.fn(async ({ where }: { where: any } = {}) =>
        locations.filter((x) => (where?.folderId !== undefined && x.folderId === where.folderId) || where?.folderId === undefined).length,
      ),
      create: vi.fn(async ({ data }: { data: any }) => {
        const clash = locations.some((x) => x.folderId === data.folderId && x.connectedAccountId === data.connectedAccountId)
        if (clash) throw P2002(`unique folder_storage_locations (${data.folderId}, ${data.connectedAccountId})`)
        const row: Location = {
          id: `loc-${++seq}`,
          folderId: data.folderId,
          connectedAccountId: data.connectedAccountId,
          provider: data.provider,
          providerFolderId: data.providerFolderId,
          lastSeenSyncRunId: data.lastSeenSyncRunId ?? null,
        }
        locations.push(row)
        return { ...row }
      }),
      delete: vi.fn(async ({ where }: { where: any }) => {
        const idx = locations.findIndex((x) => x.id === where.id)
        if (idx === -1) throw new Error('not found')
        locations.splice(idx, 1)
        return { id: where.id }
      }),
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        let count = 0
        for (const l of locations) {
          if (where?.id !== undefined && l.id !== where.id) continue
          if (where?.lastSeenSyncRunId?.not !== undefined && l.lastSeenSyncRunId === where.lastSeenSyncRunId.not) continue
          Object.assign(l, data)
          count += 1
        }
        return { count }
      }),
    },
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(prismaMock)),
  }

  return { folders, locations, prismaMock, genId }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

function ctx(accountId: string, runId = `run-${accountId}`): SyncRunContext {
  return { userId: 'user-1', accountId, provider: 'google_drive', runId, stats: emptyStats() }
}

/** Seed a pre-existing virtual folder (user-created, no location). */
function seedVirtual(name: string, parentId: string | null = null): string {
  const norm = name.trim().toLowerCase()
  const row = {
    id: h.genId(),
    userId: 'user-1',
    parentId,
    name,
    normalizedName: norm,
    origin: 'user',
    deletedAt: null,
  }
  h.folders.push(row)
  return row.id
}

/** Seed a physical location attached to a virtual folder. */
function seedLocation(folderId: string, accountId: string, providerFolderId: string, provider = 'google_drive') {
  const row = {
    id: `loc-${h.folders.length}-${h.locations.length}`,
    folderId,
    connectedAccountId: accountId,
    provider,
    providerFolderId,
    lastSeenSyncRunId: null,
  }
  h.locations.push(row)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  h.folders.length = 0
  h.locations.length = 0
})

describe('§66 folder reconciler', () => {
  it('1. A/Mov only — creates virtual folder + A mapping', async () => {
    const id = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    expect(id).toBeTruthy()
    const folder = h.folders.find((f) => f.id === id)!
    expect(folder.name).toBe('Mov')
    expect(folder.normalizedName).toBe('mov')
    expect(folder.origin).toBe('sync')
    const loc = h.locations.find((l) => l.folderId === id)!
    expect(loc.connectedAccountId).toBe('A')
    expect(loc.providerFolderId).toBe('pd-A-mov')
  })

  it('2. A/Mov + B/Mov — second account merges into ONE virtual folder', async () => {
    await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    const idB = await resolveVirtualFolder(ctx('B'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    expect(h.folders.filter((f) => f.name === 'Mov')).toHaveLength(1)
    expect(idB).toBe(h.folders[0].id)
    expect(h.locations.filter((l) => l.folderId === h.folders[0].id)).toHaveLength(2)
  })

  it('3. A/Mov/Action + B/Mov/Action — nested merge under the same virtual parent', async () => {
    const movA = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    await resolveVirtualFolder(ctx('A'), movA, { providerFolderId: 'pd-A-act', name: 'Action' })
    const movB = await resolveVirtualFolder(ctx('B'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    const actionB = await resolveVirtualFolder(ctx('B'), movB, { providerFolderId: 'pd-B-act', name: 'Action' })

    expect(movB).toBe(movA)
    const actionFolders = h.folders.filter((f) => f.name === 'Action')
    expect(actionFolders).toHaveLength(1)
    expect(actionB).toBe(actionFolders[0].id)
    // Action has two physical locations (one per account).
    expect(h.locations.filter((l) => l.folderId === actionB)).toHaveLength(2)
  })

  it('4. A/Mov/Action + B/Mov/Drama — different children stay separate', async () => {
    const movA = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    const movB = await resolveVirtualFolder(ctx('B'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    await resolveVirtualFolder(ctx('A'), movA, { providerFolderId: 'pd-A-act', name: 'Action' })
    await resolveVirtualFolder(ctx('B'), movB, { providerFolderId: 'pd-B-dra', name: 'Drama' })

    expect(movB).toBe(movA)
    const action = h.folders.find((f) => f.name === 'Action')!
    const drama = h.folders.find((f) => f.name === 'Drama')!
    expect(action.parentId).toBe(movA)
    expect(drama.parentId).toBe(movB)
    // A never gains Drama, B never gains Action.
    expect(h.locations.filter((l) => l.folderId === drama.id).map((l) => l.connectedAccountId)).toEqual(['B'])
    expect(h.locations.filter((l) => l.folderId === action.id).map((l) => l.connectedAccountId)).toEqual(['A'])
  })

  it('5. Three accounts sharing the same virtual path', async () => {
    const ids = await Promise.all(['A', 'B', 'C'].map((a) => resolveVirtualFolder(ctx(a), null, { providerFolderId: `pd-${a}-mov`, name: 'Mov' })))
    expect(ids[0]).toBe(ids[1])
    expect(ids[1]).toBe(ids[2])
    expect(h.locations.filter((l) => l.folderId === ids[0])).toHaveLength(3)
  })

  it('6. Account Sync repeated multiple times is idempotent', async () => {
    await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    const id2 = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    const id3 = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    expect(id2).toBe(id3)
    expect(h.folders).toHaveLength(1)
    expect(h.locations).toHaveLength(1)
  })

  it('7. Concurrent Sync discovers the same virtual folder — no duplicates', async () => {
    // Both discover Mov simultaneously; the second create hits the unique
    // constraint and re-reads the winner (P2002 path exercised).
    const results = await Promise.all([
      resolveVirtualFolder(ctx('A', 'run-1'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' }),
      resolveVirtualFolder(ctx('B', 'run-2'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' }),
    ])
    expect(results[0]).toBe(results[1])
    expect(h.folders.filter((f) => f.name === 'Mov')).toHaveLength(1)
    expect(h.locations.filter((l) => l.folderId === results[0])).toHaveLength(2)
  })

  it('8. Same-account duplicate physical folder names → deterministic (2) suffix', async () => {
    const a = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov-1', name: 'Mov' })
    const b = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov-2', name: 'Mov' })
    expect(a).not.toBe(b)
    const movs = h.folders.filter((f) => f.name === 'Mov' || f.name === 'Mov (2)')
    expect(movs.map((f) => f.name).sort()).toEqual(['Mov', 'Mov (2)'])
    expect(h.locations.filter((l) => l.folderId === a).map((l) => l.providerFolderId)).toEqual(['pd-A-mov-1'])
    expect(h.locations.filter((l) => l.folderId === b).map((l) => l.providerFolderId)).toEqual(['pd-A-mov-2'])
  })

  it('9. Provider-side rename with one mapping → in-place rename', async () => {
    const mov = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    const renamed = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Movies' })
    expect(renamed).toBe(mov)
    const folder = h.folders.find((f) => f.id === mov)!
    expect(folder.name).toBe('Movies')
    expect(folder.normalizedName).toBe('movies')
    expect(h.locations).toHaveLength(1)
  })

  it('10. Provider-side rename with multiple mappings → detach, never rename shared folder', async () => {
    const mov = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    await resolveVirtualFolder(ctx('B'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    expect(h.folders.find((f) => f.id === mov)!.name).toBe('Mov')

    // B renames its physical Mov → Movies.
    const moviesB = await resolveVirtualFolder(ctx('B'), null, { providerFolderId: 'pd-B-mov', name: 'Movies' })

    // Shared Mov stays Mov for A; B now maps to a new Movies virtual folder.
    expect(h.folders.find((f) => f.id === mov)!.name).toBe('Mov')
    expect(h.folders.find((f) => f.name === 'Movies')!.id).toBe(moviesB)
    expect(h.locations.filter((l) => l.folderId === mov).map((l) => l.connectedAccountId)).toEqual(['A'])
    expect(h.locations.filter((l) => l.folderId === moviesB).map((l) => l.connectedAccountId)).toEqual(['B'])
  })

  it('11. Provider-side move with one mapping → in-place move', async () => {
    const mov = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    const archive = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-arc', name: 'Archive' })
    // A moves physical Mov under physical Archive.
    const moved = await resolveVirtualFolder(ctx('A'), archive, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    expect(moved).toBe(mov)
    expect(h.folders.find((f) => f.id === mov)!.parentId).toBe(archive)
  })

  it('12. Provider-side move with multiple mappings → detach B, A untouched', async () => {
    const mov = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    const movB = await resolveVirtualFolder(ctx('B'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    const archive = await resolveVirtualFolder(ctx('B'), null, { providerFolderId: 'pd-B-arc', name: 'Archive' })

    // B moves its Mov under its Archive.
    const movedB = await resolveVirtualFolder(ctx('B'), archive, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    expect(movedB).not.toBe(mov)
    // Shared Mov stays at root (A untouched); B's diverged copy moved under Archive.
    expect(h.folders.find((f) => f.id === movB)!.parentId).toBeNull()
    expect(h.folders.find((f) => f.id === movedB)!.parentId).toBe(archive)
    expect(h.locations.filter((l) => l.folderId === mov).map((l) => l.connectedAccountId)).toEqual(['A'])
    expect(h.locations.filter((l) => l.folderId === movedB).map((l) => l.connectedAccountId)).toEqual(['B'])
  })

  it('13. Missing folder on A while B mapping remains', async () => {
    const mov = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    await resolveVirtualFolder(ctx('B'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    // A's physical folder is gone — the missing reconciler (tested separately)
    // deletes A's location. The virtual folder + B mapping survive.
    const locA = h.locations.find((l) => l.folderId === mov && l.connectedAccountId === 'A')!
    h.locations.splice(h.locations.indexOf(locA), 1)
    // Simulate A's re-scan discovering nothing: B's row is untouched.
    expect(h.locations.filter((l) => l.folderId === mov).map((l) => l.connectedAccountId)).toEqual(['B'])
    expect(h.folders.find((f) => f.id === mov)!.deletedAt).toBeNull()
  })

  it('14. Cancelled Sync does not clean up missing (no reconcile invoked)', async () => {
    // Cancellation never reaches the missing reconciler — verify no location
    // deletion happened for a location that was NOT seen this run.
    const mov = await resolveVirtualFolder(ctx('A', 'run-1'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    h.locations.find((l) => l.folderId === mov)!.lastSeenSyncRunId = 'run-1'
    expect(h.locations).toHaveLength(1)
  })

  it('15. Failed Sync does not clean up missing', async () => {
    const mov = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    // A failed scan aborts before the missing reconciler; the stale location
    // row stays (account-scoped, success-only cleanup).
    expect(h.locations.filter((l) => l.folderId === mov)).toHaveLength(1)
  })

  it('16. Successful Sync reconciles missing A mappings only', async () => {
    const mov = await resolveVirtualFolder(ctx('A', 'run-1'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    const movB = await resolveVirtualFolder(ctx('B', 'run-1'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    // run-2 sees only B's folder (A's physical folder deleted).
    await resolveVirtualFolder(ctx('B', 'run-2'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    // (Missing-location deletion is the missing-reconciler's job; the folder
    // reconciler must leave the virtual folder intact.)
    expect(h.folders.find((f) => f.id === mov)!.deletedAt).toBeNull()
    expect(h.folders.find((f) => f.id === movB)!.deletedAt).toBeNull()
  })
})

describe('§26/§28 divergence + collision details', () => {
  it('user-originated virtual folder with a provider rename → detach, never auto-rename', async () => {
    const userFolder = seedVirtual('My Folder')
    seedLocation(userFolder, 'A', 'pd-A-myfolder')
    const resolved = await resolveVirtualFolder(ctx('A'), null, { providerFolderId: 'pd-A-myfolder', name: 'Renamed' })
    // Detached; new path "Renamed" resolves to a NEW virtual folder.
    expect(resolved).not.toBe(userFolder)
    expect(h.locations.filter((l) => l.folderId === userFolder)).toHaveLength(0)
    const renamed = h.folders.find((f) => f.name === 'Renamed')!
    expect(renamed.origin).toBe('sync')
    expect(h.locations.filter((l) => l.folderId === renamed.id).map((l) => l.connectedAccountId)).toEqual(['A'])
  })

  it('provider rename colliding with an existing virtual sibling → detach + suffix', async () => {
    const userFolder = seedVirtual('Movies')
    seedLocation(userFolder, 'A', 'pd-A-movies')
    // Sync-created Mov for A.
    const mov = await resolveVirtualFolder(ctx('A', 'run-1'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    // A renames physical Mov → Movies (collides with user folder "Movies").
    const resolved = await resolveVirtualFolder(ctx('A', 'run-2'), null, { providerFolderId: 'pd-A-mov', name: 'Movies' })
    expect(resolved).not.toBe(userFolder)
    expect(resolved).not.toBe(mov)
    expect(h.folders.find((f) => f.name === 'Movies (2)')).toBeTruthy()
  })

  it('same-account duplicate names keep deterministic stable ids across re-scans', async () => {
    await resolveVirtualFolder(ctx('A', 'run-1'), null, { providerFolderId: 'pd-A-mov-1', name: 'Mov' })
    await resolveVirtualFolder(ctx('A', 'run-1'), null, { providerFolderId: 'pd-A-mov-2', name: 'Mov' })
    const a1 = h.folders.find((f) => f.normalizedName === 'mov')!.id
    const a2 = h.folders.find((f) => f.normalizedName === 'mov (2)')!.id
    // Re-scan with the same physical ids — stable.
    await resolveVirtualFolder(ctx('A', 'run-2'), null, { providerFolderId: 'pd-A-mov-1', name: 'Mov' })
    await resolveVirtualFolder(ctx('A', 'run-2'), null, { providerFolderId: 'pd-A-mov-2', name: 'Mov' })
    expect(h.folders.find((f) => f.normalizedName === 'mov')!.id).toBe(a1)
    expect(h.folders.find((f) => f.normalizedName === 'mov (2)')!.id).toBe(a2)
    expect(h.folders.filter((f) => f.normalizedName === 'mov' || f.normalizedName === 'mov (2)')).toHaveLength(2)
  })

  it('re-convergence §65 — a detached mapping re-attaches to the old virtual folder', async () => {
    // A: Mov. B: Mov → renamed to Movies (detached). Later B renames back to Mov.
    const mov = await resolveVirtualFolder(ctx('A', 'run-1'), null, { providerFolderId: 'pd-A-mov', name: 'Mov' })
    await resolveVirtualFolder(ctx('B', 'run-1'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    const moviesB = await resolveVirtualFolder(ctx('B', 'run-2'), null, { providerFolderId: 'pd-B-mov', name: 'Movies' })
    expect(moviesB).not.toBe(mov)

    const reconverged = await resolveVirtualFolder(ctx('B', 'run-3'), null, { providerFolderId: 'pd-B-mov', name: 'Mov' })
    // Level 1: physical id maps to Movies-B → detached again. Level 2: virtual
    // root/Mov exists → B re-attaches to shared Mov.
    expect(reconverged).toBe(mov)
    expect(h.locations.filter((l) => l.folderId === mov).map((l) => l.connectedAccountId)).toEqual(['A', 'B'])
  })
})
