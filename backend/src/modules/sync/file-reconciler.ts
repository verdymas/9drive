import { prisma } from '../../config/prisma.js'
import type { SyncRunContext } from './folder-reconciler.js'

/**
 * File reconciliation (spec §14-16, §30-32, §67).
 *
 * Identity is `(connectedAccountId, providerFileId)` ONLY — never filename.
 * Each page of provider files is resolved against the DB in one batch:
 *
 *   - not found       → create (`status: 'active'`, lastSeen = run)
 *   - found, changed  → update name/mimeType/sizeBytes; if the physical
 *                       provider parent changed, follow the file to the
 *                       resolved virtual parent (folderId) — no duplicate
 *                       File (§30). Restore soft-deleted rows.
 *   - found, same     → stamp lastSeen and keep (no write)
 *
 * The same provider file may appear in multiple physical folders (S3 keys
 * under a prefix vs. the prefix tree); the provider parent tracks the resolved
 * virtual folder only. Cross-account same-name files are separate File rows —
 * the frontend keys by `file.id`, duplicates render fine (§67-8).
 */

export type DiscoveredPhysicalFile = {
  providerFileId: string
  name: string
  mimeType: string
  sizeBytes: bigint
  /** Provider folder id where the file physically lives (Drive parent / S3 prefix). */
  providerParentId: string | null
}

export type FileReconcileContext = {
  userId: string
  accountId: string
  provider: string
  runId: string
  /** Stats shared with the folder reconciler's SyncRunContext. */
  stats: {
    filesDiscovered: number
    filesCreated: number
    filesUpdated: number
    filesMoved: number
  }
}

/** Reconcile one page of files against the DB. Mutates `ctx.stats`. */
export async function reconcileFilePage(
  ctx: FileReconcileContext,
  resolvedVirtualParentId: string | null,
  physicalFiles: DiscoveredPhysicalFile[],
): Promise<void> {
  if (physicalFiles.length === 0) return
  ctx.stats.filesDiscovered += physicalFiles.length

  const ids = physicalFiles.map((f) => f.providerFileId)
  const existing = await prisma.file.findMany({
    where: {
      userId: ctx.userId,
      connectedAccountId: ctx.accountId,
      providerFileId: { in: ids },
    },
    select: {
      id: true,
      providerFileId: true,
      name: true,
      mimeType: true,
      sizeBytes: true,
      folderId: true,
      status: true,
      deletedAt: true,
      lastSeenSyncRunId: true,
    },
  })
  const byProviderId = new Map(existing.map((f) => [f.providerFileId, f]))

  for (const physical of physicalFiles) {
    const row = byProviderId.get(physical.providerFileId)

    if (!row) {
      await prisma.file.create({
        data: {
          userId: ctx.userId,
          connectedAccountId: ctx.accountId,
          provider: ctx.provider,
          providerFileId: physical.providerFileId,
          name: physical.name,
          mimeType: physical.mimeType,
          sizeBytes: physical.sizeBytes,
          status: 'active',
          folderId: resolvedVirtualParentId,
          lastSeenSyncRunId: ctx.runId,
        },
      })
      ctx.stats.filesCreated += 1
      continue
    }

    const moved = row.folderId !== resolvedVirtualParentId
    const metaChanged =
      row.name !== physical.name ||
      row.mimeType !== physical.mimeType ||
      row.sizeBytes !== physical.sizeBytes ||
      row.status !== 'active' ||
      row.deletedAt !== null

    if (moved || metaChanged) {
      await prisma.file.update({
        where: { id: row.id },
        data: {
          name: physical.name,
          mimeType: physical.mimeType,
          sizeBytes: physical.sizeBytes,
          status: 'active',
          deletedAt: null,
          folderId: resolvedVirtualParentId,
          lastSeenSyncRunId: ctx.runId,
        },
      })
      if (moved) ctx.stats.filesMoved += 1
      else ctx.stats.filesUpdated += 1
      continue
    }

    // No change — stamp seen (only if not stamped by this run already).
    if (row.lastSeenSyncRunId !== ctx.runId) {
      await prisma.file.update({
        where: { id: row.id },
        data: { lastSeenSyncRunId: ctx.runId },
      })
    }
  }
}