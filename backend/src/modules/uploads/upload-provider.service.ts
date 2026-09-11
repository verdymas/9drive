import { createReadStream } from 'node:fs'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, deleteS3ObjectByKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { deleteTelegramDocuments, getTelegramConfig } from '../telegram/telegram.service.js'
import { syncTelegramUsage } from '../telegram/telegram-usage.service.js'
import { uploadTelegramDocumentWithCrypto } from '../telegram/telegram-caption.service.js'
import { buildTelegramMetadataCache } from '../telegram/telegram-metadata-cache.js'
import { logicalPathForFileId } from '../files/file-logical-path.js'

export type StagedUploadOptions = {
  userId: string
  account: { id: string; provider: string }
  folderId: string | null
  fileName: string
  mimeType: string
  sizeBytes: bigint
  tmpPath: string
  logicalPath?: string | null
  signal?: AbortSignal
}

export type FinalizedStagedUpload = {
  file: Record<string, any>
  providerFileId: string
  cleanup: () => Promise<void>
}

function logUpload(message: string, metadata?: Record<string, unknown>) {
  console.info('[upload]', message, metadata ?? '')
}

export async function cleanupTelegramRemote(
  config: Parameters<typeof deleteTelegramDocuments>[0],
  accountId: string,
  remoteId: string,
) {
  const firstErrors = await deleteTelegramDocuments(config, [remoteId])
  if (firstErrors.length === 0) return
  logUpload('telegram provider cleanup retry', { accountId, errorCount: firstErrors.length })
  const retryErrors = await deleteTelegramDocuments(config, [remoteId])
  if (retryErrors.length > 0) {
    console.error('[upload] telegram provider cleanup failed', { accountId, errorCount: retryErrors.length })
  }
}

/**
 * The S3 object-key prefix for a folder location: the location's
 * `providerFolderId` is the full virtual path (e.g. `9drive/Movies`).
 * `buildS3ObjectKey` strips the account root and appends `/userId/fileId/name`.
 */
function folderPrefixFor(_config: { prefix: string }, providerFolderId: string) {
  return providerFolderId
}

/** Resolve the physical destination prefix/root for a non-Google provider. */
async function resolveProviderRootOrLocation(userId: string, folderId: string | null, account: { id: string; provider: string }) {
  if (folderId) {
    const location = await prisma.folderStorageLocation.findFirst({
      where: { folderId, connectedAccountId: account.id },
    })
    if (location) return location.providerFolderId
    const { ensureFolderStorageLocation } = await import('../storage/folder-materialization.service.js')
    const result = await ensureFolderStorageLocation(userId, folderId, account.id)
    return result.location.providerFolderId
  }
  const { ensureProviderRoot } = await import('../storage/provider-folder.service.js')
  return ensureProviderRoot(account as never)
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Upload aborted by client.')
}

/**
 * Finalize a staged non-Google upload into a provider object and an active
 * File row. The cleanup callback compensates a committed provider object if a
 * later upload-session/database operation fails.
 */
export async function finalizeStagedUpload(opts: StagedUploadOptions): Promise<FinalizedStagedUpload> {
  const { userId, account, folderId, fileName, mimeType, sizeBytes, tmpPath, logicalPath, signal } = opts
  throwIfAborted(signal)
  const providerFolderId = await resolveProviderRootOrLocation(userId, folderId, account)

  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id, userId)
    const provisionalFile = await prisma.file.create({
      data: { userId, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType, sizeBytes, status: 'uploading' },
    })
    const key = buildS3ObjectKey(config, userId, provisionalFile.id, fileName, folderId ? folderPrefixFor(config, providerFolderId) : undefined)
    let providerCommitted = false
    try {
      await uploadS3Object(config, key, createReadStream(tmpPath), mimeType, { signal })
      providerCommitted = true
      throwIfAborted(signal)
      const file = await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId: key, status: 'active' } })
      return {
        file,
        providerFileId: key,
        cleanup: async () => deleteS3ObjectByKey(config, key),
      }
    } catch (error) {
      if (providerCommitted) await deleteS3ObjectByKey(config, key).catch(() => undefined)
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      throw error
    }
  }

  if (account.provider === 'telegram') {
    const config = await getTelegramConfig(account.id, userId)
    const provisionalFile = await prisma.file.create({
      data: { userId, connectedAccountId: account.id, folderId, provider: 'telegram', providerFileId: 'pending', name: fileName, mimeType, sizeBytes, status: 'uploading' },
    })
    let remoteId: string | null = null
    try {
      const stableId = provisionalFile.id
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { telegramStableId: stableId } })
      const resolvedLogicalPath = logicalPath ?? (await logicalPathForFileId(userId, provisionalFile.id))
      const uploaded = await uploadTelegramDocumentWithCrypto({
        config,
        filePath: tmpPath,
        fileName,
        mimeType,
        sizeBytes: Number(sizeBytes),
        userId,
        fileId: stableId,
        logicalPath: resolvedLogicalPath,
      })
      remoteId = uploaded.remoteId
      throwIfAborted(signal)
      const file = await prisma.file.update({
        where: { id: provisionalFile.id },
        data: {
          providerFileId: remoteId,
          status: 'active',
          ...buildTelegramMetadataCache({ fileId: stableId, name: fileName, path: resolvedLogicalPath, mimeType, size: sizeBytes }),
        },
      })
      return {
        file,
        providerFileId: remoteId,
        cleanup: async () => cleanupTelegramRemote(config, account.id, remoteId!),
      }
    } catch (error) {
      if (remoteId) await cleanupTelegramRemote(config, account.id, remoteId).catch(() => undefined)
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      throw error
    }
  }

  throw new Error(`finalizeStagedUpload called for unsupported provider "${account.provider}"`)
}

export function syncQuotaInBackground(accountId: string, sessionId: string, provider?: string) {
  logUpload('quota sync started', { accountId, sessionId })
  const sync = provider === 's3'
    ? syncS3Quota(accountId)
    : provider === 'telegram'
      ? syncTelegramUsage(accountId)
      : syncGoogleQuota(accountId)
  sync
    .then(() => logUpload('quota sync completed', { accountId, sessionId }))
    .catch((error) => logUpload('quota sync failed', { accountId, sessionId, message: error instanceof Error ? error.message : 'Unknown error' }))
}

