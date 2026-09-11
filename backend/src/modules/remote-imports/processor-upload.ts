import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { encryptText } from '../../utils/crypto.js'
import { getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { getTelegramConfig } from '../telegram/telegram.service.js'
import { syncTelegramUsage } from '../telegram/telegram-usage.service.js'
import { uploadTelegramDocumentWithCrypto } from '../telegram/telegram-caption.service.js'
import { buildTelegramMetadataCache } from '../telegram/telegram-metadata-cache.js'
import { logicalPathForFileId } from '../files/file-logical-path.js'
import { uploadToGoogleResumable } from './google-resumable-uploader.js'
import { STAGES, type ProcessorRecord, type RemoteImportProcessorContext } from './processor-context.js'
import { startUploadPhase, throttledProgressUpdater, updateStage } from './processor-progress.js'
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'

export type UploadedProviderObject = { providerFileId: string; fileId: string | null }

export async function uploadTempFile(
  importId: string,
  account: { id: string; provider: string },
  userId: string,
  folderId: string | null,
  fileName: string,
  mimeType: string,
  tempPartPath: string,
  providerFolderId: string,
): Promise<UploadedProviderObject> {
  const uploadTotalBytes = await startUploadPhase(importId, tempPartPath)
  const fileStream = fs.createReadStream(tempPartPath)

  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id, userId)
    const provisionalFile = await prisma.file.create({
      data: { userId, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType, sizeBytes: 0n, status: 'uploading' },
    })
    const providerFileId = buildS3ObjectKey(config, userId, provisionalFile.id, fileName, folderId ? providerFolderId : undefined)
    try {
      const uploadProgress = throttledProgressUpdater(importId, STAGES.UPLOADING)
      await uploadS3Object(config, providerFileId, fileStream, mimeType, {
        onProgress: (uploadedBytes) => { void uploadProgress({ uploadedBytes: uploadedBytes.toString() }) },
      })
      await prisma.remoteImport.update({ where: { id: importId }, data: { uploadedBytes: uploadTotalBytes } }).catch(() => undefined)
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId, status: 'active' } })
      return { providerFileId, fileId: provisionalFile.id }
    } catch (error) {
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      throw error
    }
  }

  if (account.provider === 'telegram') {
    const config = await getTelegramConfig(account.id, userId)
    const uploadProgress = throttledProgressUpdater(importId, STAGES.UPLOADING)
    const provisionalFile = await prisma.file.create({
      data: { userId, connectedAccountId: account.id, folderId, provider: 'telegram', providerFileId: 'pending', name: fileName, mimeType, sizeBytes: uploadTotalBytes, status: 'uploading' },
    })
    try {
      const stableId = provisionalFile.id
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { telegramStableId: stableId } })
      const logicalPath = await logicalPathForFileId(userId, provisionalFile.id)
      const uploaded = await uploadTelegramDocumentWithCrypto({
        config,
        filePath: tempPartPath,
        fileName,
        mimeType,
        sizeBytes: Number(uploadTotalBytes),
        userId,
        fileId: stableId,
        logicalPath,
        onProgress: (pct) => { void uploadProgress({ uploadedBytes: BigInt(Math.round((pct / 100) * Number(uploadTotalBytes))).toString() }) },
      })
      await prisma.file.update({ where: { id: provisionalFile.id, }, data: { ...buildTelegramMetadataCache({ fileId: stableId, name: fileName, path: logicalPath, mimeType, size: uploadTotalBytes }) } })
      await prisma.remoteImport.update({ where: { id: importId }, data: { uploadedBytes: uploadTotalBytes } }).catch(() => undefined)
      return { providerFileId: uploaded.remoteId, fileId: provisionalFile.id }
    } catch (error) {
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      throw error
    }
  }

  const uploadProgress = throttledProgressUpdater(importId, STAGES.UPLOADING)
  const uploaded = await uploadToGoogleResumable(importId, account.id, userId, fileName, mimeType, tempPartPath, providerFolderId, (bytes) => {
    void uploadProgress({ uploadedBytes: bytes.toString() })
  })
  return { providerFileId: uploaded.providerFileId, fileId: null }
}

type RegisterInput = {
  importId: string
  remoteImport: {
    userId: string
    folderId: string | null
    connectedAccountId: string | null
    fileName: string
    mimeType: string | null
  }
  providerFileId: string
  sizeBytes: bigint
  existingFileId?: string
  updateStage: (stage: typeof STAGES.REGISTERING) => Promise<void>
}

async function registerFileCore(input: RegisterInput) {
  const { importId, remoteImport, providerFileId, sizeBytes, existingFileId } = input
  const accountId = remoteImport.connectedAccountId
  if (!accountId) throw new Error('Missing connected account for file registration.')
  const provider = (await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })).provider
  const existing = await prisma.file.findFirst({ where: { userId: remoteImport.userId, provider, providerFileId } })
  if (existing) return existing
  if (existingFileId) {
    const updated = await prisma.file.update({ where: { id: existingFileId, userId: remoteImport.userId }, data: { providerFileId, sizeBytes, status: 'active' } })
    await createAuditLog(remoteImport.userId, 'IMPORT_FILE', 'file', updated.id, { name: updated.name, size: updated.sizeBytes.toString() })
    return updated
  }
  const created = await prisma.file.create({
    data: {
      userId: remoteImport.userId,
      connectedAccountId: accountId,
      folderId: remoteImport.folderId,
      provider,
      providerFileId,
      name: remoteImport.fileName,
      mimeType: remoteImport.mimeType ?? 'application/octet-stream',
      sizeBytes,
      status: 'active',
    },
  })
  await createAuditLog(remoteImport.userId, 'IMPORT_FILE', 'file', created.id, { name: created.name, size: created.sizeBytes.toString() })
  return created
}

export async function registerImportedFile(input: {
  context: RemoteImportProcessorContext
  providerFileId: string
  sizeBytes: bigint
  existingFileId?: string
}) {
  await input.context.updateStage(STAGES.REGISTERING)
  return registerFileCore({
    importId: input.context.importId,
    remoteImport: input.context.record as any,
    providerFileId: input.providerFileId,
    sizeBytes: input.sizeBytes,
    existingFileId: input.existingFileId,
    updateStage: input.context.updateStage,
  })
}

/** Compatibility wrapper for processor tests and callers during extraction. */
export async function registerFile(
  importId: string,
  remoteImport: RegisterInput['remoteImport'],
  providerFileId: string,
  sizeBytes: bigint,
  options: { existingFileId?: string } = {},
) {
  await updateStage(importId, STAGES.REGISTERING)
  return registerFileCore({ importId, remoteImport, providerFileId, sizeBytes, existingFileId: options.existingFileId, updateStage: (stage) => updateStage(importId, stage) })
}

export type ContinuePartInput = {
  context: RemoteImportProcessorContext
  sourceUrl: string
  tempPartPath: string
  contentLength: bigint | null
}

/** Complete the shared direct-import placement, upload, and registration tail. */
export async function continueFromPart(input: ContinuePartInput): Promise<void> {
  const { context, sourceUrl, tempPartPath, contentLength } = input
  const record = context.record

  await context.updateStage(STAGES.SELECTING_STORAGE)
  let placement
  try {
    placement = await resolveUploadPlacement(context.userId, context.folderId, record.connectedAccountId, contentLength ?? 0n, undefined, 'remote-import')
  } catch (error: any) {
    // A reauth failure is terminal for this attempt but deliberately leaves the
    // local part available to the upload-resume retry path.
    if (error?.code === 'GOOGLE_REAUTH_REQUIRED') {
      await context.markFailed('GOOGLE_REAUTH_REQUIRED', 'Google Drive authorization expired. Reconnect the account, then retry.')
      const marker = new AppError('__PLACEMENT_REAUTH__', '', 0)
      ;(marker as { placementFinalized?: boolean }).placementFinalized = true
      throw marker
    }
    if (error?.code === 'TELEGRAM_SESSION_INVALID') {
      await context.markFailed('TELEGRAM_SESSION_INVALID', 'Telegram authorization expired. Reconnect the account, then retry.')
      const marker = new AppError('__PLACEMENT_REAUTH__', '', 0)
      ;(marker as { placementFinalized?: boolean }).placementFinalized = true
      throw marker
    }
    const code = error?.code === 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' ? 'NO_ACCOUNT_WITH_ENOUGH_SPACE' : (error?.code ?? 'IMPORT_FAILED')
    await context.markFailed(code, error?.message ?? 'No connected storage account has enough space.')
    const marker = new AppError('__PLACEMENT_FINALIZED__', '', 0)
    ;(marker as { placementFinalized?: boolean }).placementFinalized = true
    throw marker
  }

  const account = placement.connectedAccount
  context.assertWithinTimeout()
  console.debug(`[remote-import:filename] stage=upload canonical=${context.fileName}`)
  const uploaded = await uploadTempFile(
    context.importId,
    { id: account.id, provider: account.provider },
    context.userId,
    context.folderId,
    context.fileName,
    context.mimeType,
    tempPartPath,
    placement.folderStorageLocation.providerFolderId,
  )

  context.assertWithinTimeout()
  await context.updateStage(STAGES.REGISTERING)
  const sizeBytes = contentLength ?? (await fsp.stat(tempPartPath)).size
  const file = await registerFile(
    context.importId,
    {
      userId: context.userId,
      folderId: context.folderId,
      connectedAccountId: account.id,
      fileName: context.fileName,
      mimeType: context.mimeType,
    },
    uploaded.providerFileId,
    BigInt(sizeBytes),
    { existingFileId: uploaded.fileId ?? undefined },
  )

  const totalSize = BigInt(sizeBytes)
  await prisma.remoteImport.update({
    where: { id: context.importId },
    data: {
      status: 'completed',
      stage: STAGES.FINISHED,
      fileId: file.id,
      completedAt: new Date(),
      downloadedBytes: totalSize,
      uploadedBytes: totalSize,
      uploadTotalBytes: totalSize,
      tempPath: null,
      finalUrlEncrypted: encryptText(sourceUrl),
    },
  })
  context.logProgress(STAGES.FINISHED, 'import completed')

  if (account.provider === 's3') syncS3Quota(account.id).catch(() => undefined)
  else if (account.provider === 'telegram') syncTelegramUsage(account.id).catch(() => undefined)
  else syncGoogleQuota(account.id).catch(() => undefined)
}
