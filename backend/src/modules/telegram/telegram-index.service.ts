import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import {
  getTelegramConfig,
  listTelegramDocuments,
  parseTelegramRemoteId,
  resolveConfiguredChannel,
  withTelegramClient,
} from './telegram.service.js'
import { ingestTelegramDocument, type IngestSummary } from './telegram-ingest.service.js'

/**
 * Recovery/reconciliation index for a Telegram storage account.
 *
 * The database is the source of truth for the virtual tree; the channel is
 * scanned to ingest documents that have no File row on the account. The
 * ingest path is caption-driven:
 *
 *   - documents whose caption carries `9drive:id=<stableId>` or
 *     `9drive:path=<logicalPath>` are routed through the caption-driven
 *     reconciliation (`ingestTelegramDocument`) — they may update an
 *     existing File row, create a new one, or be skipped when nothing
 *     changed.
 *   - documents with no recognized 9Drive metadata are placed in the
 *     existing "Recovered from Telegram" inbox folder, preserving the
 *     pre-metadata safety net for legacy channel content.
 *
 * Caption lookup is skipped for documents that already have a File row
 * keyed by their `providerFileId` (legacy ingest / recovered rows) — the
 * caption can only update an existing row when nothing else changed, and
 * the canonical reconciliation path is `POST /telegram/accounts/:id/import`.
 *
 * No row is ever soft-deleted by the index path. Telegram deletion never
 * propagates into 9Drive (the safety rule from
 * `implementations/9drive-telegram-path-metadata-prompts/README.md`).
 */
export async function indexTelegramAccount(userId: string, accountId: string): Promise<IngestSummary> {
  const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, userId, provider: 'telegram' } })
  if (!account) throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The Telegram storage account does not exist.', 404)

  const config = await getTelegramConfig(accountId, userId)
  const documents = await listTelegramDocuments(config)

  // Pre-pass: figure out which documents have a matching physical row so
  // we can avoid the per-document caption fetch in the legacy "already
  // recovered" case.
  const remoteIds = documents.map((document) => document.remoteId)
  const existing = remoteIds.length
    ? await prisma.file.findMany({
        where: { userId, connectedAccountId: accountId, provider: 'telegram', providerFileId: { in: remoteIds } },
        select: { providerFileId: true },
      })
    : []
  const existingRemoteIds = new Set(existing.map((row) => row.providerFileId))

  let imported = 0
  let updated = 0
  let matched = 0
  let inboxed = 0
  let skipped = 0
  for (const document of documents) {
    let outcome: Awaited<ReturnType<typeof ingestTelegramDocument>>
    if (existingRemoteIds.has(document.remoteId)) {
      // Already in the DB → physical-only reconciliation (mimeType/size);
      // no caption fetch required. Mirrors the legacy `index` semantics
      // without re-reading every caption on every run.
      outcome = await ingestTelegramDocument(userId, accountId, document, null)
    } else {
      const caption = await fetchCaptionForDocument(config, document.remoteId)
      outcome = await ingestTelegramDocument(userId, accountId, document, caption)
    }
    if (outcome === 'created') {
      imported += 1
    } else if (outcome === 'updated') {
      updated += 1
    } else if (outcome === 'matched') {
      matched += 1
    } else if (outcome === 'inboxed') {
      inboxed += 1
    } else {
      skipped += 1
    }
  }

  const { syncTelegramUsage } = await import('./telegram-usage.service.js')
  await syncTelegramUsage(accountId).catch(() => undefined)
  await createAuditLog(userId, 'telegram.index', 'connected_account', accountId, { scanned: documents.length, imported, updated, matched, inboxed, skipped })

  return { scanned: documents.length, matched, updated, created: imported, inboxed, skipped }
}

async function fetchCaptionForDocument(
  config: Parameters<typeof withTelegramClient>[0],
  remoteId: string,
): Promise<string | null> {
  let caption: string | null = null
  try {
    await withTelegramClient(config, async (client) => {
      const { channelId, messageId } = parseTelegramRemoteId(remoteId)
      const channel = await resolveConfiguredChannel(client, channelId)
      const messages = await client.getMessages(channel as never, { ids: [messageId] })
      const message = messages[0]
      caption = ((message as { message?: string } | undefined)?.message ?? null)
    })
  } catch {
    caption = null
  }
  return caption
}