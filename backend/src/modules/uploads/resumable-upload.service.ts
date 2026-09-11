import { google } from 'googleapis'
import { z } from 'zod'
import type { AuthRequest } from '../../middleware/auth.middleware.js'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { resolveUploadParent } from '../storage/provider-folder.service.js'
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'
import { planBatchUploads } from './storage-routing.service.js'
import { directS3UploadedBytes } from './direct-s3-upload.service.js'
import { appendStagedChunk, removeStagedFile, stagedBytes, stagedUploadPath } from './upload-temp-files.js'
import { finalizeStagedUpload, syncQuotaInBackground } from './upload-provider.service.js'
import { logUpload } from './upload-logging.js'

export type ResumableHttpResult = {
  status: number
  body: Record<string, unknown>
}

const initSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.string(),
  folderId: z.string().nullable().optional(),
  targetAccountId: z.string().nullable().optional(),
})

const preflightSchema = z.object({
  files: z.array(z.object({
    fileName: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.string(),
  })).min(1).max(50),
  targetAccountId: z.string().nullable().optional(),
})

function userId(req: AuthRequest) {
  return req.user!.id
}

export async function initResumableUpload(req: AuthRequest): Promise<ResumableHttpResult> {
  const body = initSchema.parse(req.body)
  const sizeBytes = BigInt(body.sizeBytes)
  if (sizeBytes <= 0n) return { status: 400, body: { code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' } }
  if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return { status: 400, body: { code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' } }

  const folderId = body.folderId || null
  let placement
  try {
    placement = await resolveUploadPlacement(userId(req), folderId, body.targetAccountId, sizeBytes, new Map<string, bigint>(), 'resumable')
  } catch (error: any) {
    const code = error?.code === 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' ? 'NO_ACCOUNT_WITH_ENOUGH_SPACE' : (error?.code ?? 'UPLOAD_FAILED')
    return { status: 400, body: { code, message: error?.message ?? 'No connected storage account has enough space.' } }
  }
  const account = placement.connectedAccount

  if (account.provider !== 'google_drive') {
    const session = await prisma.uploadSession.create({
      data: {
        userId: userId(req),
        targetConnectedAccountId: account.id,
        folderId,
        fileName: body.fileName,
        mimeType: body.mimeType,
        sizeBytes,
        status: 'uploading',
      },
    })
    return { status: 201, body: { sessionId: session.id, provider: account.provider, offset: 0, targetAccountId: account.id, targetAccountEmail: account.email } }
  }

  const auth = await getAuthedGoogleClient(account)
  const targetParentId = resolveUploadParent(account, placement.folderStorageLocation)
  const headers = new Headers()
  const token = await auth.getAccessToken()
  headers.set('Authorization', `Bearer ${token.token}`)
  headers.set('Content-Type', 'application/json')
  headers.set('X-Upload-Content-Type', body.mimeType)
  headers.set('X-Upload-Content-Length', sizeBytes.toString())

  const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: body.fileName, parents: [targetParentId] }),
  })
  if (!initRes.ok) {
    const errText = await initRes.text()
    throw new Error(`Google API Init Error: ${errText}`)
  }
  const sessionUri = initRes.headers.get('location')
  if (!sessionUri) throw new Error('Google API did not return Location header.')

  const session = await prisma.uploadSession.create({
    data: {
      userId: userId(req),
      targetConnectedAccountId: account.id,
      folderId,
      fileName: body.fileName,
      mimeType: body.mimeType,
      sizeBytes,
      status: 'uploading',
      googleSessionUri: sessionUri,
    },
  })
  return { status: 201, body: { sessionId: session.id, provider: 'google_drive', offset: 0, targetAccountId: account.id, targetAccountEmail: account.email } }
}

export async function preflightResumableUpload(req: AuthRequest): Promise<ResumableHttpResult> {
  const body = preflightSchema.parse(req.body)
  const files: Array<{ fileName: string; mimeType: string; sizeBytes: bigint }> = []
  for (const file of body.files) {
    let sizeBytes: bigint
    try {
      sizeBytes = BigInt(file.sizeBytes)
    } catch {
      return { status: 400, body: { code: 'INVALID_SIZE_BYTES', message: 'Valid sizeBytes required.' } }
    }
    if (sizeBytes <= 0n) return { status: 400, body: { code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' } }
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return { status: 400, body: { code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' } }
    files.push({ fileName: file.fileName, mimeType: file.mimeType, sizeBytes })
  }

  const result = await planBatchUploads(userId(req), files, body.targetAccountId)
  return {
    status: 200,
    body: {
      plans: result.plans,
      totalBytes: result.totalBytes.toString(),
      totalRoutedBytes: result.totalRoutedBytes.toString(),
      unroutedBytes: result.unroutedBytes.toString(),
    },
  }
}

export async function getResumableStatus(req: AuthRequest): Promise<ResumableHttpResult> {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: userId(req) },
    })
    if (session.status === 'completed') return { status: 200, body: { status: 'completed', offset: session.sizeBytes.toString() } }

    if (session.status === 'direct_s3_uploading' || session.status === 'aborted') {
      const uploadedBytes = await directS3UploadedBytes(userId(req), session.id)
      const uploading = session.status === 'direct_s3_uploading'
      return {
        status: 200,
        body: {
          status: uploading ? 'uploading' : 'failed',
          offset: (uploadedBytes ?? 0n).toString(),
          ...(uploading && session.s3UploadExpiresAt ? { expiresAt: session.s3UploadExpiresAt.toISOString() } : {}),
        },
      }
    }

    if (!session.targetConnectedAccountId) return { status: 200, body: { status: 'uploading', offset: '0' } }
    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: userId(req) },
    })
    if (account.provider !== 'google_drive') {
      return { status: 200, body: { status: 'uploading', offset: (await stagedBytes(env.UPLOAD_TEMP_DIR, session.id)).toString() } }
    }
    if (!session.googleSessionUri) return { status: 200, body: { status: 'uploading', offset: '0' } }

    const auth = await getAuthedGoogleClient(account)
    const token = await auth.getAccessToken()
    const queryHeaders = new Headers()
    queryHeaders.set('Authorization', `Bearer ${token.token}`)
    queryHeaders.set('Content-Range', `bytes */${session.sizeBytes}`)
    const queryRes = await fetch(session.googleSessionUri, { method: 'PUT', headers: queryHeaders })
    if (queryRes.status === 308) {
      const range = queryRes.headers.get('range')
      if (range) {
        const parts = range.split('-')
        const lastByte = BigInt(parts[1])
        return { status: 200, body: { status: 'uploading', offset: (lastByte + 1n).toString() } }
      }
    } else if (queryRes.ok) {
      return { status: 200, body: { status: 'completed', offset: session.sizeBytes.toString() } }
    }
    return { status: 200, body: { status: 'uploading', offset: '0' } }
  } catch {
    return { status: 200, body: { status: 'failed', offset: '0' } }
  }
}

export async function uploadResumableChunk(req: AuthRequest): Promise<ResumableHttpResult> {
  const session = await prisma.uploadSession.findFirstOrThrow({
    where: { id: String(req.params.id), userId: userId(req) },
  })
  const rangeHeader = req.headers['content-range']
  if (!rangeHeader || typeof rangeHeader !== 'string') return { status: 400, body: { code: 'MISSING_CONTENT_RANGE', message: 'Content-Range header is required.' } }
  const match = rangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/)
  if (!match) return { status: 400, body: { code: 'INVALID_CONTENT_RANGE', message: 'Invalid Content-Range format.' } }

  const startByte = BigInt(match[1])
  const endByte = BigInt(match[2])
  const totalBytes = BigInt(match[3])
  if (!session.targetConnectedAccountId) return { status: 400, body: { code: 'UNSUPPORTED_PROVIDER', message: 'No target account for this upload session.' } }

  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: session.targetConnectedAccountId, userId: userId(req) },
  })
  if (account.provider !== 'google_drive') {
    const stagedBefore = await stagedBytes(env.UPLOAD_TEMP_DIR, session.id)
    if (stagedBefore > startByte) return { status: 200, body: { status: 'uploading', offset: stagedBefore.toString() } }
    if (stagedBefore < startByte) {
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Chunk range starts past the staged offset.' } }).catch(() => undefined)
      await removeStagedFile(env.UPLOAD_TEMP_DIR, session.id)
      return { status: 409, body: { code: 'UPLOAD_OFFSET_MISMATCH', message: 'The staged file is behind the requested chunk range. Restart the upload.' } }
    }
    await appendStagedChunk(env.UPLOAD_TEMP_DIR, session.id, req)
    const stagedAfter = await stagedBytes(env.UPLOAD_TEMP_DIR, session.id)
    if (stagedAfter !== endByte + 1n) {
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Staged byte count did not match the chunk range.' } }).catch(() => undefined)
      await removeStagedFile(env.UPLOAD_TEMP_DIR, session.id)
      return { status: 400, body: { code: 'UPLOAD_SIZE_MISMATCH', message: 'Staged byte count did not match the chunk range.' } }
    }
    if (endByte + 1n < totalBytes) return { status: 200, body: { status: 'uploading', offset: (endByte + 1n).toString() } }

    let uploadedFile
    try {
      const finalized = await finalizeStagedUpload({
        userId: userId(req),
        account,
        folderId: session.folderId,
        fileName: session.fileName,
        mimeType: session.mimeType,
        sizeBytes: totalBytes,
        tmpPath: stagedUploadPath(env.UPLOAD_TEMP_DIR, session.id),
      })
      uploadedFile = finalized.file
    } catch (error: any) {
      await removeStagedFile(env.UPLOAD_TEMP_DIR, session.id)
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: error?.message ?? 'Provider upload failed.' } }).catch(() => undefined)
      logUpload('non-google resumable finalize failed', { sessionId: session.id, accountId: account.id, message: error?.message ?? 'Unknown error' })
      return { status: 502, body: { code: 'UPLOAD_FAILED', message: error?.message ?? 'Provider upload failed.' } }
    }
    await removeStagedFile(env.UPLOAD_TEMP_DIR, session.id)
    await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
    await createAuditLog(userId(req), 'UPLOAD_FILE', 'file', uploadedFile.id, { name: uploadedFile.name, size: uploadedFile.sizeBytes.toString() })
    syncQuotaInBackground(account.id, session.id, account.provider)
    logUpload('non-google resumable upload completed', { sessionId: session.id, accountId: account.id, fileName: uploadedFile.name })
    return { status: 201, body: { status: 'completed', file: { ...uploadedFile, sizeBytes: uploadedFile.sizeBytes.toString() } } }
  }

  if (!session.googleSessionUri) return { status: 400, body: { code: 'UNSUPPORTED_PROVIDER', message: 'Only Google Drive resumable uploads are supported for this session.' } }
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const token = await auth.getAccessToken()
  const putHeaders = new Headers()
  putHeaders.set('Authorization', `Bearer ${token.token}`)
  putHeaders.set('Content-Range', rangeHeader)
  putHeaders.set('Content-Length', (endByte - startByte + 1n).toString())
  const putRes = await fetch(session.googleSessionUri, { method: 'PUT', headers: putHeaders, body: req as any, duplex: 'half' } as any)
  if (putRes.status === 308) return { status: 200, body: { status: 'uploading', offset: (endByte + 1n).toString() } }
  if (putRes.ok) {
    const fileMeta = await putRes.json() as { id: string; name: string; mimeType: string }
    try {
      await drive.permissions.create({ fileId: fileMeta.id, requestBody: { role: 'writer', type: 'anyone' } })
    } catch (err: any) {
      console.error('Failed to make Google Drive resumable file public:', err.message || err)
    }
    let existingFile = await prisma.file.findFirst({ where: { providerFileId: fileMeta.id, userId: userId(req) } })
    if (!existingFile) {
      existingFile = await prisma.file.create({
        data: {
          userId: userId(req),
          connectedAccountId: account.id,
          folderId: session.folderId,
          provider: 'google_drive',
          providerFileId: fileMeta.id,
          name: fileMeta.name || session.fileName,
          mimeType: fileMeta.mimeType || session.mimeType,
          sizeBytes: totalBytes,
        },
      })
    }
    await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
    await createAuditLog(userId(req), 'UPLOAD_FILE', 'file', existingFile.id, { name: existingFile.name, size: existingFile.sizeBytes.toString() })
    syncQuotaInBackground(account.id, session.id, account.provider)
    return { status: 201, body: { status: 'completed', file: { ...existingFile, sizeBytes: existingFile.sizeBytes.toString() } } }
  }

  const errorMsg = await putRes.text()
  await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: errorMsg } })
  return { status: putRes.status, body: { code: 'UPLOAD_FAILED', message: errorMsg } }
}

