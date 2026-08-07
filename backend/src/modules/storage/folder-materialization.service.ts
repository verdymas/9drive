import { Prisma } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createProviderFolder, ensureProviderRoot } from './provider-folder.service.js'

/**
 * Lazy physical folder materialization.
 *
 * A virtual folder only gains a physical storage location when something
 * actually needs to be placed there. Given a virtual folder and a connected
 * account, `ensureFolderStorageLocation` guarantees the ENTIRE physical
 * ancestor chain exists on that account:
 *
 *   ensure(Marvel, Drive B)
 *     ├── ensure(Action, Drive B)     → location row or create
 *     │     └── ensure(Movies, Drive B) → location row or create
 *     │           └── provider root (9drive) → find-or-create
 *     ├── create physical Action under Movies
 *     └── create physical Marvel under Action
 *
 * Concurrency: the DB unique key `[folderId, connectedAccountId]` is the
 * primary guard. Each level's location row is persisted immediately after its
 * provider folder is created, so a concurrent materialization re-reads the
 * winner's row (P2002 → re-read) instead of creating duplicates. A residual
 * provider-level race (two same-name Drive siblings) is bounded by the
 * find-by-name reconciliation inside `createProviderFolder` and documented in
 * the final report.
 *
 * Deterministic and idempotent: calling twice returns the same location row.
 */

const MAX_MATERIALIZATION_ATTEMPTS = 3

export type MaterializationResult = {
  location: {
    id: string
    folderId: string
    connectedAccountId: string
    provider: string
    providerFolderId: string
  }
  createdCount: number
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * Ensure the virtual folder + account pair has a physical location, creating
 * every missing ancestor level on the account. Returns the location row for
 * the requested folder and how many levels were newly created (0 = reused).
 */
export async function ensureFolderStorageLocation(
  userId: string,
  virtualFolderId: string,
  connectedAccountId: string,
): Promise<MaterializationResult> {
  const account = await prisma.connectedAccount.findFirst({
    where: { id: connectedAccountId, userId, status: 'connected' },
  })
  if (!account) throw new AppError('STORAGE_ACCOUNT_NOT_ELIGIBLE', 'The storage account is not connected or does not belong to this user.', 400)

  for (let attempt = 0; attempt < MAX_MATERIALIZATION_ATTEMPTS; attempt++) {
    const existing = await prisma.folderStorageLocation.findUnique({
      where: { folderId_connectedAccountId: { folderId: virtualFolderId, connectedAccountId } },
    })
    if (existing) {
      logReused(virtualFolderId, connectedAccountId, account.provider)
      return { location: existing, createdCount: 0 }
    }

    // Load the virtual folder + ancestors in one shot (avoids N+1 on deep
    // trees) and verify ownership of the requested folder.
    const allFolders = await prisma.folder.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true, parentId: true },
    })
    const byId = new Map(allFolders.map((f) => [f.id, f]))
    const target = byId.get(virtualFolderId)
    if (!target) throw new AppError('FOLDER_NOT_FOUND', 'The destination folder does not exist.', 404)

    // Ancestor chain, root first.
    const chain: Array<{ id: string; name: string; parentId: string | null }> = []
    let cursor: { id: string; name: string; parentId: string | null } | undefined = target
    while (cursor) {
      chain.unshift(cursor)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }

    // Existing locations for the whole chain on this account.
    const chainIds = chain.map((f) => f.id)
    const existingLocations = await prisma.folderStorageLocation.findMany({
      where: { folderId: { in: chainIds }, connectedAccountId },
    })
    const locationByFolderId = new Map(existingLocations.map((l) => [l.folderId, l]))

    // Fast path: the target already has a location (found by the earlier
    // per-request lookup or by the chain scan).
    const targetLocation = locationByFolderId.get(virtualFolderId)
    if (targetLocation) {
      logReused(virtualFolderId, connectedAccountId, account.provider)
      return { location: targetLocation, createdCount: 0 }
    }

    const rootProviderId = await ensureProviderRoot(account)

    // Walk the chain from the root down, creating each missing level. `parent`
    // starts at the provider root and becomes the previous level's provider id.
    let parentProviderId = rootProviderId
    let createdCount = 0
    for (const folder of chain) {
      const known = locationByFolderId.get(folder.id)
      if (known) {
        parentProviderId = known.providerFolderId
        continue
      }

      let providerFolderId: string
      try {
        providerFolderId = await createProviderFolder(account, folder.name, parentProviderId)
      } catch (error) {
        if (isUniqueViolation(error)) throw error // handled by the retry loop
        throw new AppError('FOLDER_MATERIALIZATION_FAILED', `Failed to create the physical folder for "${folder.name}".`, 502)
      }

      try {
        await prisma.folderStorageLocation.create({
          data: {
            folderId: folder.id,
            connectedAccountId,
            provider: account.provider,
            providerFolderId,
          },
        })
        createdCount += 1
        logCreated(folder.id, connectedAccountId, account.provider)
      } catch (error) {
        if (isUniqueViolation(error)) {
          // A concurrent upload materialized this level first; re-read its row
          // and continue from it (the provider folder id may differ from ours).
          // When the winner row is also gone (deleted mid-flight), retry the
          // whole chain — bounded by the outer attempt loop, which then throws
          // FOLDER_MATERIALIZATION_FAILED instead of leaking the raw P2002.
          const winner = await prisma.folderStorageLocation.findUnique({
            where: { folderId_connectedAccountId: { folderId: folder.id, connectedAccountId } },
          })
          if (winner) {
            parentProviderId = winner.providerFolderId
            continue
          }
          throw new AppError('FOLDER_MATERIALIZATION_FAILED', 'Could not materialize the physical folder after a concurrent creation conflict.', 502)
        }
        throw error
      }
      parentProviderId = providerFolderId
    }

    const finalLocation = await prisma.folderStorageLocation.findUnique({
      where: { folderId_connectedAccountId: { folderId: virtualFolderId, connectedAccountId } },
    })
    if (!finalLocation) throw new AppError('FOLDER_MATERIALIZATION_FAILED', 'Physical folder location could not be persisted.', 502)
    return { location: finalLocation, createdCount }
  }

  throw new AppError('FOLDER_MATERIALIZATION_FAILED', 'Could not materialize the folder storage location after retrying concurrent creation.', 502)
}

function logCreated(virtualFolderId: string, connectedAccountId: string, provider: string) {
  console.info('[folder-materialization]', JSON.stringify({
    event: 'folder_storage_location.created',
    virtualFolderId,
    connectedAccountId,
    provider,
    createdLocationCount: 1,
    reusedExistingLocation: false,
  }))
}

function logReused(virtualFolderId: string, connectedAccountId: string, provider: string) {
  console.info('[folder-materialization]', JSON.stringify({
    event: 'folder_storage_location.reused',
    virtualFolderId,
    connectedAccountId,
    provider,
    createdLocationCount: 0,
    reusedExistingLocation: true,
  }))
}
