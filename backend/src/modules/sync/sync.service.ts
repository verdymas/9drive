import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { createSyncRun, completeSyncRun, cancelSyncRun, failSyncRun, emptyStats, SYNC_RUN_STATUS, type SyncStats } from './sync-run.service.js'
import { resolveVirtualFolder, type SyncRunContext } from './folder-reconciler.js'
import { reconcileFilePage } from './file-reconciler.js'
import { reconcileMissing } from './missing-reconciler.js'
import { scanDriveFolders } from './sync-drive.js'
import { scanS3Folders } from './sync-s3.js'
import { mapWithConcurrency } from './map-with-concurrency.js'
import { syncGoogleQuota, ensureGoogleAppFolder } from '../google/google.service.js'
import { syncS3Quota } from '../s3/s3.service.js'
import { runTelegramSync } from '../telegram/telegram-sync.service.js'
import { syncTelegramUsage } from '../telegram/telegram-usage.service.js'
import type { ConnectedAccount } from '@prisma/client'

/**
 * Sync orchestration — Provider → Virtual reconciliation.
 *
 * runAccountSync drives one account: create a SyncRun, scan the physical tree
 * (Drive BFS or S3 prefix walk), reconcile folders/files page by page into the
 * virtual filesystem, and ONLY after a complete successful scan run the
 * account-scoped missing reconciler (§22). Failed/cancelled scans NEVER clean
 * up and never stamp the run completed.
 *
 * runSyncAll fans out accounts with bounded concurrency; one account's failure
 * never rolls back another's valid result (§19).
 */

export type AccountSyncResult = {
  accountId: string
  provider: string
  status: 'completed' | 'failed' | 'cancelled'
  runId: string
  stats: SyncStats
  errorCode?: string
  errorMessage?: string
}

export class SyncCancelledError extends Error {
  constructor() {
    super('Sync cancelled')
    this.name = 'SyncCancelledError'
  }
}

const activeCancellations = new Set<string>()

/** Mark an account's in-flight run for cancellation (checked between queue items). */
export function cancelAccountSync(accountId: string): void {
  activeCancellations.add(accountId)
}

function isCancelled(accountId: string): () => boolean {
  return () => activeCancellations.has(accountId)
}

export async function runAccountSync(userId: string, connectedAccountId: string): Promise<AccountSyncResult> {
  const account = await prisma.connectedAccount.findFirst({
    where: { id: connectedAccountId, userId, status: { in: ['connected', 'reauth_required'] } },
    select: { id: true, provider: true, status: true },
  })
  if (!account) throw new AppError('SYNC_ACCOUNT_UNAVAILABLE', 'The storage account is not connected or does not belong to this user.', 404)

  // Broken auth blocks provider access: fail the run cleanly with the stable
  // reconnect error instead of hammering Google. NEVER runs missing cleanup —
  // an auth failure does not mean provider resources were deleted.
  if (account.status === 'reauth_required') {
    const run = await createSyncRun({ userId, connectedAccountId: account.id, provider: account.provider })
    const providerName = account.provider === 's3' ? 'S3' : account.provider === 'telegram' ? 'Telegram' : 'Google Drive'
    const message = `This ${providerName} account needs to be reconnected before it can be used.`
    await failSyncRun(run.id, 'GOOGLE_REAUTH_REQUIRED', message)
    return { accountId: account.id, provider: account.provider, status: 'failed', runId: run.id, stats: emptyStats(), errorCode: 'GOOGLE_REAUTH_REQUIRED', errorMessage: message }
  }

  const run = await createSyncRun({ userId, connectedAccountId: account.id, provider: account.provider })
  const stats = emptyStats()
  const ctx: SyncRunContext = { userId, accountId: account.id, provider: account.provider, runId: run.id, stats }
  const cancelled = isCancelled(account.id)

  try {
    if (account.provider === 'google_drive') {
      await runGoogleDriveScan(ctx, cancelled)
    } else if (account.provider === 's3') {
      await runS3Scan(ctx, cancelled)
    } else if (account.provider === 'telegram') {
      // Telegram is flat blob storage and the DB is the source of truth.
      // `runTelegramSync` does three things safely:
      //   1. Classifies every channel document by `providerFileId` against
      //      a snapshot of rows that existed before the run started.
      //   2. Fetches captions for orphans and routes them through the
      //      caption-driven ingest (`9drive:id` → `9drive:path` → recovery).
      //   3. Flags rows from the pre-run snapshot whose Telegram message
      //      disappeared (Pass 2). Newly-ingested orphans are NOT in the
      //      snapshot and therefore cannot be falsely flagged as missing.
      //
      // The legacy comment said "the missing-reconciler below must never
      // run against the channel history" — that referred to the global
      // `reconcileMissing(ctx, stats)` call further down in this function,
      // which uses `lastSeenSyncRunId` and is intentionally Telegram-blind
      // (this branch returns before that line is reached).
      const syncSummary = await runTelegramSync(userId, account.id, { full: !cancelled() })
      syncTelegramUsage(account.id).catch(() => undefined)
      // Map Telegram-shaped stats onto the Google/S3-shaped `SyncStats`
      // shape. The Telegram summary's per-strategy counters are surfaced
      // in `errorMessage` already via the audit log; the run-level
      // counters are still useful in the API response.
      const telegramStats: SyncStats = {
        ...emptyStats(),
        filesCreated: syncSummary.importedCount,
        // `filesMissing` carries files actually removed from the listing:
        // for Telegram that is `trashedCount` (rows soft-deleted by the
        // opt-in TELEGRAM_SYNC_TRASH_MISSING flag) — 0 by default to
        // preserve the spec's never-delete rule (telegram-drive.md:87).
        // The detected-but-pending count is exposed separately as
        // `filesFlagged` so the UI can tell the user something was found
        // without claiming a deletion happened.
        filesMissing: syncSummary.trashedCount,
        filesFlagged: syncSummary.missingCount,
        // collisionsDetected keeps the same name as the Google/S3
        // meaning; Telegram reports conflicts separately.
        collisionsDetected: syncSummary.conflictCount,
      }
      return {
        accountId: account.id,
        provider: account.provider,
        // The Telegram summary can be 'running' (e.g. mid-cancel) — only
        // surface terminal statuses to the API.
        status: syncSummary.status === 'running' ? 'cancelled' : syncSummary.status,
        runId: syncSummary.id,
        stats: telegramStats,
        errorCode: syncSummary.errorCode ?? undefined,
        errorMessage: syncSummary.errorMessage ?? undefined,
      }
    } else {
      await failSyncRun(run.id, 'SYNC_PROVIDER_UNSUPPORTED', `Sync is not implemented for provider "${account.provider}".`)
      return { accountId: account.id, provider: account.provider, status: 'failed', runId: run.id, stats }
    }

    // Cancellation check AFTER the scan completes — a cancellation that landed
    // during the tail must not trigger missing cleanup.
    if (activeCancellations.has(account.id)) {
      await cancelSyncRun(run.id)
      return { accountId: account.id, provider: account.provider, status: 'cancelled', runId: run.id, stats }
    }

    // Only a complete successful scan may reconcile missing (§22/§60).
    const missing = await reconcileMissing(ctx, stats)
    stats.filesMissing = missing.filesMissing
    stats.mappingsMissing = missing.mappingsMissing

    // Best-effort quota refresh — never fails the run.
    if (account.provider === 'google_drive') await syncGoogleQuota(account.id).catch(() => undefined)
    else await syncS3Quota(account.id).catch(() => undefined)

    await completeSyncRun(run.id, stats)
    return { accountId: account.id, provider: account.provider, status: 'completed', runId: run.id, stats }
  } catch (error) {
    if (error instanceof SyncCancelledError) {
      await cancelSyncRun(run.id)
      return { accountId: account.id, provider: account.provider, status: 'cancelled', runId: run.id, stats }
    }
    // Provider scan errors — run failed, NO missing cleanup.
    const code = errorCodeFor(error)
    await failSyncRun(run.id, code, error instanceof Error ? error.message : String(error))
    return { accountId: account.id, provider: account.provider, status: 'failed', runId: run.id, stats, errorCode: code, errorMessage: error instanceof Error ? error.message : String(error) }
  }
}

async function runGoogleDriveScan(ctx: SyncRunContext, cancelled: () => boolean): Promise<void> {
  // scanDriveFolders needs the full ConnectedAccount (tokens, providerConfigId).
  const fullAccount = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: ctx.accountId } }) as ConnectedAccount & { provider: 'google_drive' }

  await scanDriveFolders({
    account: fullAccount,
    maxDepth: env.SYNC_MAX_DEPTH,
    isCancelled: cancelled,
    stats: ctx.stats,
    onFolder: async (physical, virtualParentId, _depth) =>
      resolveVirtualFolder(ctx, virtualParentId, physical),
    onFilePage: async (virtualParentId, files) =>
      reconcileFilePage(
        { userId: ctx.userId, accountId: ctx.accountId, provider: ctx.provider, runId: ctx.runId, stats: ctx.stats },
        virtualParentId,
        files,
      ),
  })
}

async function runS3Scan(ctx: SyncRunContext, cancelled: () => boolean): Promise<void> {
  const s3Config = await prisma.s3StorageConfig.findFirst({ where: { connectedAccountId: ctx.accountId, status: 'active' }, select: { id: true, bucket: true, prefix: true } })
  if (!s3Config) throw new AppError('SYNC_ACCOUNT_UNAVAILABLE', 'The S3 account has no active configuration.', 404)

  await scanS3Folders({
    accountId: ctx.accountId,
    bucket: s3Config.bucket,
    userId: ctx.userId,
    rootPrefix: s3Config.prefix,
    isCancelled: cancelled,
    onFolder: async (physical, parentId) => resolveVirtualFolder(ctx, parentId, physical),
    onFilePage: async (virtualParentId, files) =>
      reconcileFilePage(
        { userId: ctx.userId, accountId: ctx.accountId, provider: ctx.provider, runId: ctx.runId, stats: ctx.stats },
        virtualParentId,
        files,
      ),
  })
}

function errorCodeFor(error: unknown): string {
  if (error instanceof AppError) return error.code
  return 'SYNC_RECONCILIATION_FAILED'
}

/** Sync ALL connected accounts of a user with bounded concurrency. */
export async function runSyncAll(userId: string): Promise<{
  results: AccountSyncResult[]
}> {
  // Reauth-required accounts are included so they surface in the results with
  // the reconnect error instead of being silently skipped.
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, status: { in: ['connected', 'reauth_required'] } },
    select: { id: true, provider: true },
  })

  const results = await mapWithConcurrency(accounts, env.SYNC_ACCOUNT_CONCURRENCY, (account) =>
    runAccountSyncSettled(userId, account.id),
  )

  return { results }
}

/** Per-account sync that never throws — failures are collected per account (§19). */
async function runAccountSyncSettled(userId: string, accountId: string): Promise<AccountSyncResult> {
  try {
    return await runAccountSync(userId, accountId)
  } catch (error) {
    return {
      accountId,
      provider: 'unknown',
      status: 'failed',
      runId: '',
      stats: emptyStats(),
      errorCode: errorCodeFor(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }
}