import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { abortS3MultipartUpload, buildS3ObjectKey, completeS3MultipartUpload, createS3MultipartUpload, getS3ConfigForAccount, listS3MultipartParts, syncS3Quota, uploadS3MultipartPart } from '../s3/s3.service.js'
import { getStreamThroughEligibility, readVerifiedRange } from './stream-through.js'
import { uploadGoogleResumableStream, type GoogleStreamUploadState } from './google-resumable-uploader.js'
import { STAGES, type ProcessorRecord, type RemoteImportProcessorContext } from './processor-context.js'
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'

export type RegisterImportedFile = (
  importId: string,
  remoteImport: ProcessorRecord,
  providerFileId: string,
  sizeBytes: bigint,
  options?: { existingFileId?: string },
) => Promise<Record<string, any>>

export type DirectPhaseInput<TRecord extends ProcessorRecord = ProcessorRecord> = {
  context: RemoteImportProcessorContext<TRecord>
  fetcher: { fetch(input: any): Promise<any> }
  registerFile: RegisterImportedFile
  sourceUrl: string
  contentLength: bigint | null
  sourceRangeSupported: boolean
}

export type S3StreamUploadState = {
  provider: 's3'
  uploadId: string
  key: string
  fileId: string
  parts: Array<{ partNumber: number; eTag: string; size: string }>
}

export function readGoogleStreamState(encrypted: string | null | undefined): GoogleStreamUploadState | null {
  if (!encrypted) return null
  try {
    const parsed = JSON.parse(decryptText(encrypted)) as GoogleStreamUploadState
    if (parsed.provider !== 'google_drive' || typeof parsed.sessionUri !== 'string' || !/^\d+$/.test(parsed.nextOffset)) return null
    return parsed
  } catch {
    return null
  }
}

export function readS3StreamState(encrypted: string | null | undefined): S3StreamUploadState | null {
  if (!encrypted) return null
  try {
    const state = JSON.parse(decryptText(encrypted)) as S3StreamUploadState
    if (state.provider !== 's3' || !state.uploadId || !state.key || !state.fileId || !Array.isArray(state.parts)) return null
    return state
  } catch {
    return null
  }
}

/** Try the bounded-range Google stream-through path; false selects temp storage. */
export async function tryGoogleStreamThrough<TRecord extends ProcessorRecord>(input: DirectPhaseInput<TRecord>): Promise<boolean> {
  const { context } = input
  const { sourceUrl, contentLength, sourceRangeSupported } = input
  if (contentLength == null || !sourceRangeSupported) return false
  await context.updateStage(STAGES.SELECTING_STORAGE)
  const placement = await resolveUploadPlacement(context.userId, context.folderId, context.record.connectedAccountId, contentLength, undefined, 'remote-import')
  const account = placement.connectedAccount
  const eligibility = getStreamThroughEligibility({
    sourceType: context.record.sourceType,
    sourceRangeSupported,
    contentLength,
    provider: account.provider,
  })
  if (!eligibility.eligible || account.provider !== 'google_drive') return false

  await context.updateStage(STAGES.UPLOADING, { uploadTotalBytes: contentLength, uploadedBytes: 0 })
  const progress = context.throttledProgressUpdater(STAGES.UPLOADING)
  const uploaded = await uploadGoogleResumableStream({
    accountId: account.id,
    fileName: context.fileName,
    mimeType: context.mimeType,
    parentProviderFolderId: placement.folderStorageLocation.providerFolderId,
    totalBytes: contentLength,
    chunkBytes: BigInt(env.REMOTE_IMPORT_STREAM_THROUGH_CHUNK_BYTES),
    state: readGoogleStreamState(context.record.streamUploadStateEncrypted),
    readChunk: (offset, length) => readVerifiedRange(input.fetcher as any, sourceUrl, offset, length, contentLength, context.requestContext),
    assertNotCancelled: () => context.assertNotCancelled(),
    saveState: async (state) => {
      await prisma.remoteImport.update({ where: { id: context.importId }, data: { streamUploadStateEncrypted: encryptText(JSON.stringify(state)) } })
    },
    onProgress: (uploadedBytes) => { void progress({ uploadedBytes: uploadedBytes.toString(), downloadedBytes: uploadedBytes.toString() }) },
  })
  const file = await input.registerFile(context.importId, { ...context.record, connectedAccountId: account.id }, uploaded.providerFileId, contentLength)
  await prisma.remoteImport.update({
    where: { id: context.importId },
    data: {
      status: 'completed', stage: STAGES.FINISHED, fileId: file.id, completedAt: new Date(),
      downloadedBytes: contentLength, uploadedBytes: contentLength, uploadTotalBytes: contentLength,
      streamUploadStateEncrypted: null, tempPath: null, finalUrlEncrypted: encryptText(sourceUrl),
    },
  })
  syncGoogleQuota(account.id).catch(() => undefined)
  return true
}

/** Try the bounded-range S3 multipart stream-through path; false selects temp storage. */
export async function tryS3StreamThrough<TRecord extends ProcessorRecord>(input: DirectPhaseInput<TRecord>): Promise<boolean> {
  const { context } = input
  const { sourceUrl, contentLength, sourceRangeSupported } = input
  if (contentLength == null || !sourceRangeSupported) return false
  await context.updateStage(STAGES.SELECTING_STORAGE)
  const placement = await resolveUploadPlacement(context.userId, context.folderId, context.record.connectedAccountId, contentLength, undefined, 'remote-import')
  const account = placement.connectedAccount
  const eligibility = getStreamThroughEligibility({ sourceType: context.record.sourceType, sourceRangeSupported, contentLength, provider: account.provider })
  if (!eligibility.eligible || account.provider !== 's3') return false

  const config = await getS3ConfigForAccount(account.id, context.userId)
  let state = readS3StreamState(context.record.streamUploadStateEncrypted)
  if (!state) {
    const provisional = await prisma.file.create({
      data: { userId: context.userId, connectedAccountId: account.id, folderId: context.folderId, provider: 's3', providerFileId: 'pending', name: context.fileName, mimeType: context.mimeType, sizeBytes: 0n, status: 'uploading' },
    })
    const key = buildS3ObjectKey(config, context.userId, provisional.id, context.fileName, context.folderId ? placement.folderStorageLocation.providerFolderId : undefined)
    state = { provider: 's3', uploadId: await createS3MultipartUpload(config, key, context.mimeType), key, fileId: provisional.id, parts: [] }
  } else {
    const parts = await listS3MultipartParts(config, state.key, state.uploadId)
    state.parts = parts.map((part) => ({ partNumber: part.partNumber, eTag: part.eTag ?? '', size: part.size.toString() })).filter((part) => Boolean(part.eTag))
  }
  const saveState = async () => prisma.remoteImport.update({ where: { id: context.importId }, data: { streamUploadStateEncrypted: encryptText(JSON.stringify(state)) } })
  await saveState()
  await context.updateStage(STAGES.UPLOADING, { uploadTotalBytes: contentLength, uploadedBytes: 0 })
  let offset = state.parts.reduce((sum, part) => sum + BigInt(part.size), 0n)
  let partNumber = state.parts.length + 1
  const progress = context.throttledProgressUpdater(STAGES.UPLOADING)
  try {
    while (offset < contentLength) {
      await context.assertNotCancelled()
      const chunkBytes = BigInt(env.REMOTE_IMPORT_STREAM_THROUGH_CHUNK_BYTES)
      const length = contentLength - offset > chunkBytes ? chunkBytes : contentLength - offset
      const chunk = await readVerifiedRange(input.fetcher as any, sourceUrl, offset, length, contentLength, context.requestContext)
      const eTag = await uploadS3MultipartPart(config, state.key, state.uploadId, partNumber, chunk)
      state.parts.push({ partNumber, eTag, size: length.toString() })
      offset += length
      partNumber += 1
      await saveState()
      await progress({ downloadedBytes: offset.toString(), uploadedBytes: offset.toString() })
      await context.assertNotCancelled()
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'ABORTED') {
      await abortS3MultipartUpload(config, state.key, state.uploadId).catch(() => undefined)
      await prisma.file.update({ where: { id: state.fileId }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      await prisma.remoteImport.update({ where: { id: context.importId }, data: { streamUploadStateEncrypted: null } }).catch(() => undefined)
    }
    throw error
  }
  await completeS3MultipartUpload(config, state.key, state.uploadId, state.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.eTag })))
  const file = await input.registerFile(context.importId, { ...context.record, connectedAccountId: account.id }, state.key, contentLength, { existingFileId: state.fileId })
  await prisma.remoteImport.update({
    where: { id: context.importId },
    data: { status: 'completed', stage: STAGES.FINISHED, fileId: file.id, completedAt: new Date(), downloadedBytes: contentLength, uploadedBytes: contentLength, uploadTotalBytes: contentLength, streamUploadStateEncrypted: null, tempPath: null, finalUrlEncrypted: encryptText(sourceUrl) },
  })
  syncS3Quota(account.id).catch(() => undefined)
  return true
}
