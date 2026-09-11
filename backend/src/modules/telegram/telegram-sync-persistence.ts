import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import type { DocumentOutcome, TelegramDocument } from './telegram-sync-types.js'

export type PersistPageOutcomeInput = {
  outcome: DocumentOutcome
  runId: string
  userId: string
  accountId: string
  document: TelegramDocument
}

/** Persist the actionable part of one classification and emit its safe log. */
export async function persistPageOutcome(input: PersistPageOutcomeInput): Promise<void> {
  await recordOutcome(input)
  logSyncDocument({ runId: input.runId, accountId: input.accountId, outcome: input.outcome })
}

export function logSyncDocument(input: { runId: string; accountId: string; outcome: DocumentOutcome }): void {
  const { runId, accountId, outcome } = input
  if (outcome.kind !== 'imported') return

  const pathResolution = outcome.strategy === 'recovered' ? 'failed' : 'success'
  const reason = outcome.strategy === 'recovered' || outcome.strategy === 'none'
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

async function recordOutcome(input: PersistPageOutcomeInput): Promise<void> {
  const { outcome, runId, userId, accountId, document } = input
  if (outcome.kind === 'conflict') {
    await createIssueIfOpenNotExists({
      userId,
      runId,
      connectedAccountId: accountId,
      kind: 'TELEGRAM_METADATA_MISMATCH',
      telegramFileId: outcome.telegramFileId,
      fileId: outcome.file.id,
      metadata: { reason: outcome.reason, telegramName: document.name, dbName: outcome.file.name, size: document.size, mimeType: document.mimeType },
    })
    return
  }
  if (outcome.kind === 'unreadableMeta') {
    await createIssueIfOpenNotExists({
      userId,
      runId,
      connectedAccountId: accountId,
      kind: 'TELEGRAM_METADATA_UNREADABLE',
      telegramFileId: outcome.telegramFileId,
      metadata: { errorCode: outcome.errorCode, reason: outcome.errorMessage.slice(0, 200) },
    })
  }
}

export type SyncIssueKind = 'REMOTE_FILE_MISSING' | 'TELEGRAM_METADATA_MISMATCH' | 'TELEGRAM_METADATA_UNREADABLE'

/** Upsert an unresolved issue instead of creating duplicates on every scan. */
export async function createIssueIfOpenNotExists(input: {
  userId: string
  runId: string
  connectedAccountId: string
  kind: SyncIssueKind
  fileId?: string | null
  telegramFileId?: string | null
  metadata?: unknown
}): Promise<void> {
  const { userId, runId, connectedAccountId, kind, fileId, telegramFileId, metadata } = input
  const existing = await prisma.telegramSyncIssue.findFirst({
    where: {
      connectedAccountId,
      kind,
      ...(fileId ? { fileId } : {}),
      ...(telegramFileId ? { telegramFileId } : {}),
      resolvedAt: null,
    },
    select: { id: true },
  })

  if (existing) {
    await prisma.telegramSyncIssue.update({
      where: { id: existing.id },
      data: { runId, metadata: metadata ?? undefined },
    })
    return
  }

  await prisma.telegramSyncIssue.create({
    data: {
      userId,
      runId,
      connectedAccountId,
      kind,
      fileId: fileId ?? null,
      telegramFileId: telegramFileId ?? null,
      metadata: metadata ?? undefined,
    },
  })
}
