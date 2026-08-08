import { prisma } from '../../config/prisma.js'
import type { SyncRunContext } from './folder-reconciler.js'
import type { SyncStats } from './sync-run.service.js'

/**
 * Missing reconciliation — spec §21-22, §32, §41.
 *
 * ONLY ever called after a SUCCESSFUL COMPLETE scan of an account (never from
 * a failed or cancelled run — §22/§60). Account-scoped: the query is confined
 * to this connectedAccountId, so Sync A can never touch B's rows.
 *
 *   - Files:  soft-delete active files whose `lastSeenSyncRunId` is NOT the
 *             current run (and not NULL — legacy rows are never treated as
 *             missing on the first post-upgrade run, §21).
 *   - Locations: delete the mapping row itself (re-creatable by the next scan
 *             if the physical folder reappears). The VIRTUAL FOLDER always
 *             survives; other accounts' mappings are untouched (§23).
 *
 * Both passes are in ONE transaction so a failed cleanup never leaves files
 * half-missing (a location without its files, or vice versa).
 */
export async function reconcileMissing(
  ctx: SyncRunContext,
  stats: SyncStats,
): Promise<{ filesMissing: number; mappingsMissing: number }> {
  return prisma.$transaction(async (tx) => {
    const files = await tx.file.updateMany({
      where: {
        userId: ctx.userId,
        connectedAccountId: ctx.accountId,
        status: 'active',
        // Exclude both the current run's stamps AND legacy NULL rows.
        lastSeenSyncRunId: { not: null, notIn: [ctx.runId] },
      },
      data: { status: 'deleted', deletedAt: new Date() },
    })

    const mappings = await tx.folderStorageLocation.findMany({
      // Exclude both the current run's stamps AND legacy NULL rows.
      where: { connectedAccountId: ctx.accountId, lastSeenSyncRunId: { not: null, notIn: [ctx.runId] } },
      select: { id: true },
    })
    const deletedMappings = await tx.folderStorageLocation.deleteMany({
      where: { id: { in: mappings.map((m) => m.id) } },
    })

    stats.filesMissing += files.count
    stats.mappingsMissing += deletedMappings.count
    return { filesMissing: files.count, mappingsMissing: deletedMappings.count }
  })
}