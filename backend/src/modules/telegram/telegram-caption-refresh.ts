import { prisma } from '../../config/prisma.js'
import { logicalPathForFileId } from '../files/file-logical-path.js'
import { getTelegramConfig } from './telegram.service.js'
import { updateTelegramDocumentCaption } from './telegram-caption.service.js'
import { buildTelegramMetadataCache, telegramCryptoEnabled } from './telegram-metadata-cache.js'
import { calculateMetadataFingerprint } from './telegram-crypto.service.js'

/**
 * Best-effort refresh of the Telegram document caption for a 9Drive file.
 *
 * Resolves the current logical path from the DB, loads the storage
 * config, and asks the caption service to re-encode + `editMessage`.
 * The caller is expected to swallow errors (never block the route
 * response); the next ingest reconciles any drift.
 *
 * When protected metadata is enabled (spec §37): the fingerprint is
 * recomputed from the post-mutation canonical metadata and, only if it
 * changed, the payload is encrypted ONCE, cached on the row, and written into
 * the caption. The physical document is never re-uploaded and the opaque
 * physical filename never changes (it is keyed on the immutable file id).
 *
 * Used by:
 *   - PATCH /files/:id and PATCH /files/batch (rename/move)
 *   - PATCH /folders/:id (folder rename/move — fans out to descendants)
 */
export async function refreshTelegramCaption(userId: string, fileId: string): Promise<void> {
  const file = await prisma.file.findFirst({
    where: { id: fileId, userId, provider: 'telegram' },
    select: { id: true, name: true, mimeType: true, sizeBytes: true, connectedAccountId: true, telegramStableId: true, metadataFingerprint: true, encryptedMetadata: true },
  })
  if (!file || !file.telegramStableId) return
  const [logicalPath, config] = await Promise.all([
    logicalPathForFileId(userId, fileId),
    getTelegramConfig(file.connectedAccountId, userId).catch(() => null),
  ])
  if (!config) return

  // Default to the cached ciphertext so an unrelated caption edit never
  // STRIPS the meta line off the Telegram message.
  let encryptedMeta: string | null = file.encryptedMetadata
  if (telegramCryptoEnabled()) {
    const recovery = { fileId: file.telegramStableId, name: file.name, path: logicalPath, mimeType: file.mimeType, size: file.sizeBytes }
    // Unchanged canonical metadata → no re-encryption, reuse the cache.
    if (calculateMetadataFingerprint(recovery) !== file.metadataFingerprint) {
      const cache = buildTelegramMetadataCache(recovery)
      encryptedMeta = typeof cache.encryptedMetadata === 'string' ? cache.encryptedMetadata : encryptedMeta
      // physicalFilename is deliberately excluded: renaming in 9Drive must
      // not rename the Telegram document.
      const { physicalFilename: _ignored, ...metaOnly } = cache
      await prisma.file.update({ where: { id: file.id, userId }, data: metaOnly })
    }
  }

  await updateTelegramDocumentCaption(
    userId,
    { id: file.id, name: file.name, telegramStableId: file.telegramStableId },
    config,
    logicalPath,
    encryptedMeta,
  )
}
