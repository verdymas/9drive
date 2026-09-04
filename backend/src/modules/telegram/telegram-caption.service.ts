import type { ConnectedAccount, File, TelegramStorageConfig } from '@prisma/client'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import {
  buildTelegramRemoteId,
  classifyTelegramError,
  parseTelegramRemoteId,
  resolveConfiguredChannel,
  uploadTelegramDocument,
  withTelegramClient,
} from './telegram.service.js'
import { encodeCaption, normalizeLogicalPath, TELEGRAM_CAPTION_MAX } from './telegram-metadata.js'

type TelegramConfig = TelegramStorageConfig & { connectedAccount: ConnectedAccount }
type FileWithStableId = { id: string; name: string; telegramStableId: string | null }

/**
 * Telegram caption refresh — 9Drive identity propagation.
 *
 * When a 9Drive file lives on a Telegram storage account, every rename or
 * move changes its logical path. The Telegram document caption must reflect
 * that path so a re-import (or a second 9Drive account ingesting the same
 * channel) resolves the file by its stable id.
 *
 * The 9Drive DB is the source of truth. Caption edits are best-effort: a
 * Telegram-side failure logs an `audit_log` row and a structured `console.error`
 * but does NOT roll back the DB rename — the next ingest reconciles any drift.
 */

export type CaptionUpdateResult = {
  ok: boolean
  channelId: string
  messageId: number
  previousCaption: string | null
  nextCaption: string
  changed: boolean
}

/**
 * Update the Telegram caption for a 9Drive file living on a Telegram
 * account. `logicalPath` is the post-mutation path (built by the caller
 * from `Folder` ancestry + filename). No-op when the existing caption
 * already matches.
 *
 * `encryptedMeta` (a full `9drive:meta=v1:...` line) is included in the
 * caption when protected metadata is enabled. The physical document — bytes
 * and filename alike — is never touched.
 */
export async function updateTelegramDocumentCaption(
  userId: string,
  file: FileWithStableId,
  config: TelegramConfig,
  logicalPath: string | null,
  encryptedMeta?: string | null,
): Promise<CaptionUpdateResult> {
  if (file.telegramStableId === null || file.telegramStableId === undefined) {
    // A file without a stable id has no 9Drive metadata to refresh — the
    // first ingest that meets it will stamp the id. Silently no-op so
    // callers don't have to special-case legacy rows.
    return { ok: true, channelId: config.channelId ?? '', messageId: 0, previousCaption: null, nextCaption: '', changed: false }
  }
  const stableId: string = file.telegramStableId
  const normalizedPath = logicalPath ? normalizeLogicalPath(logicalPath) : null
  const nextCaption = encodeCaption({
    stableId,
    logicalPath: normalizedPath,
    ...(encryptedMeta ? { encryptedMeta } : {}),
  })
  if (!nextCaption) {
    throw new AppError('TELEGRAM_METADATA_INVALID', 'Could not encode the 9Drive metadata caption for this file.', 400)
  }
  if (nextCaption.length > TELEGRAM_CAPTION_MAX) {
    throw new AppError('TELEGRAM_METADATA_INVALID', 'The 9Drive metadata caption exceeds the Telegram caption limit.', 400)
  }

  const remoteId = await resolveProviderFileId(userId, file.id, config)
  if (!remoteId) {
    // The file has a stable id but no Telegram document yet — this is the
    // pre-upload case, the upload itself will write the caption.
    return { ok: true, channelId: config.channelId ?? '', messageId: 0, previousCaption: null, nextCaption, changed: false }
  }
  const { channelId, messageId } = parseTelegramRemoteId(remoteId)

  let previousCaption: string | null = null
  let changed = false
  await withTelegramClient(config, async (client) => {
    const channel = await resolveConfiguredChannel(client, channelId)
    const messages = await client.getMessages(channel as never, { ids: [messageId] })
    const message = messages[0]
    previousCaption = ((message as { message?: string } | undefined)?.message ?? null)
    if (previousCaption === nextCaption) {
      changed = false
      return
    }
    changed = true
    try {
      await client.editMessage(channel as never, { message: messageId, text: nextCaption })
    } catch (error) {
      throw classifyTelegramError(error)
    }
  })

  const result: CaptionUpdateResult = {
    ok: true,
    channelId,
    messageId,
    previousCaption,
    nextCaption,
    changed,
  }
  await createAuditLog(userId, 'telegram.caption_update', 'file', file.id, {
    channelId,
    messageId,
    changed,
    stableId: file.telegramStableId,
    logicalPath: normalizedPath,
  })
  return result
}

/**
 * Build the caption that should be written to a freshly-uploaded Telegram
 * document so the first ingest can recognize it. Exposed for the upload
 * path; centralizes the encoder call so the format is owned by one module.
 */
export function buildInitialCaption(stableId: string, logicalPath: string | null): string | null {
  return encodeCaption({ stableId, logicalPath })
}

/**
 * Shared Telegram upload helper used by BOTH the normal upload path and the
 * remote-import processor so the two never diverge on caption/metadata
 * handling (spec §26 — no duplicated crypto logic).
 *
 * When encryption/obfuscation is enabled it encrypts the recovery metadata
 * into a `9drive:meta=v1:...` caption line and substitutes the opaque
 * physical filename; otherwise it preserves the current plaintext behavior
 * (`9drive:path` caption + logical filename) exactly.
 *
 * Returns `{ remoteId, caption, uploadName }` so the caller can persist the
 * cache block in the same update that stores `providerFileId`.
 */
export async function uploadTelegramDocumentWithCrypto(opts: {
  config: TelegramConfig
  filePath: string
  fileName: string
  mimeType: string
  sizeBytes: number
  userId: string
  fileId: string
  logicalPath: string | null
  onProgress?: (pct: number) => void
}): Promise<{ remoteId: string; caption: string | null; uploadName: string }> {
  const { config, filePath, fileName, mimeType, sizeBytes, fileId, logicalPath, onProgress } = opts
  const { buildTelegramMetadataCache } = await import('./telegram-metadata-cache.js')

  const cache = buildTelegramMetadataCache({ fileId, name: fileName, path: logicalPath, mimeType, size: sizeBytes })
  const caption = encodeCaption({
    stableId: fileId,
    logicalPath,
    ...(typeof cache.encryptedMetadata === 'string' ? { encryptedMeta: cache.encryptedMetadata } : {}),
  })
  const uploadName = typeof cache.physicalFilename === 'string' ? cache.physicalFilename : fileName

  const remoteId = await uploadTelegramDocument(config, {
    filePath,
    name: uploadName,
    mimeType,
    sizeBytes,
    caption: caption ?? undefined,
    ...(onProgress ? { onProgress } : {}),
  })
  return { remoteId, caption, uploadName }
}

/**
 * Look up the current `providerFileId` for a 9Drive file that lives on a
 * Telegram account. Returns `null` when no Telegram document exists yet
 * (pre-upload / orphaned stable id).
 *
 * Used by `updateTelegramDocumentCaption` to find the channel/message to
 * edit. Avoids a hard Prisma dependency in the upload path.
 */
async function resolveProviderFileId(userId: string, fileId: string, _config: TelegramConfig): Promise<string | null> {
  const { prisma } = await import('../../config/prisma.js')
  const file = await prisma.file.findFirst({
    where: { id: fileId, userId, provider: 'telegram' },
    select: { providerFileId: true },
  })
  return file?.providerFileId ?? null
}

/**
 * Format the encoded Telegram remote id. Re-exported so the upload path
 * can build the same form on its side without depending on internals.
 */
export { buildTelegramRemoteId }