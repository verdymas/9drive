import Busboy from 'busboy'
import type { AuthRequest } from '../../middleware/auth.middleware.js'
import { google } from 'googleapis'
import { createReadStream, type ReadStream } from 'node:fs'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { resolveUploadParent } from '../storage/provider-folder.service.js'
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'
import { metaForMultipartFile, multipartUploadResponse, parseMultipartBatchMeta, type MultipartUploadFields, type MultipartUploadMeta } from './multipart-upload-contract.js'
import { removeMultipartTemp, spoolMultipartFile } from './upload-temp-files.js'
import { finalizeStagedUpload, syncQuotaInBackground } from './upload-provider.service.js'
import { logUpload } from './upload-logging.js'

export type MultipartUploadResult = {
  status: number
  body: Record<string, unknown>
}

type MultipartFileInfo = { filename: string; mimeType: string }
type ResponseCloseSource = { writableEnded: boolean; once: (event: 'close', listener: () => void) => unknown }

export async function processMultipartUpload(req: AuthRequest, userId: string, response?: ResponseCloseSource): Promise<MultipartUploadResult | null> {
  const busboy = Busboy({ headers: req.headers, limits: { files: 25, fileSize: env.MAX_UPLOAD_BYTES } })
  const abortController = new AbortController()
  let requestAborted = false
  const abortRequest = () => {
    requestAborted = true
    abortController.abort()
  }
  req.once('aborted', abortRequest)
  if (response) {
    response.once('close', () => {
      if (!response.writableEnded) abortRequest()
    })
  } else {
    req.once('close', () => {
      if (!req.complete) abortRequest()
    })
  }
  const fields: MultipartUploadFields = {}
  let batchMeta: MultipartUploadMeta[] | null = null
  let fileSeen = false
  const reservedBytesByAccount = new Map<string, bigint>()
  const completed: Array<Record<string, unknown>> = []
  const failed: Array<{ fileName: string; code: string; message: string }> = []
  const pendingUploads: Array<Promise<void>> = []

  const uploadOne = async (fieldName: string, fileStream: NodeJS.ReadableStream, info: MultipartFileInfo) => {
    const meta = metaForMultipartFile(batchMeta, fields, fieldName, info)
    const fileName = meta?.fileName || info.filename
    let sessionId: string | null = null
    let streamedBytes: bigint | null = null
    let uploadedFileId: string | null = null
    let persistedFileId: string | null = null
    let cleanupProvider: (() => Promise<void>) | null = null
    const uploadStartedAt = Date.now()
    let streamLimitReached = false
    const onStreamLimit = () => {
      streamLimitReached = true
      logUpload('file stream size limit reached', { fileName })
    }
    fileStream.once('limit', onStreamLimit)
    try {
      if (!meta?.sizeBytes || meta.sizeBytes <= 0n) {
        fileStream.resume()
        failed.push({ fileName, code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' })
        return
      }
      if (meta.sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
        fileStream.resume()
        failed.push({ fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
        return
      }

      const folderId = meta.folderId || null
      let placement
      try {
        placement = await resolveUploadPlacement(userId, folderId, undefined, meta.sizeBytes, reservedBytesByAccount, 'multipart')
      } catch (error: any) {
        fileStream.resume()
        failed.push({ fileName, code: error?.code === 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' ? 'NO_ACCOUNT_WITH_ENOUGH_SPACE' : (error?.code ?? 'UPLOAD_FAILED'), message: error?.message ?? 'Upload failed' })
        return
      }
      const account = placement.connectedAccount
      reservedBytesByAccount.set(account.id, (reservedBytesByAccount.get(account.id) ?? 0n) + meta.sizeBytes)

      const session = await prisma.uploadSession.create({ data: { userId, targetConnectedAccountId: account.id, folderId, fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' } })
      sessionId = session.id
      logUpload('file upload started', { sessionId: session.id, accountId: account.id, fileName, sizeBytes: meta.sizeBytes.toString() })
      const spool = await spoolMultipartFile(env.UPLOAD_TEMP_DIR, session.id, fileStream, abortController.signal)
      streamedBytes = spool.sizeBytes

      if (spool.limited || streamLimitReached) {
        await removeMultipartTemp(env.UPLOAD_TEMP_DIR, session.id)
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'File exceeded max upload size.' } })
        failed.push({ fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
        return
      }
      if (streamedBytes !== meta.sizeBytes) {
        await removeMultipartTemp(env.UPLOAD_TEMP_DIR, session.id)
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Streamed byte count did not match declared size.' } })
        failed.push({ fileName, code: 'UPLOAD_SIZE_MISMATCH', message: 'Streamed byte count did not match declared size.' })
        return
      }
      if (abortController.signal.aborted) throw new Error('Upload aborted by client.')

      let providerFileId = ''
      let uploadedName = fileName
      let uploadedMimeType = meta.mimeType
      let providerStream: ReadStream | null = null
      try {
        if (account.provider === 's3' || account.provider === 'telegram') {
          const finalized = await finalizeStagedUpload({
            userId,
            account,
            folderId,
            fileName,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            tmpPath: spool.path,
            signal: abortController.signal,
          })
          const uploadedFile = finalized.file
          uploadedFileId = uploadedFile.id
          providerFileId = uploadedFile.providerFileId
          cleanupProvider = finalized.cleanup
          logUpload(`${account.provider} upload completed`, { sessionId: session.id, accountId: account.id, fileName, streamedBytes: streamedBytes.toString(), durationMs: Date.now() - uploadStartedAt })
        } else {
          const auth = await getAuthedGoogleClient(account)
          const drive = google.drive({ version: 'v3', auth })
          const targetParentId = resolveUploadParent(account, placement.folderStorageLocation)
          providerStream = createReadStream(spool.path)
          providerStream.once('error', () => undefined)
          const abortGoogleStream = () => providerStream?.destroy(new Error('Upload aborted by client.'))
          abortController.signal.addEventListener('abort', abortGoogleStream, { once: true })
          const uploaded = await drive.files.create({
            requestBody: { name: fileName, parents: [targetParentId] },
            media: { mimeType: meta.mimeType, body: providerStream },
            fields: 'id,name,mimeType,size',
          }, { signal: abortController.signal })
          abortController.signal.removeEventListener('abort', abortGoogleStream)
          providerFileId = uploaded.data.id ?? ''
          uploadedName = uploaded.data.name ?? fileName
          uploadedMimeType = uploaded.data.mimeType ?? meta.mimeType
          cleanupProvider = async () => {
            if (providerFileId) await drive.files.delete({ fileId: providerFileId })
          }
          if (abortController.signal.aborted) throw new Error('Upload aborted by client.')
          logUpload('google upload completed', { sessionId: session.id, accountId: account.id, fileName, streamedBytes: streamedBytes.toString(), durationMs: Date.now() - uploadStartedAt })
          try {
            await drive.permissions.create({ fileId: providerFileId, requestBody: { role: 'writer', type: 'anyone' } })
            logUpload('google file permissions set to public writer', { sessionId: session.id, providerFileId })
          } catch (err: any) {
            console.error('Failed to make Google Drive file public:', err.message || err)
          }
        }
      } finally {
        providerStream?.destroy()
        await removeMultipartTemp(env.UPLOAD_TEMP_DIR, session.id)
      }

      if (abortController.signal.aborted) throw new Error('Upload aborted by client.')
      const file = account.provider === 'google_drive'
        ? await prisma.file.create({ data: { userId, connectedAccountId: account.id, folderId, provider: 'google_drive', providerFileId, name: uploadedName, mimeType: uploadedMimeType, sizeBytes: meta.sizeBytes } })
        : uploadedFileId
          ? await prisma.file.findUniqueOrThrow({ where: { id: uploadedFileId } })
          : null
      if (file) {
        persistedFileId = file.id
        logUpload('database file created', { sessionId: session.id, fileId: file.id, accountId: account.id })
      }
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
      if (file) completed.push({ ...file, sizeBytes: file.sizeBytes.toString() })
      if (!abortController.signal.aborted) syncQuotaInBackground(account.id, session.id, account.provider)
    } catch (error) {
      fileStream.resume()
      if (cleanupProvider) await cleanupProvider().catch(() => undefined)
      if (persistedFileId ?? uploadedFileId) {
        await prisma.file.update({ where: { id: persistedFileId ?? uploadedFileId! }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      }
      if (sessionId) await prisma.uploadSession.update({ where: { id: sessionId }, data: { status: 'failed', errorMessage: error instanceof Error ? error.message : 'Upload failed' } }).catch(() => undefined)
      logUpload('file upload failed', { fileName, sessionId, streamedBytes: streamedBytes?.toString(), durationMs: Date.now() - uploadStartedAt, aborted: abortController.signal.aborted, message: error instanceof Error ? error.message : 'Upload failed' })
      if (abortController.signal.aborted) return
      failed.push({ fileName, code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Upload failed' })
    } finally {
      fileStream.removeListener('limit', onStreamLimit)
    }
  }

  return new Promise<MultipartUploadResult | null>((resolve, reject) => {
    let settled = false
    const finish = (result: MultipartUploadResult | null) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    busboy.on('field', (name, value) => {
      if (name === 'sizeBytes') fields.sizeBytes = BigInt(value)
      if (name === 'fileName') fields.fileName = value
      if (name === 'mimeType') fields.mimeType = value
      if (name === 'folderId') fields.folderId = value
      if (name === 'filesMeta') batchMeta = parseMultipartBatchMeta(value)
    })
    busboy.on('file', (name, fileStream, info) => {
      fileSeen = true
      pendingUploads.push(uploadOne(name, fileStream, info))
    })
    busboy.on('error', (error) => {
      abortRequest()
      logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' })
      fail(error)
    })
    busboy.on('finish', () => {
      if (!fileSeen) {
        req.unpipe(busboy)
        req.resume()
        finish({ status: 400, body: { code: 'UPLOAD_FILE_REQUIRED', message: 'file field required.' } })
        return
      }
      Promise.all(pendingUploads).then(() => {
        if (requestAborted) {
          finish(null)
          return
        }
        logUpload('response sent', { mode: 'multipart', batch: Boolean(batchMeta), completed: completed.length, failed: failed.length })
        const response = multipartUploadResponse(batchMeta, completed, failed)
        finish({ status: response.status, body: response.body })
      }).catch(fail)
    })

    try {
      req.pipe(busboy)
    } catch (error) {
      fail(error)
    }
  })
}
