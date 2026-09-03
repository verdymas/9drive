import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { getTelegramConfig, listTelegramDocuments } from './telegram.service.js'

/**
 * Recovery/reconciliation index for a Telegram storage account.
 *
 * The database is the source of truth for the virtual tree; the channel is
 * scanned only to import documents that have no File row on the account —
 * placed in a flat "Recovered from Telegram" folder. This never deletes or
 * soft-deletes existing rows (unlike the Google/S3 sync missing-reconciler).
 */
export async function indexTelegramAccount(userId: string, accountId: string) {
  const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, userId, provider: 'telegram' } })
  if (!account) throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The Telegram storage account does not exist.', 404)

  const config = await getTelegramConfig(accountId, userId)
  const documents = await listTelegramDocuments(config)

  const recoveredFolder = await getOrCreateRecoveredFolder(userId)

  let imported = 0
  let skipped = 0
  for (const document of documents) {
    const existing = await prisma.file.findFirst({
      where: {
        userId,
        connectedAccountId: accountId,
        providerFileId: document.remoteId,
      },
      select: { id: true },
    })
    if (existing) {
      skipped += 1
      continue
    }
    await prisma.file.create({
      data: {
        userId,
        connectedAccountId: accountId,
        folderId: recoveredFolder.id,
        provider: 'telegram',
        providerFileId: document.remoteId,
        name: document.name,
        mimeType: document.mimeType ?? 'application/octet-stream',
        sizeBytes: BigInt(document.size),
      },
    })
    imported += 1
  }

  const { syncTelegramUsage } = await import('./telegram-usage.service.js')
  await syncTelegramUsage(accountId).catch(() => undefined)
  await createAuditLog(userId, 'telegram.index', 'connected_account', accountId, { scanned: documents.length, imported, skipped })

  return { scanned: documents.length, imported, skipped }
}

async function getOrCreateRecoveredFolder(userId: string) {
  const name = 'Recovered from Telegram'
  const existing = await prisma.folder.findFirst({ where: { userId, parentId: null, name } })
  if (existing) return existing
  const created = await prisma.folder.create({
    data: {
      userId,
      parentId: null,
      name,
      normalizedName: name.trim().toLowerCase(),
      origin: 'user',
      provider: 'telegram',
    },
  })
  return created
}