import type { ConnectedAccount, TelegramStorageConfig } from '@prisma/client'
import type { TelegramClient } from 'teleproto'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { syncTelegramUsage } from './telegram-usage.service.js'
import {
  buildTelegramRemoteId,
  classifyTelegramError,
  getTelegramConfig,
  isStorageChannelCandidate,
  normalizeChannelId,
  parseTelegramRemoteId,
  resolveConfiguredChannel,
  withTelegramClient,
} from './telegram.service.js'
import { ingestTelegramDocument } from './telegram-ingest.service.js'
import { applyOutcomeStats, classifyTelegramDocument } from './telegram-sync-classification.js'
import { emptyTelegramSyncStats } from './telegram-sync-types.js'
import { fetchMissingPageCaptions, fetchPageWithRetries } from './telegram-sync-telegram.js'
import { persistPageOutcome } from './telegram-sync-persistence.js'
import { reconcileMissingTelegramFiles } from './telegram-sync-reconciliation.js'
import type {
  FileByProviderFileId,
  TelegramDocument,
  TelegramSyncOptions,
  TelegramSyncRunStats,
  TelegramSyncRunSummary,
  TelegramSyncStatus,
} from './telegram-sync-types.js'

export {
  TELEGRAM_SYNC_STATUSES,
  TELEGRAM_SYNC_ISSUE_KINDS,
} from './telegram-sync-types.js'
export type {
  TelegramSyncStatus,
  TelegramSyncIssueKind,
  TelegramSyncRunStats,
  TelegramSyncRunSummary,
  TelegramSyncOptions,
  TelegramDocument,
  TelegramFileRow,
  DocumentOutcome,
} from './telegram-sync-types.js'

/**
 * Telegram Synchronization / Reconciliation.
 *
 * Scans the configured Telegram storage channel and reconciles each
 * document against the 9Drive DB. The DB is the source of truth for
 * the logical filesystem — the channel is a mirror — so the sync
 * NEVER deletes data. It only writes reconciliation issues that the
 * user reviews via the HTTP surface.
 *
 * Lifecycle (one run per account):
 *   1. Atomic lock on `TelegramSyncState.status = 'syncing'`.
 *   2. Create a `TelegramSyncRun` row.
 *   3. Read `last_message_id` from the state row; resume there.
 *   4. Paginate `client.iterMessages(channel, { min_id, limit })`
 *      with bounded concurrency and FloodWait respect.
 *   5. For each document: classify (matched / imported / missing /
 *      conflict). Persist issues in batch. Accumulate stats.
 *   6. Update `TelegramSyncState.last_message_id = maxSeen`,
 *      `last_scan_at = now()`, `status = up_to_date | changes_detected
 *      | needs_attention | sync_failed`.
 *   7. Complete the `TelegramSyncRun` row.
 *
 * The 9Drive DB remains authoritative. Telegram deletion does not
 * delete 9Drive rows; Telegram messages with no DB row become
 * `ORPHAN_REMOTE_FILE` candidates for import; DB rows with no
 * Telegram message become `REMOTE_FILE_MISSING` candidates. The user
 * resolves issues manually (spec §13).
 *
 * Opt-in: with TELEGRAM_SYNC_TRASH_MISSING=true, a row that has been
 * flagged missing on a *previous* full scan is moved to Trash (soft-
 * delete, recoverable). Default off to preserve the spec rule; pass
 * 2 only soft-deletes, never hard-deletes, never touches the Telegram
 * message itself.
 */

/**
 * Run a Telegram synchronization pass for one account. Idempotent
 * against overlapping calls via the `TelegramSyncState.status`
 * single-flight guard. Returns the run summary on success; throws an
 * AppError for lock conflicts (`SYNC_ALREADY_RUNNING`) and
 * connection / API failures (`TELEGRAM_NETWORK`,
 * `TELEGRAM_CHANNEL_UNAVAILABLE`, etc.).
 */
export async function runTelegramSync(
  userId: string,
  accountId: string,
  options: TelegramSyncOptions = {},
): Promise<TelegramSyncRunSummary> {
  const account = await prisma.connectedAccount.findFirst({
    where: { id: accountId, userId, provider: 'telegram' },
    select: { id: true, userId: true, provider: true, status: true },
  })
  if (!account) {
    throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The Telegram storage account does not exist.', 404)
  }

  // Reauth-required accounts cannot sync — Telegram API access is gone.
  if (account.status === 'reauth_required') {
    throw new AppError('GOOGLE_REAUTH_REQUIRED', 'This Telegram account needs to be reconnected before it can be synchronized.', 401)
  }

  // Atomic lock: refuse to overwrite a `syncing` state row. Spec §20.
  const state = options.skipLock
    ? { previousStatus: 'never_synced', lastMessageId: null, skipRelease: true }
    : await acquireSyncLock(accountId, userId)
  if (!state) {
    throw new AppError('SYNC_ALREADY_RUNNING', 'A Telegram synchronization is already running for this account.', 409)
  }

  // Create the run row BEFORE any work so the UI can poll it.
  const run = await prisma.telegramSyncRun.create({
    data: {
      userId,
      connectedAccountId: accountId,
      status: 'running',
    },
    select: { id: true, startedAt: true },
  })

  const startedAt = run.startedAt
  const stats = emptyTelegramSyncStats()

  try {
    const config = await getTelegramConfig(accountId, userId)
    if (!config.channelId) {
      throw new AppError('TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED', 'No Telegram storage channel is configured for this account.', 409)
    }

    const cursor = options.full ? null : state.lastMessageId
    const result = await scanChannel({
      userId,
      accountId,
      config,
      resumeFromMessageId: cursor,
      stats,
      trigger: options.trigger ?? 'manual',
      runId: run.id,
    })

    const finishedAt = new Date()
    const hasIssues = result.missingCount > 0 || result.conflictCount > 0
    const hasOrphans = result.importedCount > 0
    const finalStatus: TelegramSyncStatus = hasIssues ? 'needs_attention' : hasOrphans ? 'changes_detected' : 'up_to_date'

    await prisma.$transaction([
      prisma.telegramSyncRun.update({
        where: { id: run.id },
        data: {
          scannedCount: result.scannedCount,
          matchedCount: result.matchedCount,
          importedCount: result.importedCount,
          missingCount: result.missingCount,
          orphanCount: result.orphanCount,
          conflictCount: result.conflictCount,
          errorCount: result.errorCount,
          status: 'completed',
          finishedAt,
        },
      }),
      prisma.telegramSyncState.update({
        where: { connectedAccountId: accountId },
        data: {
          status: finalStatus,
          lastMessageId: result.maxSeenMessageId ?? state.lastMessageId ?? null,
          lastScanAt: finishedAt,
          // Stamp a full-scan completion only on success + full request
          // so a failed or cancelled run does not defer the next full scan.
          ...(options.full ? { lastFullScanAt: finishedAt } : {}),
          errorCode: null,
          errorMessage: null,
        },
      }),
    ])

    await syncTelegramUsage(accountId).catch(() => undefined)
    await createAuditLog(userId, 'telegram.sync', 'connected_account', accountId, {
      runId: run.id,
      trigger: options.trigger ?? 'manual',
      ...result,
    })

    return {
      id: run.id,
      status: 'completed',
      startedAt,
      finishedAt,
      errorCode: null,
      errorMessage: null,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      ...result,
    }
  } catch (error) {
    const classified = error instanceof AppError ? error : classifyTelegramError(error)
    console.error('[telegram-sync] run failed', JSON.stringify({
      event: 'telegram.sync.run_failed',
      runId: run.id,
      errorCode: classified.code,
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    }))
    const finishedAt = new Date()

    // Persist the failure on the run + state. Spec §25 — transient errors
    // must NOT cause existing files to be marked missing; we only update
    // the bookkeeping rows.
    await prisma.$transaction([
      prisma.telegramSyncRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt,
          errorCode: classified.code,
          errorMessage: classified.message.slice(0, 1000),
          scannedCount: stats.scannedCount,
          matchedCount: stats.matchedCount,
          importedCount: stats.importedCount,
          missingCount: stats.missingCount,
          orphanCount: stats.orphanCount,
          conflictCount: stats.conflictCount,
          errorCount: stats.errorCount,
        },
      }),
      prisma.telegramSyncState.update({
        where: { connectedAccountId: accountId },
        data: {
          status: 'sync_failed',
          lastScanAt: finishedAt,
          errorCode: classified.code,
          errorMessage: classified.message.slice(0, 1000),
        },
      }),
    ])

    await createAuditLog(userId, 'telegram.sync_failed', 'connected_account', accountId, {
      runId: run.id,
      errorCode: classified.code,
      errorMessage: classified.message.slice(0, 200),
    })

    if (classified.code === 'TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED' || classified.code === 'TELEGRAM_CHANNEL_UNAVAILABLE') {
      // No channel → no point retrying. Surface as-is.
      throw classified
    }
    if (error instanceof AppError) throw classified
    // Unknown failure — wrap it.
    throw new AppError(classified.code, classified.message, classified.status)
  } finally {
    // Always release the single-flight guard, even on throw. Only
    // release if WE acquired it — the throw may have originated from
    // the lock acquisition itself (state === null).
    if (state && !('skipRelease' in state)) {
      await prisma.telegramSyncState.updateMany({
        where: { connectedAccountId: accountId, status: 'syncing' },
        data: { status: state.previousStatus },
      }).catch(() => undefined)
    }
  }
}

async function acquireSyncLock(accountId: string, userId: string) {
  // Upsert the state row and atomically transition from any
  // non-syncing status to syncing. The transition guard is the WHERE
  // clause on `status != 'syncing'`; if another worker already holds
  // the lock, zero rows are affected and we return null.
  const ensured = await prisma.telegramSyncState.upsert({
    where: { connectedAccountId: accountId },
    create: {
      userId,
      connectedAccountId: accountId,
      status: 'never_synced',
    },
    update: {},
    select: { status: true, lastMessageId: true },
  })

  if (ensured.status === 'syncing') return null

  const transition = await prisma.telegramSyncState.updateMany({
    where: { connectedAccountId: accountId, status: { not: 'syncing' } },
    data: { status: 'syncing' },
  })
  if (transition.count === 0) return null

  return { previousStatus: ensured.status, lastMessageId: ensured.lastMessageId }
}

type ScanResult = TelegramSyncRunStats & { maxSeenMessageId: bigint | null }

async function scanChannel(input: {
  userId: string
  accountId: string
  config: TelegramStorageConfig & { connectedAccount: ConnectedAccount }
  resumeFromMessageId: bigint | null
  stats: TelegramSyncRunStats
  trigger: string
  runId: string
}): Promise<ScanResult> {
  const { userId, accountId, config, resumeFromMessageId, stats } = input
  const pageSize = env.TELEGRAM_SYNC_PAGE_SIZE
  const maxRetries = env.TELEGRAM_SYNC_FLOOD_WAIT_RETRIES

  let maxSeen: bigint | null = null

  await withTelegramClient(config, async (client) => {
    const channel = await resolveConfiguredChannel(client, config.channelId)
    if (!isStorageChannelCandidate(channel)) {
      throw new AppError('TELEGRAM_CHANNEL_UNAVAILABLE', 'The configured Telegram storage channel is not a usable private channel.', 410)
    }
    const channelId = normalizeChannelId((channel as { id?: unknown }).id ?? config.channelId)

    // Paginate by message id (Telegram exposes monotonically increasing
    // message ids per channel). Spec §22 — large channel support.
    let minId = resumeFromMessageId ? Number(resumeFromMessageId) : 0
    let pageCount = 0
    let stop = false

    while (!stop) {
      const page = await fetchPageWithRetries(client, channel, { minId, limit: pageSize }, maxRetries)
      if (page.length === 0) break
      pageCount += 1

      const documents: TelegramDocument[] = page.map((rawDocument) => ({
        remoteId: buildTelegramRemoteId(channelId, rawDocument.messageId),
        channelId,
        messageId: rawDocument.messageId,
        name: rawDocument.name,
        size: rawDocument.size,
        mimeType: rawDocument.mimeType,
        caption: rawDocument.caption,
      }))

      // Page-scoped DB lookup: only the identifiers in THIS page are queried,
      // so peak retained state scales with page size rather than total
      // indexed files. Both active and soft-deleted rows participate in
      // reconciliation: a soft-deleted row whose Telegram message is still
      // there must not be re-imported. Pass 2 (missing detection) only flags
      // active rows, matching the pre-optimization diff.
      const pageRemoteIds = documents.map((d) => d.remoteId)
      const pageRows = await prisma.file.findMany({
        where: {
          userId,
          connectedAccountId: accountId,
          provider: 'telegram',
          status: { in: ['active', 'deleted'] },
          providerFileId: { in: pageRemoteIds },
        },
        select: { id: true, providerFileId: true, name: true, folderId: true, telegramStableId: true, mimeType: true, sizeBytes: true, status: true, encryptedMetadata: true },
      })
      const fileByProviderFileId: FileByProviderFileId = new Map()
      for (const row of pageRows) {
        fileByProviderFileId.set(row.providerFileId, row)
      }

      // Phase 3: Bounded caption fetching for orphan documents whose caption
      // was not included in the page metadata. Uses TELEGRAM_SYNC_CAPTION_CONCURRENCY.
      const fetchedCaptions = await fetchMissingPageCaptions(
        client,
        channel,
        documents,
        fileByProviderFileId,
      )

      const pageSeenFileIds: string[] = []

      for (const document of documents) {
        try {
          const { outcome, fileIdToStamp } = await classifyTelegramDocument({
            document,
            existing: fileByProviderFileId.get(document.remoteId) ?? null,
            fetchedCaption: fetchedCaptions.get(document.remoteId) ?? null,
            ingest: (document, caption) => ingestTelegramDocument(userId, accountId, {
              remoteId: document.remoteId,
              name: document.name,
              size: document.size,
              mimeType: document.mimeType,
            }, caption),
            findPlacedFile: () => prisma.file.findFirst({
              where: { userId, provider: 'telegram', providerFileId: document.remoteId },
              select: { id: true, folderId: true },
            }),
          })

          if (fileIdToStamp) {
            pageSeenFileIds.push(fileIdToStamp)
          }

          applyOutcomeStats(stats, outcome)
          await persistPageOutcome({ outcome, runId: input.runId, userId, accountId, document })
          if (document.messageId > (maxSeen ? Number(maxSeen) : 0)) {
            maxSeen = BigInt(document.messageId)
          }
        } catch (error) {
          stats.errorCount += 1
          console.error('[telegram-sync] per-document error', JSON.stringify({
            event: 'telegram.sync.document_error',
            runId: input.runId,
            accountId,
            remoteId: document.remoteId,
            errorCode: error instanceof AppError ? error.code : 'TELEGRAM_UNKNOWN_ERROR',
            errorMessage: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          }))
          await prisma.telegramSyncRun.update({
            where: { id: input.runId },
            data: { errorCount: stats.errorCount },
          }).catch(() => undefined)
        }
      }

      // Phase 3: Batch update lastSeenSyncRunId for all observed files in this page
      const uniquePageSeenIds = Array.from(new Set(pageSeenFileIds))
      if (uniquePageSeenIds.length > 0) {
        await prisma.file.updateMany({
          where: { id: { in: uniquePageSeenIds }, userId },
          data: { lastSeenSyncRunId: input.runId },
        })
      }

      // Pages arrive in ascending id order (`reverse: true`), so the last
      // item carries the highest id in the page — advance the cursor to it.
      const lastMessageId = page[page.length - 1].messageId
      if (lastMessageId <= minId) break // safety: no progress
      minId = lastMessageId
      if (page.length < pageSize) stop = true // short page = end of channel
    }

    if (resumeFromMessageId === null) {
      await reconcileMissingTelegramFiles({ userId, accountId, runId: input.runId, stats })
    }
  })

  return { ...stats, maxSeenMessageId: maxSeen }
}

/**
 * Resolve a Telegram document summary (the part of `telegram.service`
 * that yields `remoteId`, `name`, `size`, `mimeType`) plus its channel id
 * — re-exported so the queue / worker tests can mock it without
 * spinning up a real client.
 */
export type ScannedTelegramDocument = TelegramDocument
export { parseTelegramRemoteId, buildTelegramRemoteId }
