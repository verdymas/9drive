import Busboy from 'busboy'
import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, stat, unlink } from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'
import { z } from 'zod'
import { google } from 'googleapis'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { getTelegramConfig, uploadTelegramDocument } from '../telegram/telegram.service.js'
import { syncTelegramUsage } from '../telegram/telegram-usage.service.js'
import { createAuditLog } from '../../utils/audit.js'
import { planBatchUploads } from './storage-routing.service.js'
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'
import { resolveUploadParent } from '../storage/provider-folder.service.js'

export const uploadRouter = Router()

type UploadMeta = { fieldName: string; fileName: string; mimeType: string; sizeBytes: bigint; folderId?: string }

function logUpload(message: string, metadata?: Record<string, unknown>) {
  console.info('[upload]', message, metadata ?? '')
}

/**
 * The S3 object-key prefix for a folder location: the location's
 * `providerFolderId` is the full virtual path (e.g. `9drive/Movies`).
 * `buildS3ObjectKey` strips the account root and appends `/userId/fileId/name`.
 */
function folderPrefixFor(config: { prefix: string }, providerFolderId: string) {
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

/**
 * Finalize a staged non-Google resumable upload (S3 or Telegram) into a
 * provider object + an active File row. The temp file is committed only after
 * the provider upload succeeds; provisional rows are soft-deleted on failure.
 */
async function finalizeNonGoogleUpload(opts: {
  userId: string
  account: { id: string; provider: string }
  folderId: string | null
  fileName: string
  mimeType: string
  sizeBytes: bigint
  tmpPath: string
}) {
  const { userId, account, folderId, fileName, mimeType, sizeBytes, tmpPath } = opts
  const providerFolderId = await resolveProviderRootOrLocation(userId, folderId, account)

  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id, userId)
    const provisionalFile = await prisma.file.create({
      data: { userId, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType, sizeBytes, status: 'uploading' },
    })
    try {
      const key = buildS3ObjectKey(config, userId, provisionalFile.id, fileName, folderId ? folderPrefixFor(config, providerFolderId) : undefined)
      await uploadS3Object(config, key, createReadStream(tmpPath), mimeType)
      return await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId: key, status: 'active' } })
    } catch (error) {
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      throw error
    }
  }

  if (account.provider === 'telegram') {
    const config = await getTelegramConfig(account.id, userId)
    const provisionalFile = await prisma.file.create({
      data: { userId, connectedAccountId: account.id, folderId, provider: 'telegram', providerFileId: 'pending', name: fileName, mimeType, sizeBytes, status: 'uploading' },
    })
    try {
      const remoteId = await uploadTelegramDocument(config, { filePath: tmpPath, name: fileName, mimeType, sizeBytes: Number(sizeBytes) })
      return await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId: remoteId, status: 'active' } })
    } catch (error) {
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      throw error
    }
  }

  throw new Error(`finalizeNonGoogleUpload called for unsupported provider "${account.provider}"`)
}

function syncQuotaInBackground(accountId: string, sessionId: string, provider?: string) {
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

/**
 * Non-Google (S3 / Telegram) uploads stage chunks to a temp file during the
 * resumable flow, then commit to the provider at completion. The temp file
 * lives under `UPLOAD_TEMP_DIR`, keyed by the upload session id.
 */

/** Path of the staged temp file for a non-Google resumable upload session. */
function tempUploadPath(sessionId: string) {
  return path.join(env.UPLOAD_TEMP_DIR, `${sessionId}.part`)
}

/** Bytes staged so far for a non-Google resumable upload (0 when absent). */
async function stagedBytes(sessionId: string): Promise<bigint> {
  try {
    const info = await stat(tempUploadPath(sessionId))
    return BigInt(info.size)
  } catch {
    return 0n
  }
}

/** Append an incoming chunk stream to the session's staged temp file. */
async function appendChunk(sessionId: string, stream: NodeJS.ReadableStream): Promise<void> {
  await mkdir(env.UPLOAD_TEMP_DIR, { recursive: true })
  const filePath = tempUploadPath(sessionId)
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(filePath, { flags: 'a' })
    stream.pipe(out)
    out.on('finish', resolve)
    out.on('error', reject)
    stream.on('error', reject)
  })
}

/** Delete a session's staged temp file (best-effort). */
async function removeStagedFile(sessionId: string) {
  await unlink(tempUploadPath(sessionId)).catch(() => undefined)
}

/** Write a fully-buffered multipart file to a temp path (Telegram upload source). */
async function writeBufferToTemp(sessionId: string, buffer: Buffer): Promise<string> {
  await mkdir(env.UPLOAD_TEMP_DIR, { recursive: true })
  const filePath = path.join(env.UPLOAD_TEMP_DIR, `${sessionId}.multi`)
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(filePath)
    out.on('finish', resolve)
    out.on('error', reject)
    out.end(buffer)
  })
  return filePath
}

export async function handleUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    logUpload('request started', { userId: req.user!.id, contentLength: req.headers['content-length'] })
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })

    const busboy = Busboy({ headers: req.headers, limits: { files: 25, fileSize: env.MAX_UPLOAD_BYTES } })
    const fields: { sizeBytes?: bigint; fileName?: string; mimeType?: string; folderId?: string } = {}
    let batchMeta: UploadMeta[] | null = null
    let responded = false
    let fileSeen = false
    const reservedBytesByAccount = new Map<string, bigint>()
    const completed: Array<Record<string, unknown>> = []
    const failed: Array<{ fileName: string; code: string; message: string }> = []
    const pendingUploads: Array<Promise<void>> = []

    const fail = async (status: number, code: string, message: string) => {
      if (responded) return
      responded = true
      req.unpipe(busboy)
      req.resume()
      return res.status(status).json({ code, message })
    }

    const parseBatchMeta = (value: string) => JSON.parse(value).map((item: { fieldName: string; fileName: string; mimeType: string; sizeBytes: string | number; folderId?: string }) => ({
      fieldName: item.fieldName,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: BigInt(item.sizeBytes),
      folderId: item.folderId,
    })) as UploadMeta[]

    const metaForFile = (fieldName: string, info: { filename: string; mimeType: string }) => {
      if (batchMeta) return batchMeta.find((item) => item.fieldName === fieldName)
      const sizeBytes = fields.sizeBytes
      if (!sizeBytes) return null
      return { fieldName, sizeBytes, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType || 'application/octet-stream', folderId: fields.folderId }
    }

    const uploadOne = async (fieldName: string, fileStream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const meta = metaForFile(fieldName, info)
      const fileName = meta?.fileName || info.filename
      try {
        fileStream.on('limit', () => logUpload('file stream size limit reached', { fileName }))
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

        // Placement: manual pin (multipart has none) or Automatic routing with
        // the destination folder's existing locations as a soft preference.
        let placement
        try {
          placement = await resolveUploadPlacement(req.user!.id, folderId, undefined, meta.sizeBytes, reservedBytesByAccount, 'multipart')
        } catch (error: any) {
          fileStream.resume()
          failed.push({ fileName, code: error?.code === 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' ? 'NO_ACCOUNT_WITH_ENOUGH_SPACE' : (error?.code ?? 'UPLOAD_FAILED'), message: error?.message ?? 'Upload failed' })
          return
        }
        const account = placement.connectedAccount
        reservedBytesByAccount.set(account.id, (reservedBytesByAccount.get(account.id) ?? 0n) + meta.sizeBytes)

        const session = await prisma.uploadSession.create({ data: { userId: req.user!.id, targetConnectedAccountId: account.id, folderId, fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' } })
        logUpload('file upload started', { sessionId: session.id, accountId: account.id, fileName, sizeBytes: meta.sizeBytes.toString() })
        const chunks: Buffer[] = []
        fileStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        await new Promise<void>((resolve, reject) => {
          fileStream.on('end', resolve)
          fileStream.on('error', reject)
        })
        const fileBuffer = Buffer.concat(chunks)
        const streamedBytes = BigInt(fileBuffer.length)

        let providerFileId = ''
        let uploadedFileId: string | null = null
        let uploadedName = fileName
        let uploadedMimeType = meta.mimeType
        let tmpFilePath: string | null = null
        try {
          if (account.provider === 's3') {
            const config = await getS3ConfigForAccount(account.id, req.user!.id)
            const provisionalFile = await prisma.file.create({
              data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' },
            })
            uploadedFileId = provisionalFile.id
            providerFileId = buildS3ObjectKey(config, req.user!.id, provisionalFile.id, fileName, folderId ? folderPrefixFor(config, placement.folderStorageLocation.providerFolderId) : undefined)
            await uploadS3Object(config, providerFileId, Readable.from(fileBuffer), meta.mimeType)
            await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId, status: 'active' } })
            logUpload('s3 upload completed', { sessionId: session.id, accountId: account.id, fileName })
          } else if (account.provider === 'telegram') {
            tmpFilePath = await writeBufferToTemp(session.id, fileBuffer)
            const uploadedFile = await finalizeNonGoogleUpload({
              userId: req.user!.id,
              account,
              folderId,
              fileName,
              mimeType: meta.mimeType,
              sizeBytes: meta.sizeBytes,
              tmpPath: tmpFilePath,
            })
            uploadedFileId = uploadedFile.id
            logUpload('telegram upload completed', { sessionId: session.id, accountId: account.id, fileName })
          } else {
            const auth = await getAuthedGoogleClient(account)
            const drive = google.drive({ version: 'v3', auth })
            const targetParentId = resolveUploadParent(account, placement.folderStorageLocation)
            const uploaded = await drive.files.create({
              requestBody: { name: fileName, parents: [targetParentId] },
              media: { mimeType: meta.mimeType, body: Readable.from(fileBuffer) },
              fields: 'id,name,mimeType,size',
            })
            providerFileId = uploaded.data.id ?? ''
            uploadedName = uploaded.data.name ?? fileName
            uploadedMimeType = uploaded.data.mimeType ?? meta.mimeType
            logUpload('google upload completed', { sessionId: session.id, accountId: account.id, fileName })

            // Make the file public (anyone with link can edit/download)
            try {
              await drive.permissions.create({
                fileId: providerFileId,
                requestBody: {
                  role: 'writer',
                  type: 'anyone'
                }
              })
              logUpload('google file permissions set to public writer', { sessionId: session.id, providerFileId })
            } catch (err: any) {
              console.error('Failed to make Google Drive file public:', err.message || err)
            }
          }
        } finally {
          if (tmpFilePath) await unlink(tmpFilePath).catch(() => undefined)
        }

        if (streamedBytes !== meta.sizeBytes) {
          if (uploadedFileId) await prisma.file.update({ where: { id: uploadedFileId }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
          await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Streamed byte count did not match declared size.' } })
          failed.push({ fileName, code: 'UPLOAD_SIZE_MISMATCH', message: 'Streamed byte count did not match declared size.' })
          return
        }

        // Google creates its DB row after a successful provider upload; the S3
        // and Telegram rows were created provisionally inside the branch above
        // and flipped to `active` by the provider write.
        const file = account.provider === 'google_drive'
          ? await prisma.file.create({ data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: 'google_drive', providerFileId, name: uploadedName, mimeType: uploadedMimeType, sizeBytes: meta.sizeBytes } })
          : uploadedFileId
            ? await prisma.file.findUniqueOrThrow({ where: { id: uploadedFileId } })
            : null
        if (file) {
          logUpload('database file created', { sessionId: session.id, fileId: file.id, accountId: account.id })
          completed.push({ ...file, sizeBytes: file.sizeBytes.toString() })
        }
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
        syncQuotaInBackground(account.id, session.id, account.provider)
      } catch (error) {
        fileStream.resume()
        logUpload('file upload failed', { fileName, message: error instanceof Error ? error.message : 'Upload failed' })
        failed.push({ fileName, code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Upload failed' })
      }
    }

    busboy.on('field', (name, value) => {
      if (name === 'sizeBytes') fields.sizeBytes = BigInt(value)
      if (name === 'fileName') fields.fileName = value
      if (name === 'mimeType') fields.mimeType = value
      if (name === 'folderId') fields.folderId = value
      if (name === 'filesMeta') batchMeta = parseBatchMeta(value)
    })

    busboy.on('file', (name, fileStream, info) => {
      fileSeen = true
      pendingUploads.push(uploadOne(name, fileStream, info))
    })

    busboy.on('error', (error) => {
      logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' })
      if (!responded) {
        responded = true
        next(error)
      }
    })

    busboy.on('finish', () => {
      if (!responded && !fileSeen) return fail(400, 'UPLOAD_FILE_REQUIRED', 'file field required.')
      Promise.all(pendingUploads).then(() => {
        if (responded) return
        responded = true
        logUpload('response sent', { completed: completed.length, failed: failed.length })
        if (completed.length === 0) return res.status(400).json({ code: failed[0]?.code ?? 'UPLOAD_FAILED', message: failed[0]?.message ?? 'Upload failed', failed })
        if (!batchMeta && completed.length === 1 && failed.length === 0) return res.status(201).json({ file: completed[0] })
        return res.status(201).json({ files: completed, failed })
      }).catch(next)
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
}

uploadRouter.post('/', requireAuth, handleUpload)

// Resumable upload endpoints

// 1. Initialize resumable session
uploadRouter.post('/resumable/init', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.string(),
      folderId: z.string().nullable().optional(),
      targetAccountId: z.string().nullable().optional()
    }).parse(req.body)

    const sizeBytes = BigInt(body.sizeBytes)
    if (sizeBytes <= 0n) return res.status(400).json({ code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' })
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })

    const folderId = body.folderId || null

    // Placement: a user-chosen account pin is authoritative (no silent
    // fallback — manual selection must be respected or fail clearly); without
    // a pin, Automatic routing applies with the destination folder's existing
    // locations as a soft preference.
    let placement
    try {
      placement = await resolveUploadPlacement(req.user!.id, folderId, body.targetAccountId, sizeBytes, new Map<string, bigint>(), 'resumable')
    } catch (error: any) {
      const code = error?.code === 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' ? 'NO_ACCOUNT_WITH_ENOUGH_SPACE' : (error?.code ?? 'UPLOAD_FAILED')
      return res.status(400).json({ code, message: error?.message ?? 'No connected storage account has enough space.' })
    }
    const account = placement.connectedAccount

    if (account.provider !== 'google_drive') {
      const session = await prisma.uploadSession.create({
        data: {
          userId: req.user!.id,
          targetConnectedAccountId: account.id,
          folderId,
          fileName: body.fileName,
          mimeType: body.mimeType,
          sizeBytes,
          status: 'uploading'
        }
      })
      return res.status(201).json({ sessionId: session.id, provider: account.provider, offset: 0, targetAccountId: account.id, targetAccountEmail: account.email })
    }

    const auth = await getAuthedGoogleClient(account)
    const targetParentId = resolveUploadParent(account, placement.folderStorageLocation)

    // Initiate Google Drive Resumable Session
    const headers = new Headers()
    const token = await auth.getAccessToken()
    headers.set('Authorization', `Bearer ${token.token}`)
    headers.set('Content-Type', 'application/json')
    headers.set('X-Upload-Content-Type', body.mimeType)
    headers.set('X-Upload-Content-Length', sizeBytes.toString())

    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: body.fileName,
        parents: [targetParentId]
      })
    })

    if (!initRes.ok) {
      const errText = await initRes.text()
      throw new Error(`Google API Init Error: ${errText}`)
    }

    const sessionUri = initRes.headers.get('location')
    if (!sessionUri) throw new Error('Google API did not return Location header.')

    const session = await prisma.uploadSession.create({
      data: {
        userId: req.user!.id,
        targetConnectedAccountId: account.id,
        folderId,
        fileName: body.fileName,
        mimeType: body.mimeType,
        sizeBytes,
        status: 'uploading',
        googleSessionUri: sessionUri
      }
    })

    return res.status(201).json({ sessionId: session.id, provider: 'google_drive', offset: 0, targetAccountId: account.id, targetAccountEmail: account.email })
  } catch (error) {
    return next(error)
  }
})

// 1b. Preflight a multi-file upload batch: check available space across all
// connected Google Drive accounts and plan per-file routing with reservations,
// so a batch never dies mid-way because a single account ran out of space.
uploadRouter.post('/resumable/preflight', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      files: z.array(z.object({
        fileName: z.string().min(1),
        mimeType: z.string().min(1),
        sizeBytes: z.string()
      })).min(1).max(50),
      targetAccountId: z.string().nullable().optional()
    }).parse(req.body)

    const files: Array<{ fileName: string; mimeType: string; sizeBytes: bigint }> = []
    for (const file of body.files) {
      let sizeBytes: bigint
      try {
        sizeBytes = BigInt(file.sizeBytes)
      } catch {
        return res.status(400).json({ code: 'INVALID_SIZE_BYTES', message: 'Valid sizeBytes required.' })
      }
      if (sizeBytes <= 0n) return res.status(400).json({ code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' })
      if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
      files.push({ fileName: file.fileName, mimeType: file.mimeType, sizeBytes })
    }

    const result = await planBatchUploads(req.user!.id, files, body.targetAccountId)
    return res.json({
      plans: result.plans,
      totalBytes: result.totalBytes.toString(),
      totalRoutedBytes: result.totalRoutedBytes.toString(),
      unroutedBytes: result.unroutedBytes.toString()
    })
  } catch (error) {
    return next(error)
  }
})

// 2. Query/Resume resumable status
uploadRouter.get('/resumable/status/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    if (session.status === 'completed') {
      return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    }

    if (!session.targetConnectedAccountId) {
      return res.json({ status: 'uploading', offset: '0' })
    }

    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: req.user!.id }
    })

    // Non-Google (S3 / Telegram): uploads stage to a temp file; the staged
    // byte count IS the resumable offset.
    if (account.provider !== 'google_drive') {
      return res.json({ status: 'uploading', offset: (await stagedBytes(session.id)).toString() })
    }

    if (!session.googleSessionUri) {
      return res.json({ status: 'uploading', offset: '0' })
    }

    const auth = await getAuthedGoogleClient(account)
    const token = await auth.getAccessToken()

    // Query Google Drive for uploaded offset
    const queryHeaders = new Headers()
    queryHeaders.set('Authorization', `Bearer ${token.token}`)
    queryHeaders.set('Content-Range', `bytes */${session.sizeBytes}`)

    const queryRes = await fetch(session.googleSessionUri, {
      method: 'PUT',
      headers: queryHeaders
    })

    if (queryRes.status === 308) {
      const range = queryRes.headers.get('range')
      if (range) {
        // e.g. bytes=0-1048575
        const parts = range.split('-')
        const lastByte = BigInt(parts[1])
        return res.json({ status: 'uploading', offset: (lastByte + 1n).toString() })
      }
    } else if (queryRes.ok) {
      return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    }

    return res.json({ status: 'uploading', offset: '0' })
  } catch (error) {
    return res.json({ status: 'failed', offset: '0' })
  }
})

// 3. Upload chunk
uploadRouter.put('/resumable/chunk/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    const rangeHeader = req.headers['content-range']
    if (!rangeHeader || typeof rangeHeader !== 'string') {
      return res.status(400).json({ code: 'MISSING_CONTENT_RANGE', message: 'Content-Range header is required.' })
    }

    // Parse Content-Range, e.g. bytes 0-5242879/10485760
    const match = rangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/)
    if (!match) return res.status(400).json({ code: 'INVALID_CONTENT_RANGE', message: 'Invalid Content-Range format.' })

    const startByte = BigInt(match[1])
    const endByte = BigInt(match[2])
    const totalBytes = BigInt(match[3])

    if (!session.targetConnectedAccountId) {
      return res.status(400).json({ code: 'UNSUPPORTED_PROVIDER', message: 'No target account for this upload session.' })
    }

    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: req.user!.id }
    })

    // ── Non-Google (S3 / Telegram): stage the chunk to a temp file and commit
    // to the provider when the final byte arrives. ───────────────────────────
    if (account.provider !== 'google_drive') {
      const stagedBefore = await stagedBytes(session.id)
      if (stagedBefore > startByte) {
        // Idempotent ack: the chunk is already staged (the client retried after
        // a lost response). Report the offset without re-appending.
        return res.json({ status: 'uploading', offset: stagedBefore.toString() })
      }
      if (stagedBefore < startByte) {
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Chunk range starts past the staged offset.' } }).catch(() => undefined)
        await removeStagedFile(session.id)
        return res.status(409).json({ code: 'UPLOAD_OFFSET_MISMATCH', message: 'The staged file is behind the requested chunk range. Restart the upload.' })
      }

      await appendChunk(session.id, req)
      const stagedAfter = await stagedBytes(session.id)
      if (stagedAfter !== endByte + 1n) {
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Staged byte count did not match the chunk range.' } }).catch(() => undefined)
        await removeStagedFile(session.id)
        return res.status(400).json({ code: 'UPLOAD_SIZE_MISMATCH', message: 'Staged byte count did not match the chunk range.' })
      }

      if (endByte + 1n < totalBytes) {
        return res.json({ status: 'uploading', offset: (endByte + 1n).toString() })
      }

      // Final chunk — commit the staged file to the provider.
      let uploadedFile
      try {
        uploadedFile = await finalizeNonGoogleUpload({
          userId: req.user!.id,
          account,
          folderId: session.folderId,
          fileName: session.fileName,
          mimeType: session.mimeType,
          sizeBytes: totalBytes,
          tmpPath: tempUploadPath(session.id),
        })
      } catch (error: any) {
        await removeStagedFile(session.id)
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: error?.message ?? 'Provider upload failed.' } }).catch(() => undefined)
        logUpload('non-google resumable finalize failed', { sessionId: session.id, accountId: account.id, message: error?.message ?? 'Unknown error' })
        return res.status(502).json({ code: 'UPLOAD_FAILED', message: error?.message ?? 'Provider upload failed.' })
      }
      await removeStagedFile(session.id)
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
      await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', uploadedFile.id, { name: uploadedFile.name, size: uploadedFile.sizeBytes.toString() })
      syncQuotaInBackground(account.id, session.id, account.provider)
      logUpload('non-google resumable upload completed', { sessionId: session.id, accountId: account.id, fileName: uploadedFile.name })
      return res.status(201).json({ status: 'completed', file: { ...uploadedFile, sizeBytes: uploadedFile.sizeBytes.toString() } })
    }

    if (!session.googleSessionUri) {
      return res.status(400).json({ code: 'UNSUPPORTED_PROVIDER', message: 'Only Google Drive resumable uploads are supported for this session.' })
    }

    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const token = await auth.getAccessToken()

    // Stream chunk body from client to Google Drive resumable URI
    const putHeaders = new Headers()
    putHeaders.set('Authorization', `Bearer ${token.token}`)
    putHeaders.set('Content-Range', rangeHeader)
    putHeaders.set('Content-Length', (endByte - startByte + 1n).toString())

    const putRes = await fetch(session.googleSessionUri, {
      method: 'PUT',
      headers: putHeaders,
      body: req as any,
      duplex: 'half'
    } as any)

    if (putRes.status === 308) {
      return res.json({ status: 'uploading', offset: (endByte + 1n).toString() })
    }

    if (putRes.ok) {
      // Completed! Parse metadata
      const fileMeta = await putRes.json() as { id: string; name: string; mimeType: string }

      // Make the file public (anyone with link can edit/download)
      try {
        await drive.permissions.create({
          fileId: fileMeta.id,
          requestBody: {
            role: 'writer',
            type: 'anyone'
          }
        })
      } catch (err: any) {
        console.error('Failed to make Google Drive resumable file public:', err.message || err)
      }

      let existingFile = await prisma.file.findFirst({
        where: { providerFileId: fileMeta.id, userId: req.user!.id }
      })

      if (!existingFile) {
        existingFile = await prisma.file.create({
          data: {
            userId: req.user!.id,
            connectedAccountId: account.id,
            folderId: session.folderId,
            provider: 'google_drive',
            providerFileId: fileMeta.id,
            name: fileMeta.name || session.fileName,
            mimeType: fileMeta.mimeType || session.mimeType,
            sizeBytes: totalBytes
          }
        })
      }

      await prisma.uploadSession.update({
        where: { id: session.id },
        data: { status: 'completed', completedAt: new Date() }
      })

      await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', existingFile.id, { name: existingFile.name, size: existingFile.sizeBytes.toString() })

      syncQuotaInBackground(account.id, session.id, account.provider)

      return res.status(201).json({ status: 'completed', file: { ...existingFile, sizeBytes: existingFile.sizeBytes.toString() } })
    }

    const errorMsg = await putRes.text()
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: 'failed', errorMessage: errorMsg }
    })

    return res.status(putRes.status).json({ code: 'UPLOAD_FAILED', message: errorMsg })
  } catch (error) {
    return next(error)
  }
})
