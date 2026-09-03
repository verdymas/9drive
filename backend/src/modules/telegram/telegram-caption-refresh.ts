import { prisma } from '../../config/prisma.js'
import { logicalPathForFileId } from '../files/file-logical-path.js'
import { getTelegramConfig } from './telegram.service.js'
import { updateTelegramDocumentCaption } from './telegram-caption.service.js'

/**
 * Best-effort refresh of the Telegram document caption for a 9Drive file.
 *
 * Resolves the current logical path from the DB, loads the storage
 * config, and asks the caption service to re-encode + `editMessage`.
 * The caller is expected to swallow errors (never block the route
 * response); the next ingest reconciles any drift.
 *
 * Used by:
 *   - PATCH /files/:id and PATCH /files/batch (rename/move)
 *   - PATCH /folders/:id (folder rename/move — fans out to descendants)
 */
export async function refreshTelegramCaption(userId: string, fileId: string): Promise<void> {
  const file = await prisma.file.findFirst({
    where: { id: fileId, userId, provider: 'telegram' },
    select: { id: true, name: true, connectedAccountId: true, telegramStableId: true },
  })
  if (!file || !file.telegramStableId) return
  const [logicalPath, config] = await Promise.all([
    logicalPathForFileId(userId, fileId),
    getTelegramConfig(file.connectedAccountId, userId).catch(() => null),
  ])
  if (!config) return
  await updateTelegramDocumentCaption(
    userId,
    { id: file.id, name: file.name, telegramStableId: file.telegramStableId },
    config,
    logicalPath,
  )
}
