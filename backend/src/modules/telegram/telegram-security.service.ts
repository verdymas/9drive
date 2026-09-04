import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { logicalPathForFileId } from '../files/file-logical-path.js'
import { getTelegramConfig } from './telegram.service.js'
import { updateTelegramDocumentCaption } from './telegram-caption.service.js'
import { buildTelegramMetadataCache, telegramCryptoEnabled } from './telegram-metadata-cache.js'
import {
  decryptRecoveryMetadata,
  generatePhysicalFilename,
  telegramCryptoStatus,
  type RecoveryMetadata,
  type TelegramCryptoStatus,
} from './telegram-crypto.service.js'
import { encodeCaption } from './telegram-metadata.js'

/**
 * Telegram metadata security utilities (spec §43-§46).
 *
 * Three operations, all scoped to files the caller owns:
 *   - `encrypt`        → produce the caption a user can paste into Telegram
 *                        by hand when a message's metadata was lost (§41).
 *   - `decrypt`        → read back a `9drive:meta` payload for diagnosis.
 *   - `convertLegacy`  → rewrite a plaintext caption as an encrypted one via
 *                        `editMessage`. Metadata only: no content re-upload,
 *                        and the physical filename is left as-is.
 *
 * The master key never leaves the backend and is never returned, logged, or
 * serialized — `status` exposes only configured / notConfigured / invalid.
 */

export function getTelegramSecurityStatus(): TelegramCryptoStatus {
  return telegramCryptoStatus()
}

type OwnedTelegramFile = {
  id: string
  name: string
  mimeType: string
  sizeBytes: bigint
  connectedAccountId: string
  telegramStableId: string | null
  providerFileId: string
  encryptedMetadata: string | null
}

async function getOwnedTelegramFile(userId: string, fileId: string): Promise<OwnedTelegramFile> {
  const file = await prisma.file.findFirst({
    where: { id: fileId, userId, provider: 'telegram' },
    select: { id: true, name: true, mimeType: true, sizeBytes: true, connectedAccountId: true, telegramStableId: true, providerFileId: true, encryptedMetadata: true },
  })
  if (!file) throw new AppError('FILE_NOT_FOUND', 'The Telegram file does not exist.', 404)
  return file
}

/** Canonical recovery metadata for a file, read from the authoritative DB row. */
async function recoveryFor(userId: string, file: OwnedTelegramFile): Promise<RecoveryMetadata & { fileId: string }> {
  return {
    fileId: file.telegramStableId ?? file.id,
    name: file.name,
    path: await logicalPathForFileId(userId, file.id),
    mimeType: file.mimeType,
    size: file.sizeBytes,
  }
}

/**
 * Build the encrypted caption for a file so the user can restore lost
 * Telegram metadata by pasting it into the message (§41). Does NOT touch
 * Telegram and does NOT change the cached ciphertext — the next sync sees the
 * pasted caption differ from the cache and reconciles it.
 */
export async function buildEncryptedCaptionForFile(userId: string, fileId: string): Promise<{ caption: string; metaLine: string; physicalFilename: string | null }> {
  if (!telegramCryptoEnabled()) {
    throw new AppError('TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED', 'Telegram metadata encryption is not enabled.', 409)
  }
  const file = await getOwnedTelegramFile(userId, fileId)
  const recovery = await recoveryFor(userId, file)
  const cache = buildTelegramMetadataCache(recovery)
  const metaLine = String(cache.encryptedMetadata)
  const caption = encodeCaption({ stableId: recovery.fileId, logicalPath: recovery.path, encryptedMeta: metaLine })
  if (!caption) throw new AppError('TELEGRAM_METADATA_INVALID', 'Could not encode the caption for this file.', 400)
  await createAuditLog(userId, 'telegram.security.encrypt', 'file', file.id, { fileId: file.id })
  return {
    caption,
    metaLine,
    physicalFilename: typeof cache.physicalFilename === 'string' ? cache.physicalFilename : generatePhysicalFilename(recovery.fileId, file.name),
  }
}

/**
 * Decrypt a `9drive:meta` payload for diagnosis. Accepts the full caption
 * line or the raw `v1:...` payload. Never logs the decrypted metadata.
 */
export async function decryptMetadataPayload(userId: string, payload: string): Promise<RecoveryMetadata> {
  if (!telegramCryptoEnabled()) {
    throw new AppError('TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED', 'Telegram metadata encryption is not enabled.', 409)
  }
  const meta = decryptRecoveryMetadata(payload.trim())
  await createAuditLog(userId, 'telegram.security.decrypt', 'connected_account', undefined, { ok: true })
  return meta
}

/**
 * Rewrite one file's Telegram caption as an encrypted caption (migration
 * Mode B). Metadata only: the document bytes and its Telegram filename are
 * untouched, so the file keeps playing from the same message.
 */
export async function convertFileToEncryptedCaption(userId: string, fileId: string): Promise<{ changed: boolean; channelId: string; messageId: number }> {
  if (!telegramCryptoEnabled()) {
    throw new AppError('TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED', 'Telegram metadata encryption is not enabled.', 409)
  }
  const file = await getOwnedTelegramFile(userId, fileId)
  if (!file.telegramStableId) {
    throw new AppError('TELEGRAM_METADATA_INVALID', 'This file has no 9Drive stable id yet; run a sync first.', 409)
  }
  const config = await getTelegramConfig(file.connectedAccountId, userId)
  const recovery = await recoveryFor(userId, file)
  const cache = buildTelegramMetadataCache(recovery)
  const metaLine = String(cache.encryptedMetadata)

  const result = await updateTelegramDocumentCaption(
    userId,
    { id: file.id, name: file.name, telegramStableId: file.telegramStableId },
    config,
    recovery.path,
    metaLine,
  )
  // Cache only after Telegram accepted the edit, so a failed edit never
  // leaves the DB claiming a ciphertext the message doesn't carry.
  const { physicalFilename: _keepPhysicalName, ...metaOnly } = cache
  await prisma.file.update({ where: { id: file.id, userId }, data: metaOnly })
  await createAuditLog(userId, 'telegram.security.convert_legacy', 'file', file.id, {
    changed: result.changed,
    channelId: result.channelId,
    messageId: result.messageId,
  })
  return { changed: result.changed, channelId: result.channelId, messageId: result.messageId }
}
