import { prisma } from '../../config/prisma.js'

/**
 * SyncRun lifecycle + run statistics.
 *
 * A SyncRun records one account-scoped Provider → Virtual reconciliation.
 * Statistics are scalar columns (mirroring the RemoteImport scalar style) so
 * the UI can merge runs without JSON parsing. `lastSeenSyncRunId` markers on
 * File / FolderStorageLocation point at the run that last saw the resource
 * during a successful complete scan — account-scoped missing reconciliation
 * compares against the current run's id.
 */

export type SyncStats = {
  foldersDiscovered: number
  filesDiscovered: number
  foldersCreated: number
  mappingsCreated: number
  mappingsReused: number
  mappingsDetached: number
  filesCreated: number
  filesUpdated: number
  filesMoved: number
  filesMissing: number
  mappingsMissing: number
  collisionsDetected: number
  // Telegram-only: rows whose Telegram message disappeared and that the
  // sync flagged for the user (vs. filesMissing which counts files actually
  // moved to Trash by the opt-in `TELEGRAM_SYNC_TRASH_MISSING` flag).
  filesFlagged: number
}

export const emptyStats = (): SyncStats => ({
  foldersDiscovered: 0,
  filesDiscovered: 0,
  foldersCreated: 0,
  mappingsCreated: 0,
  mappingsReused: 0,
  mappingsDetached: 0,
  filesCreated: 0,
  filesUpdated: 0,
  filesMoved: 0,
  filesMissing: 0,
  mappingsMissing: 0,
  collisionsDetected: 0,
  filesFlagged: 0,
})

/** Statuses are plain string constants — no enums in this schema. */
export const SYNC_RUN_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const

export type SyncRunCreateInput = {
  userId: string
  connectedAccountId: string
  provider: string
}

export async function createSyncRun(input: SyncRunCreateInput) {
  return prisma.syncRun.create({
    data: { ...input, status: SYNC_RUN_STATUS.RUNNING },
  })
}

export async function completeSyncRun(runId: string, stats: SyncStats) {
  return prisma.syncRun.update({
    where: { id: runId },
    data: { status: SYNC_RUN_STATUS.COMPLETED, completedAt: new Date(), ...stats },
  })
}

export async function failSyncRun(runId: string, errorCode: string, errorMessage: string) {
  return prisma.syncRun.update({
    where: { id: runId },
    data: { status: SYNC_RUN_STATUS.FAILED, completedAt: new Date(), errorCode, errorMessage },
  })
}

export async function cancelSyncRun(runId: string) {
  return prisma.syncRun.update({
    where: { id: runId },
    data: { status: SYNC_RUN_STATUS.CANCELLED, completedAt: new Date() },
  })
}

export async function listRecentSyncRuns(userId: string, limit = 10) {
  return prisma.syncRun.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 50),
  })
}