import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { syncTelegramUsage } from './telegram-usage.service.js'
import {
  getTelegramConfig,
  listTelegramDocuments,
  parseTelegramRemoteId,
  withTelegramClient,
  resolveConfiguredChannel,
} from './telegram.service.js'
import {
  buildLogicalPath,
  isUnsafeSegment,
  normalizeLogicalPath,
  parseCaption,
  splitLogicalPath,
  type ParsedMetadata,
} from './telegram-metadata.js'

/**
 * Telegram → 9Drive ingestion.
 *
 * The 9Drive DB is the authoritative logical filesystem; the Telegram
 * storage channel is a mirror. Each document carries an optional caption
 * with the file's 9Drive identity (stable id) and current logical path.
 * Ingestion reconciles DB rows with the channel:
 *
 *   1. The caption is parsed.
 *   2. On `9drive:id=<stableId>`, the matching `File` row (by
 *      `(userId, telegramStableId)`) is found and reconciled:
 *      filename, folder, mimeType, sizeBytes, providerFileId.
 *   3. On `9drive:path=<logicalPath>` only (no id), a row keyed by
 *      `providerFileId` is reconciled and `telegramStableId` is stamped
 *      when later seen in another caption.
 *   4. With no metadata at all, the document is placed in the existing
 *      "Recovered from Telegram" inbox folder.
 *
 * The service NEVER deletes 9Drive rows when the Telegram message is gone
 * (the next scan simply skips a missing remoteId; permanent delete is the
 * 9Drive-side lifecycle decision).
 */

export type IngestSummary = {
  scanned: number
  matched: number
  updated: number
  created: number
  inboxed: number
  skipped: number
}

/**
 * Run the caption-driven ingest for a connected Telegram account.
 *
 * Iterates the storage channel, parses captions, and reconciles each
 * document against the 9Drive DB. Idempotent: re-running the ingest
 * converges on the same DB state without creating duplicates.
 */
export async function ingestTelegramAccount(userId: string, accountId: string, limit?: number): Promise<IngestSummary> {
  const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, userId, provider: 'telegram' } })
  if (!account) throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The Telegram storage account does not exist.', 404)

  const config = await getTelegramConfig(accountId, userId)
  if (!config.channelId) {
    throw new AppError('TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED', 'No Telegram storage channel is configured for this account.', 409)
  }

  const documents = await listTelegramDocuments(config)
  const sliced = typeof limit === 'number' && limit > 0 ? documents.slice(0, limit) : documents

  let matched = 0
  let updated = 0
  let created = 0
  let inboxed = 0
  let skipped = 0
  for (const document of sliced) {
    const message = await fetchMessageCaption(config, document.remoteId)
    const caption = message?.caption ?? null
    const result = await ingestTelegramDocument(userId, accountId, document, caption)
    if (result === 'matched') matched += 1
    if (result === 'updated') updated += 1
    if (result === 'created') created += 1
    if (result === 'inboxed') inboxed += 1
    if (result === 'skipped') skipped += 1
  }

  await syncTelegramUsage(accountId).catch(() => undefined)
  await createAuditLog(userId, 'telegram.ingest', 'connected_account', accountId, {
    scanned: sliced.length,
    matched,
    updated,
    created,
    inboxed,
    skipped,
  })

  return { scanned: documents.length, matched, updated, created, inboxed, skipped }
}

type IngestOutcome = 'matched' | 'updated' | 'created' | 'inboxed' | 'skipped'

type TelegramDocumentSummary = {
  remoteId: string
  name: string
  size: number
  mimeType: string | null
}

/**
 * Reconcile a single Telegram document against the 9Drive DB.
 *
 * Exposed for the recovery index path (`indexTelegramAccount`) so both
 * flows share the same caption-driven reconciliation.
 */
export async function ingestTelegramDocument(
  userId: string,
  accountId: string,
  document: TelegramDocumentSummary,
  caption: string | null,
): Promise<IngestOutcome> {
  const parsed = parseCaption(caption)

  // Case 1: 9Drive stable id → update or no-op by logical identity.
  if (parsed.stableId) {
    const file = await prisma.file.findFirst({
      where: { userId, telegramStableId: parsed.stableId, provider: 'telegram' },
      select: { id: true, providerFileId: true, name: true, folderId: true, mimeType: true, sizeBytes: true },
    })
    if (!file) {
      // No matching logical file — the id was new to us; create the row
      // keyed by `providerFileId` and stamp the stable id.
      return createOrInboxFromParsed(userId, accountId, document, parsed)
    }
    return updateFromParsed(userId, file.id, document, parsed)
  }

  // Case 2: 9Drive path only → match by physical providerFileId.
  if (parsed.logicalPath) {
    const file = await prisma.file.findFirst({
      where: { userId, provider: 'telegram', providerFileId: document.remoteId },
      select: { id: true, name: true, folderId: true, mimeType: true, sizeBytes: true, telegramStableId: true },
    })
    if (file) {
      return updateFromParsed(userId, file.id, document, parsed)
    }
    return createOrInboxFromParsed(userId, accountId, document, parsed)
  }

  // Case 3: no metadata → match by physical providerFileId (legacy recovery
  // path). If we already have a row, leave it alone. Otherwise fall back to
  // the inbox folder.
  const file = await prisma.file.findFirst({
    where: { userId, provider: 'telegram', providerFileId: document.remoteId },
    select: { id: true },
  })
  if (file) {
    await syncPhysicalFieldsOnly(userId, file.id, document)
    return 'matched'
  }
  await createInboxFile(userId, accountId, document)
  return 'inboxed'
}

async function createOrInboxFromParsed(
  userId: string,
  accountId: string,
  document: TelegramDocumentSummary,
  parsed: ParsedMetadata,
): Promise<IngestOutcome> {
  if (!parsed.logicalPath) {
    await createInboxFile(userId, accountId, document)
    return 'inboxed'
  }
  const segments = splitLogicalPath(parsed.logicalPath)
  if (segments.length === 0) {
    await createInboxFile(userId, accountId, document)
    return 'inboxed'
  }
  const filename = segments[segments.length - 1]
  const folderSegments = segments.slice(0, -1)
  let folderId: string | null = null
  if (folderSegments.length > 0) {
    folderId = await ensureFolderPathBySegments(userId, folderSegments, 'sync')
  }
  await prisma.file.create({
    data: {
      userId,
      connectedAccountId: accountId,
      folderId,
      provider: 'telegram',
      providerFileId: document.remoteId,
      telegramStableId: parsed.stableId,
      name: filename,
      mimeType: document.mimeType ?? 'application/octet-stream',
      sizeBytes: BigInt(document.size),
    },
  })
  return parsed.stableId ? 'created' : 'inboxed'
}

async function updateFromParsed(
  userId: string,
  fileId: string,
  document: TelegramDocumentSummary,
  parsed: ParsedMetadata,
): Promise<IngestOutcome> {
  const current = await prisma.file.findFirst({
    where: { id: fileId, userId },
    select: { id: true, name: true, folderId: true, mimeType: true, sizeBytes: true, telegramStableId: true, providerFileId: true },
  })
  if (!current) return 'skipped'

  const updates: Record<string, unknown> = {}
  if (parsed.stableId && current.telegramStableId !== parsed.stableId) {
    updates.telegramStableId = parsed.stableId
  }
  if (current.providerFileId !== document.remoteId) {
    updates.providerFileId = document.remoteId
  }

  if (parsed.logicalPath) {
    const segments = splitLogicalPath(parsed.logicalPath)
    if (segments.length > 0) {
      const filename = segments[segments.length - 1]
      const folderSegments = segments.slice(0, -1)
      let folderId: string | null = null
      if (folderSegments.length > 0) {
        folderId = await ensureFolderPathBySegments(userId, folderSegments, 'sync')
      }
      if (filename !== current.name) updates.name = filename
      if ((folderId ?? null) !== (current.folderId ?? null)) updates.folderId = folderId
    }
  }

  const nextMime = document.mimeType ?? 'application/octet-stream'
  if (current.mimeType !== nextMime) updates.mimeType = nextMime
  const nextSize = BigInt(document.size)
  if (current.sizeBytes !== nextSize) updates.sizeBytes = nextSize

  if (Object.keys(updates).length === 0) return 'matched'
  await prisma.file.update({ where: { id: fileId, userId }, data: updates })
  return 'updated'
}

async function syncPhysicalFieldsOnly(userId: string, fileId: string, document: TelegramDocumentSummary) {
  const current = await prisma.file.findFirst({ where: { id: fileId, userId }, select: { mimeType: true, sizeBytes: true, providerFileId: true } })
  if (!current) return
  const updates: Record<string, unknown> = {}
  if (current.providerFileId !== document.remoteId) updates.providerFileId = document.remoteId
  const nextMime = document.mimeType ?? 'application/octet-stream'
  if (current.mimeType !== nextMime) updates.mimeType = nextMime
  const nextSize = BigInt(document.size)
  if (current.sizeBytes !== nextSize) updates.sizeBytes = nextSize
  if (Object.keys(updates).length > 0) {
    await prisma.file.update({ where: { id: fileId, userId }, data: updates })
  }
}

async function createInboxFile(userId: string, accountId: string, document: TelegramDocumentSummary) {
  const inbox = await getOrCreateRecoveredFolder(userId)
  await prisma.file.create({
    data: {
      userId,
      connectedAccountId: accountId,
      folderId: inbox.id,
      provider: 'telegram',
      providerFileId: document.remoteId,
      name: document.name,
      mimeType: document.mimeType ?? 'application/octet-stream',
      sizeBytes: BigInt(document.size),
    },
  })
}

async function getOrCreateRecoveredFolder(userId: string) {
  const name = 'Recovered from Telegram'
  const existing = await prisma.folder.findFirst({ where: { userId, parentId: null, name }, select: { id: true } })
  if (existing) return existing
  return prisma.folder.create({
    data: {
      userId,
      parentId: null,
      name,
      normalizedName: name.trim().toLowerCase(),
      origin: 'user',
      provider: 'telegram',
    },
    select: { id: true },
  })
}

/**
 * Walk a folder chain (no filename) and return the leaf folder id, creating
 * missing folders along the way. Reuses the `(userId, parentId, normalizedName)`
 * unique index for idempotency — a P2002 re-reads the winner row.
 */
export async function ensureFolderPathBySegments(
  userId: string,
  segments: string[],
  origin: 'user' | 'sync' = 'user',
): Promise<string | null> {
  if (segments.length === 0) return null
  let parentId: string | null = null
  for (const raw of segments) {
    const segment = raw.normalize('NFC').trim()
    if (!segment) return parentId
    if (segment.length > 255) return parentId
    // Defense-in-depth: never create a `.`/`..` folder even if a caller
    // bypasses the metadata normalizer (spec §8). Treat as unresolvable.
    if (isUnsafeSegment(segment)) return parentId
    const normalized = segment.toLowerCase()
    const existing: { id: string } | null = await prisma.folder.findFirst({
      where: { userId, parentId, normalizedName: normalized, deletedAt: null },
      select: { id: true },
    })
    if (existing) {
      parentId = existing.id
      continue
    }
    try {
      const created: { id: string } = await prisma.folder.create({
        data: {
          userId,
          parentId,
          name: segment,
          normalizedName: normalized,
          origin,
          provider: 'telegram',
        },
        select: { id: true },
      })
      parentId = created.id
    } catch (error) {
      if (!(error instanceof Error) || !(error as { code?: string }).code) throw error
      if ((error as { code?: string }).code === 'P2002') {
        const winner: { id: string } | null = await prisma.folder.findFirst({
          where: { userId, parentId, normalizedName: normalized, deletedAt: null },
          select: { id: true },
        })
        if (winner) {
          parentId = winner.id
          continue
        }
      }
      throw error
    }
  }
  return parentId
}

async function fetchMessageCaption(
  config: { apiIdEncrypted: string; apiHashEncrypted: string; sessionEncrypted: string; connectedAccount: { provider: string } },
  remoteId: string,
): Promise<{ caption: string | null } | null> {
  let result: { caption: string | null } | null = null
  try {
    await withTelegramClient(config, async (client) => {
      const { channelId, messageId } = parseTelegramRemoteId(remoteId)
      const channel = await resolveConfiguredChannel(client, channelId)
      const messages = await client.getMessages(channel as never, { ids: [messageId] })
      const message = messages[0]
      result = { caption: ((message as { message?: string } | undefined)?.message ?? null) }
    })
  } catch {
    result = { caption: null }
  }
  return result
}

/** Convenience re-export for callers that only want the segment builder. */
export function joinLogicalPath(segments: string[]): string | null {
  return buildLogicalPath(segments)
}

export { normalizeLogicalPath }