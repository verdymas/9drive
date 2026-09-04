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
import { inspectCaptionMeta } from './telegram-metadata-cache.js'
import { parseCaption } from './telegram-metadata.js'

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
 */

export const TELEGRAM_SYNC_STATUSES = [
  'never_synced',
  'syncing',
  'up_to_date',
  'changes_detected',
  'needs_attention',
  'sync_failed',
] as const

export type TelegramSyncStatus = (typeof TELEGRAM_SYNC_STATUSES)[number]

export const TELEGRAM_SYNC_ISSUE_KINDS = [
  'ORPHAN_REMOTE_FILE',
  'REMOTE_FILE_MISSING',
  'TELEGRAM_METADATA_MISMATCH',
  // Encrypted caption metadata that could not be read: wrong master key,
  // tampered payload, malformed, or an unsupported format version. Recorded
  // per document so the run continues (spec §36) — never guessed at, never
  // applied over DB state.
  'TELEGRAM_METADATA_UNREADABLE',
] as const

export type TelegramSyncIssueKind = (typeof TELEGRAM_SYNC_ISSUE_KINDS)[number]

export type TelegramSyncRunStats = {
  scannedCount: number
  matchedCount: number
  importedCount: number
  missingCount: number
  orphanCount: number
  conflictCount: number
  errorCount: number
  // Per-strategy breakdown for orphan Telegram documents that the
  // caption-driven ingest resolved. `recoveredCount` counts the
  // documents that landed in the "Recovered from Telegram" inbox
  // because the caption was missing or malformed.
  matchedByIdCount: number
  matchedByPathCount: number
  recoveredCount: number
}

export type TelegramSyncRunSummary = TelegramSyncRunStats & {
  id: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: Date
  finishedAt: Date | null
  errorCode: string | null
  errorMessage: string | null
  durationMs: number | null
}

const emptyStats = (): TelegramSyncRunStats => ({
  scannedCount: 0,
  matchedCount: 0,
  importedCount: 0,
  missingCount: 0,
  orphanCount: 0,
  conflictCount: 0,
  errorCount: 0,
  matchedByIdCount: 0,
  matchedByPathCount: 0,
  recoveredCount: 0,
})

export type TelegramSyncOptions = {
  /** Force a full rescan (ignore the persisted cursor). */
  full?: boolean
  /** Caller label — surfaces in audit logs and on the run row. */
  trigger?: 'manual' | 'auto' | 'recovery'
  /** Skip the per-account single-flight lock (used by tests). */
  skipLock?: boolean
}

/**
 * Per-document classification. The orchestrator emits one of these
 * for every Telegram document seen during a scan.
 *
 * `imported` carries the resolution strategy + virtual path so the
 * structured log + stats can attribute the match correctly. The
 * `fileId` field is filled in when the ingest created or matched a
 * row; `parentFolderId` is the folder the file was placed in (or
 * `null` at the user root).
 */
type DocumentOutcome =
  | { kind: 'matched' }
  | {
      kind: 'imported'
      telegramFileId: string
      strategy: '9drive_id' | '9drive_path' | 'physical' | 'recovered' | 'none'
      virtualPath: string | null
      fileId: string | null
      parentFolderId: string | null
      action: 'created' | 'updated' | 'matched' | 'inboxed' | 'skipped'
    }
  | { kind: 'missing'; telegramFileId: string; file: { id: string; name: string } }
  | { kind: 'conflict'; telegramFileId: string; reason: string; file: { id: string; name: string } }
  | { kind: 'unreadableMeta'; telegramFileId: string; errorCode: string; errorMessage: string }
  | { kind: 'error'; telegramFileId: string; errorCode: string; errorMessage: string }

type TelegramDocument = {
  remoteId: string
  channelId: string
  messageId: number
  name: string
  size: number
  mimeType: string | null
  /** Caption from the page fetch; `null` when the message carries none. */
  caption?: string | null
}

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
  const state = await acquireSyncLock(accountId, userId)
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
  const stats = emptyStats()

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
    if (state) {
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

    const seenFileIds = new Set<string>()
    const existingRows = await prisma.file.findMany({
      where: {
        userId,
        connectedAccountId: accountId,
        provider: 'telegram',
        // Both active and soft-deleted rows participate in reconciliation:
        // soft-deleted rows are still expected to map to a Telegram message,
        // so a `REMOTE_FILE_MISSING` issue on them is meaningful.
        status: { in: ['active', 'deleted'] },
      },
      select: { id: true, providerFileId: true, name: true, folderId: true, telegramStableId: true, mimeType: true, sizeBytes: true, status: true, encryptedMetadata: true },
    })
    const fileByProviderFileId = new Map<string, { id: string; name: string; mimeType: string; sizeBytes: bigint; folderId: string | null; telegramStableId: string | null; status: string; encryptedMetadata: string | null }>()
    for (const row of existingRows) {
      fileByProviderFileId.set(row.providerFileId, row)
    }

    // Paginate by message id (Telegram exposes monotonically increasing
    // message ids per channel). Spec §22 — large channel support.
    let minId = resumeFromMessageId ? Number(resumeFromMessageId) : 0
    let pageCount = 0
    let stop = false

    while (!stop) {
      const page = await fetchPageWithRetries(client, channel, { minId, limit: pageSize }, maxRetries)
      if (page.length === 0) break
      pageCount += 1

      for (const rawDocument of page) {
        const document: TelegramDocument = {
          remoteId: buildTelegramRemoteId(channelId, rawDocument.messageId),
          channelId,
          messageId: rawDocument.messageId,
          name: rawDocument.name,
          size: rawDocument.size,
          mimeType: rawDocument.mimeType,
          caption: rawDocument.caption,
        }
        seenFileIds.add(document.remoteId)

        try {
          const outcome = await classifyOne({
            userId,
            accountId,
            document,
            fileByProviderFileId,
            getCaption: (remoteId) => fetchCaptionForRemoteId(client, channel, remoteId),
          })
          applyOutcomeStats(stats, outcome)
          await recordOutcome({ outcome, runId: input.runId, userId, accountId, document })
          logSyncDocument({ runId: input.runId, accountId, outcome })
          if (rawDocument.messageId > (maxSeen ? Number(maxSeen) : 0)) {
            maxSeen = BigInt(rawDocument.messageId)
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

      // Pages arrive in ascending id order (`reverse: true`), so the last
      // item carries the highest id in the page — advance the cursor to it.
      const lastMessageId = page[page.length - 1].messageId
      if (lastMessageId <= minId) break // safety: no progress
      minId = lastMessageId
      if (page.length < pageSize) stop = true // short page = end of channel
    }

    // ── Pass 2: detect DB rows whose Telegram message disappeared ────
    // Existing rows not seen in this scan are flagged as
    // `REMOTE_FILE_MISSING`. Soft-deleted rows also participate: a
    // missing message on a trashed row is still a reconciliation
    // signal that the user can resolve.
    //
    // FULL SCANS ONLY. `existingRows` is an account-wide snapshot while
    // `seenFileIds` holds just this run's pages, so on an incremental run
    // every row below the cursor is "unseen" and would be falsely flagged.
    // Missing-detection needs a complete scan to be meaningful.
    if (resumeFromMessageId === null) {
      for (const row of existingRows) {
        if (seenFileIds.has(row.providerFileId)) continue
        // Soft-deleted rows that were manually removed in 9Drive should
        // NOT generate a missing-remote issue — the user explicitly
        // deleted them. We only flag active rows.
        if (row.status === 'deleted') continue
        stats.missingCount += 1
        stats.scannedCount += 1
        await prisma.telegramSyncIssue.create({
          data: {
            userId,
            runId: input.runId,
            connectedAccountId: accountId,
            kind: 'REMOTE_FILE_MISSING',
            fileId: row.id,
            metadata: { name: row.name },
          },
        })
      }
    }
  })

  return { ...stats, maxSeenMessageId: maxSeen }
}

async function classifyOne(input: {
  userId: string
  accountId: string
  document: TelegramDocument
  fileByProviderFileId: Map<string, { id: string; name: string; mimeType: string; sizeBytes: bigint; folderId: string | null; telegramStableId: string | null; status: string; encryptedMetadata: string | null }>
  /** Fetches the caption for a remote id; `null` when the fetch fails. */
  getCaption: (remoteId: string) => Promise<string | null>
}): Promise<DocumentOutcome> {
  const { document, fileByProviderFileId, getCaption } = input

  // Physical identity match by `providerFileId`.
  const existing = fileByProviderFileId.get(document.remoteId)
  if (existing) {
    // Metadata-mismatch detection: the DB row's filename, mimeType, or
    // size diverges from the Telegram document. The caption may carry
    // a 9drive:path override; that's handled by the ingest path, NOT
    // flagged as a sync conflict (it's an intentional rename).
    const sizeMatches = existing.sizeBytes === BigInt(document.size)
    // The DB column is never null (ingest defaults it), so normalize the
    // Telegram side the same way — otherwise a document Telegram reports
    // without a mime type conflicts on every single run.
    const mimeMatches = existing.mimeType === (document.mimeType ?? 'application/octet-stream')
    if (sizeMatches && mimeMatches) {
      // Encrypted caption metadata whose ciphertext differs from the cached
      // copy is reconciled by the ingest path. Reaching here with an
      // unreadable payload means the key is wrong or the caption was
      // tampered with — record it and move on (spec §36). The caption comes
      // from the page fetch, so this costs no extra Telegram round-trip.
      const failure = inspectCaptionMeta(document.caption ?? null, existing.encryptedMetadata)
      if (failure) {
        return { kind: 'unreadableMeta', telegramFileId: document.remoteId, errorCode: failure.code, errorMessage: failure.message }
      }
      return { kind: 'matched' }
    }
    return {
      kind: 'conflict',
      telegramFileId: document.remoteId,
      reason: sizeMatches ? 'mimeType mismatch' : 'size mismatch',
      file: { id: existing.id, name: existing.name },
    }
  }

  // Orphan: Telegram-only document. Fetch the caption and delegate to
  // the ingest path so a valid 9drive:id / 9drive:path caption routes
  // the file to its logical location instead of the recovery inbox.
  // The fetch is best-effort — a transient caption read failure falls
  // back to the legacy "no caption" behaviour (which still lands the
  // file in the recovery folder rather than dropping it).
  let caption: string | null = null
  try {
    caption = await getCaption(document.remoteId)
  } catch {
    caption = null
  }
  const parsed = parseCaption(caption)
  // The strategy is decided by what the caption carries. The ingest
  // service itself picks the resolution branch in the same order
  // (9drive:id → 9drive:path → physical remote → recovery).
  const strategy: '9drive_id' | '9drive_path' | 'physical' | 'recovered' | 'none' = parsed.stableId
    ? '9drive_id'
    : parsed.logicalPath
      ? '9drive_path'
      : 'none'

  try {
    const outcome = await ingestTelegramDocument(input.userId, input.accountId, {
      remoteId: document.remoteId,
      name: document.name,
      size: document.size,
      mimeType: document.mimeType,
    }, caption)

    // After the ingest, resolve the file + parent folder for the
    // structured log. The ingest path is idempotent; this lookup is
    // bounded by the (userId, providerFileId) index.
    const placed = await prisma.file.findFirst({
      where: { userId: input.userId, provider: 'telegram', providerFileId: document.remoteId },
      select: { id: true, folderId: true },
    })

    // Inbox routing is always a "recovered" outcome, regardless of
    // whether the caption had partial metadata (e.g. a `9drive:id` that
    // didn't match any row, or a `9drive:path` that was rejected as
    // unsafe). An `inboxed` result means the ingest path chose the
    // recovery folder as a last resort.
    const finalStrategy: '9drive_id' | '9drive_path' | 'physical' | 'recovered' | 'none' = outcome === 'inboxed'
      ? 'recovered'
      : strategy

    if (outcome === 'created' || outcome === 'inboxed') {
      return {
        kind: 'imported',
        telegramFileId: document.remoteId,
        strategy: finalStrategy,
        virtualPath: parsed.logicalPath,
        fileId: placed?.id ?? null,
        parentFolderId: placed?.folderId ?? null,
        action: outcome,
      }
    }
    return { kind: 'matched' }
  } catch (error) {
    return {
      kind: 'error',
      telegramFileId: document.remoteId,
      errorCode: error instanceof AppError ? error.code : 'TELEGRAM_UNKNOWN_ERROR',
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    }
  }
}

/**
 * Best-effort caption fetch for a single remote id. Returns `null` on
 * any failure (the ingest path then falls back to the recovery inbox
 * rather than dropping the document).
 */
async function fetchCaptionForRemoteId(
  client: TelegramClient,
  channel: unknown,
  remoteId: string,
): Promise<string | null> {
  try {
    const { messageId } = parseTelegramRemoteId(remoteId)
    const messages = await client.getMessages(channel as never, { ids: [messageId] })
    const message = messages[0] as { message?: string } | undefined
    return message?.message ?? null
  } catch {
    return null
  }
}

function applyOutcomeStats(stats: TelegramSyncRunStats, outcome: DocumentOutcome) {
  stats.scannedCount += 1
  switch (outcome.kind) {
    case 'matched':
      stats.matchedCount += 1
      break
    case 'imported':
      stats.importedCount += 1
      stats.orphanCount += 1
      if (outcome.strategy === '9drive_id') stats.matchedByIdCount += 1
      else if (outcome.strategy === '9drive_path') stats.matchedByPathCount += 1
      else if (outcome.strategy === 'recovered' || outcome.strategy === 'none') stats.recoveredCount += 1
      break
    case 'missing':
      stats.missingCount += 1
      break
    case 'conflict':
      stats.conflictCount += 1
      break
    case 'unreadableMeta':
      // Counted as a conflict so the run ends in `needs_attention` — the
      // user must resolve it (wrong key or tampered caption).
      stats.conflictCount += 1
      break
    case 'error':
      stats.errorCount += 1
      break
  }
}

/**
 * Emit one structured log line per document. Format mirrors the spec
 * (§23) so an operator can see at a glance how each Telegram document
 * was resolved (by id, by path, or by recovery fallback). Never logs
 * session strings, API hashes, OTPs, or other authentication secrets.
 */
function logSyncDocument(input: { runId: string; accountId: string; outcome: DocumentOutcome }): void {
  const { runId, accountId, outcome } = input
  if (outcome.kind === 'imported') {
    const pathResolution = outcome.virtualPath ? 'success' : 'failed'
    const reason = outcome.strategy === 'recovered'
      ? (outcome.virtualPath ? 'unresolvable_path' : 'missing_metadata')
      : outcome.strategy === 'none'
        ? 'missing_metadata'
        : undefined
    console.info('[telegram-sync]', JSON.stringify({
      event: 'telegram.sync.document',
      runId,
      accountId,
      remoteId: outcome.telegramFileId,
      matchStrategy: outcome.strategy,
      virtualPath: outcome.virtualPath,
      pathResolution,
      parentFolderId: outcome.parentFolderId,
      fileId: outcome.fileId,
      action: outcome.action,
      ...(reason ? { reason } : {}),
    }))
  }
  // matched/conflict/missing/error are already logged elsewhere or are
  // not user-actionable per document; omit to keep the log volume sane.
}

async function recordOutcome(input: {
  outcome: DocumentOutcome
  runId: string
  userId: string
  accountId: string
  document: TelegramDocument
}): Promise<void> {
  const { outcome, runId, userId, accountId, document } = input
  if (outcome.kind === 'conflict') {
    await prisma.telegramSyncIssue.create({
      data: {
        userId,
        runId,
        connectedAccountId: accountId,
        kind: 'TELEGRAM_METADATA_MISMATCH',
        telegramFileId: outcome.telegramFileId,
        fileId: outcome.file.id,
        metadata: { reason: outcome.reason, telegramName: document.name, dbName: outcome.file.name, size: document.size, mimeType: document.mimeType },
      },
    })
    return
  }
  if (outcome.kind === 'unreadableMeta') {
    // The payload itself is never stored (it is unreadable, possibly
    // attacker-controlled) and neither is any key material — only the code
    // and a truncated message the user can act on.
    await prisma.telegramSyncIssue.create({
      data: {
        userId,
        runId,
        connectedAccountId: accountId,
        kind: 'TELEGRAM_METADATA_UNREADABLE',
        telegramFileId: outcome.telegramFileId,
        metadata: { errorCode: outcome.errorCode, reason: outcome.errorMessage.slice(0, 200) },
      },
    })
    return
  }
  if (outcome.kind === 'error') {
    // Per-document errors are NOT promoted to a separate issue — they
    // bump the run's `errorCount` and surface in the run's
    // `errorMessage`. This avoids spamming the reconciliation log
    // with transient classification failures.
    return
  }
  // matched, imported, missing → no extra DB row (counted in stats only).
}

/**
 * Fetch a single page with FloodWait-aware retries. Each retry waits
 * the requested seconds, capped by the global retry budget.
 */
type RawTelegramDocument = {
  messageId: number
  name: string
  size: number
  mimeType: string | null
  /** Caption as it came back on the page fetch (no extra round-trip). */
  caption: string | null
}

async function fetchPageWithRetries(
  client: TelegramClient,
  channel: unknown,
  opts: { minId: number; limit: number },
  maxRetries: number,
): Promise<Array<RawTelegramDocument>> {
  let attempt = 0
  for (;;) {
    try {
      const out: Array<RawTelegramDocument> = []
      // teleproto's iterMessages yields one message at a time; we paginate
      // by stopping at `limit` messages with `id > minId`.
      //
      // The option key is `minId` (camelCase) — teleproto destructures it that
      // way, so a snake_case `min_id` is silently dropped and every page
      // restarts from the newest message. `reverse: true` iterates
      // oldest→newest, which makes `minId` a genuine forward cursor and makes
      // the last item of each page its HIGHEST id (see the cursor advance in
      // `scanChannel`).
      for await (const message of (client as unknown as {
        iterMessages: (entity: unknown, options: { minId?: number; limit?: number; reverse?: boolean }) => AsyncIterable<unknown>
      }).iterMessages(channel, { minId: opts.minId, limit: opts.limit, reverse: true })) {
        const document = coerceDocument(message)
        if (!document) continue
        out.push(document)
        if (out.length >= opts.limit) break
      }
      return out
    } catch (error) {
      const classified = classifyTelegramError(error)
      if (classified.code !== 'TELEGRAM_FLOOD_WAIT' || attempt >= maxRetries) {
        throw classified
      }
      // FloodWait: the AppError code carries no seconds; parse from
      // the message text as a last resort.
      const seconds = extractFloodWaitSeconds(error) ?? 5
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, Math.min(seconds * 1000, 60_000)))
    }
  }
}

function coerceDocument(message: unknown): RawTelegramDocument | null {
  const m = message as { id?: number | string; document?: { attributes?: Array<{ fileName?: string | null }>; size?: number; mimeType?: string | null }; message?: string }
  if (!m || typeof m !== 'object' || !m.document) return null
  if (typeof m.id !== 'number' && typeof m.id !== 'string') return null
  const id = typeof m.id === 'string' ? Number(m.id) : m.id
  if (!Number.isInteger(id) || id <= 0) return null
  const attributes = m.document.attributes ?? []
  const name = attributes.find((a) => a?.fileName)?.fileName
  return {
    messageId: id,
    name: name || `telegram-document-${id}`,
    size: m.document.size ?? 0,
    mimeType: m.document.mimeType ?? null,
    caption: typeof m.message === 'string' ? m.message : null,
  }
}

function extractFloodWaitSeconds(error: unknown): number | null {
  const raw = error as { seconds?: number | string; message?: string; errorMessage?: string }
  if (typeof raw.seconds === 'number') return raw.seconds
  if (typeof raw.seconds === 'string' && /^\d+$/.test(raw.seconds)) return Number(raw.seconds)
  const text = String(raw.message ?? raw.errorMessage ?? '')
  const match = /FLOOD_WAIT[_ ]?(\d+)/i.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * Resolve a Telegram document summary (the part of `telegram.service`
 * that yields `remoteId`, `name`, `size`, `mimeType`) plus its channel id
 * — re-exported so the queue / worker tests can mock it without
 * spinning up a real client.
 */
export type ScannedTelegramDocument = TelegramDocument
export { parseTelegramRemoteId, buildTelegramRemoteId }