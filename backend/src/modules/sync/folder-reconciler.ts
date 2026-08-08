import { prisma } from '../../config/prisma.js'
import { normalizeFolderName } from './normalize-folder-name.js'
import type { SyncStats } from './sync-run.service.js'

/**
 * Folder reconciliation — the CORE of Provider → Virtual sync.
 *
 * Every physical folder discovered on a provider is resolved to a virtual
 * folder in exactly two levels (spec §6-8, §26-28, §35-36):
 *
 *   1. PHYSICAL identity: `(connectedAccountId, providerFolderId)`. The
 *      provider's own id wins: if the mapping exists and the virtual folder is
 *      still consistent (same virtual parent, same normalized name), reuse it.
 *      If the provider changed the folder's name/parent (divergence), update
 *      in place ONLY under the §28 safe conditions (sync-originated, exactly
 *      one location, no uniqueness violation); otherwise DETACH the mapping
 *      and fall through to level 2 — never rename a shared virtual folder
 *      because one account diverged (§26-27).
 *   2. LOGICAL identity: `(userId, virtualParentId, normalizedName)`. A
 *      physical folder that merely LOOKS like this virtual path is merged into
 *      the existing virtual folder — cross-account folders merge (§8-10).
 *      Same-account duplicate sibling names are ambiguous and get a
 *      deterministic ` (2)`, ` (3)` suffix (§36) — never dropped, never merged.
 *
 * Provider writes are NEVER made here: Sync only READS the provider and writes
 * Folder / FolderStorageLocation rows. Provider folder creation happens only
 * via upload materialization, user rename/move/delete — never to mirror the
 * virtual tree (§29, boundary test §70).
 *
 * Concurrency: the `(folderId, connectedAccountId)` unique key and the
 * `(userId, parentId, normalizedName)` constraint are the primary guards.
 * Every create catches P2002 and re-reads the winner (§12).
 */

export type DiscoveredPhysicalFolder = {
  /** Provider's own stable id (Drive file id / S3 normalized prefix). */
  providerFolderId: string
  name: string
}

export type SyncRunContext = {
  userId: string
  accountId: string
  provider: string
  runId: string
  stats: SyncStats
}

function isUniqueViolation(error: unknown): boolean {
  // Duck-typed: real Prisma errors are instances of
  // Prisma.PrismaClientKnownRequestError with code P2002; test fakes throw a
  // plain Error with the same `.code`. Both are caught here.
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

/** Stamp a location row as seen by the current run (no-op when already stamped). */
async function stampLocationSeen(locationId: string, runId: string): Promise<void> {
  await prisma.folderStorageLocation.updateMany({
    where: { id: locationId, lastSeenSyncRunId: { not: runId } },
    data: { lastSeenSyncRunId: runId },
  })
}

function logEvent(ctx: SyncRunContext, event: string, data: Record<string, unknown>) {
  console.info('[sync]', JSON.stringify({ event, connectedAccountId: ctx.accountId, ...data }))
}

/**
 * Resolve a discovered physical folder to its virtual folder id, creating the
 * virtual folder + mapping when this is the first time the path is seen. Safe
 * under concurrent Sync All runs (P2002 → re-read of the winner).
 */
export async function resolveVirtualFolder(
  ctx: SyncRunContext,
  virtualParentId: string | null,
  physical: DiscoveredPhysicalFolder,
): Promise<string> {
  // ── Level 1: physical identity ───────────────────────────────────────────
  const knownLocation = await prisma.folderStorageLocation.findFirst({
    where: { connectedAccountId: ctx.accountId, providerFolderId: physical.providerFolderId },
  })

  if (knownLocation) {
    const folder = await prisma.folder.findUnique({
      where: { id: knownLocation.folderId },
      select: { id: true, name: true, normalizedName: true, parentId: true, origin: true, deletedAt: true },
    })

    const nameConsistent =
      folder !== null &&
      folder.deletedAt === null &&
      folder.parentId === virtualParentId &&
      normalizeFolderName(physical.name) === (folder.normalizedName ?? normalizeFolderName(folder.name))

    if (nameConsistent) {
      await stampLocationSeen(knownLocation.id, ctx.runId)
      ctx.stats.mappingsReused += 1
      logEvent(ctx, 'sync.folder.mapping_reused', { virtualFolderId: folder.id })
      return folder.id
    }

    // Divergence. Only safe to follow in place when the virtual folder is a
    // single-location sync-created folder (§28) and the update does not
    // collide with a sibling — otherwise detach and resolve the new path.
    if (folder !== null && folder.deletedAt === null && folder.origin === 'sync') {
      const locationCount = await prisma.folderStorageLocation.count({ where: { folderId: folder.id } })
      const renamed = locationCount === 1 ? await tryInPlaceRename(ctx, folder, virtualParentId, physical) : null
      if (renamed) {
        await stampLocationSeen(knownLocation.id, ctx.runId)
        ctx.stats.mappingsReused += 1
        return folder.id
      }
    }

    // Provider-side rename/move of a multi-location or user-originated folder:
    // detach this account from the shared virtual folder, then resolve the new
    // physical path (which may converge back onto another existing virtual
    // folder, §65).
    await prisma.folderStorageLocation.delete({ where: { id: knownLocation.id } })
    ctx.stats.mappingsDetached += 1
    logEvent(ctx, 'sync.folder.mapping_detached', { detachedFolderId: folder?.id })
  }

  // ── Level 2: logical virtual path ────────────────────────────────────────
  const norm = normalizeFolderName(physical.name)

  const candidates = await prisma.folder.findMany({
    where: { userId: ctx.userId, parentId: virtualParentId, deletedAt: null },
    select: { id: true, name: true, normalizedName: true },
  })
  // Canonical match preferred; legacy rows have a NULL normalizedName but the
  // same effective path (mapVia normalizes on the fly).
  const canonical = candidates.find((f) => f.normalizedName === norm)
  const legacy = candidates.find((f) => f.normalizedName === null && normalizeFolderName(f.name) === norm)
  const match = canonical ?? legacy

  if (match) {
    const existingLocation = await prisma.folderStorageLocation.findFirst({
      where: { folderId: match.id, connectedAccountId: ctx.accountId },
    })
    if (existingLocation === null) {
      return attachPhysicalLocation(ctx, match.id, physical)
    }
    // This physical folder is a same-account duplicate sibling of an already
    // mapped virtual folder → deterministic ` (n)` collision suffix.
    return resolveCollision(ctx, virtualParentId, physical, norm)
  }

  // ── Brand-new physical folder ────────────────────────────────────────────
  // Degenerate (whitespace-only) names cannot satisfy the unique constraint —
  // store a NULL normalizedName so MySQL NULL semantics allow the row (§13).
  return createVirtualWithLocation(ctx, virtualParentId, physical, norm === '' ? null : norm)
}

/** Attach a location row to an existing virtual folder (P2002 → re-read). */
async function attachPhysicalLocation(
  ctx: SyncRunContext,
  folderId: string,
  physical: DiscoveredPhysicalFolder,
): Promise<string> {
  try {
    await prisma.folderStorageLocation.create({
      data: {
        folderId,
        connectedAccountId: ctx.accountId,
        provider: ctx.provider,
        providerFolderId: physical.providerFolderId,
        lastSeenSyncRunId: ctx.runId,
      },
    })
    ctx.stats.mappingsCreated += 1
    logEvent(ctx, 'sync.folder.mapping_created', { folderId })
    return folderId
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // A concurrent run attached a physical folder to the same slot first.
    const winner = await prisma.folderStorageLocation.findFirst({
      where: { folderId, connectedAccountId: ctx.accountId },
      select: { id: true },
    })
    if (!winner) throw error
    await stampLocationSeen(winner.id, ctx.runId)
    ctx.stats.mappingsReused += 1
    return folderId
  }
}

/**
 * Same-account duplicate physical folder names under one virtual parent:
 * deterministically allocate ` (2)`, ` (3)`, ... on the NORMALIZED name so
 * repeat scans keep stable ids (§36). The physical folder is NOT renamed.
 */
async function resolveCollision(
  ctx: SyncRunContext,
  virtualParentId: string | null,
  physical: DiscoveredPhysicalFolder,
  norm: string,
): Promise<string> {
  ctx.stats.collisionsDetected += 1

  let n = 2
  for (;;) {
    const suffixNorm = `${norm} (${n})`
    const clash = await prisma.folder.findFirst({
      where: { userId: ctx.userId, parentId: virtualParentId, normalizedName: suffixNorm, deletedAt: null },
      select: { id: true },
    })
    if (clash === null) {
      return createVirtualWithLocation(ctx, virtualParentId, { ...physical, name: `${physical.name} (${n})` }, suffixNorm)
    }
    n += 1
  }
}

/**
 * Create the virtual folder + location inside ONE transaction. §12: on a
 * P2002 (a concurrent run created the same virtual path first), re-read the
 * winner and attach the location to that folder.
 */
async function createVirtualWithLocation(
  ctx: SyncRunContext,
  virtualParentId: string | null,
  physical: DiscoveredPhysicalFolder,
  normalizedName: string | null,
): Promise<string> {
  try {
    const virtual = await prisma.$transaction(async (tx) => {
      const folder = await tx.folder.create({
        data: {
          userId: ctx.userId,
          parentId: virtualParentId,
          name: physical.name,
          normalizedName,
          origin: 'sync',
        },
        select: { id: true },
      })
      await tx.folderStorageLocation.create({
        data: {
          folderId: folder.id,
          connectedAccountId: ctx.accountId,
          provider: ctx.provider,
          providerFolderId: physical.providerFolderId,
          lastSeenSyncRunId: ctx.runId,
        },
      })
      return folder
    })
    ctx.stats.foldersCreated += 1
    ctx.stats.mappingsCreated += 1
    logEvent(ctx, 'sync.folder.virtual_created', { folderId: virtual.id, name: physical.name })
    return virtual.id
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // Another run created the same (userId, parentId, normalizedName) first —
    // re-read it and attach our location.
    const winner = await prisma.folder.findFirst({
      where: { userId: ctx.userId, parentId: virtualParentId, normalizedName, deletedAt: null },
      select: { id: true },
    })
    if (!winner) throw error
    return attachPhysicalLocation(ctx, winner.id, physical)
  }
}

/**
 * Safe single-location in-place rename/move (§28). Only called when the
 * virtual folder is sync-originated and has exactly one location; returns true
 * when the update applied, false when it would violate virtual uniqueness (the
 * caller then detaches instead).
 */
async function tryInPlaceRename(
  ctx: SyncRunContext,
  folder: { id: string; name: string },
  virtualParentId: string | null,
  physical: DiscoveredPhysicalFolder,
): Promise<boolean> {
  const newNorm = normalizeFolderName(physical.name)
  if (newNorm === '') return false // degenerate name — detach

  try {
    await prisma.folder.update({
      where: { id: folder.id },
      data: { name: physical.name, normalizedName: newNorm, parentId: virtualParentId ?? null },
    })
    return true
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return false // collides with an existing sibling — fall back to detach
  }
}