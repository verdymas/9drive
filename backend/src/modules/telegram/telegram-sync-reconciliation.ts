import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import { createIssueIfOpenNotExists } from './telegram-sync-persistence.js'
import type { TelegramSyncRunStats } from './telegram-sync-types.js'

export type ReconcileMissingTelegramFilesInput = {
  userId: string
  accountId: string
  runId: string
  stats: TelegramSyncRunStats
}

/** Reconcile active Telegram files that were not observed by a full scan. */
export async function reconcileMissingTelegramFiles(input: ReconcileMissingTelegramFilesInput): Promise<void> {
  const { userId, accountId, runId, stats } = input
  const trashMissing = env.TELEGRAM_SYNC_TRASH_MISSING && stats.errorCount === 0
  const unseenRows = await prisma.file.findMany({
    where: {
      userId,
      connectedAccountId: accountId,
      provider: 'telegram',
      status: 'active',
      OR: [
        { lastSeenSyncRunId: null },
        { lastSeenSyncRunId: { not: runId } },
      ],
    },
    select: { id: true, name: true, status: true, lastSeenSyncRunId: true },
  })

  for (const row of unseenRows) {
    // Defend against mocks/edge cases where the database filter was ignored.
    if (row.status && row.status !== 'active') continue
    if (row.lastSeenSyncRunId === runId) continue
    stats.missingCount += 1
    stats.scannedCount += 1
    await createIssueIfOpenNotExists({
      userId,
      runId,
      connectedAccountId: accountId,
      kind: 'REMOTE_FILE_MISSING',
      fileId: row.id,
      metadata: { name: row.name },
    })

    if (trashMissing) {
      await prisma.file.update({
        where: { id: row.id, userId },
        data: { status: 'deleted', deletedAt: new Date() },
      })
      stats.trashedCount += 1
      await createAuditLog(userId, 'telegram.sync.trash_missing', 'file', row.id, { name: row.name })
    }
  }
}
