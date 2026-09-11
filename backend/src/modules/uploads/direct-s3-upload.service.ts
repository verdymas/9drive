import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import {
  abortS3MultipartUpload,
  buildS3ObjectKey,
  completeS3MultipartUpload,
  createS3MultipartUpload,
  deleteS3ObjectByKey,
  getS3ConfigForAccount,
  getS3PresignedUploadPartUrl,
  headS3Object,
  listS3MultipartParts,
  syncS3Quota,
} from '../s3/s3.service.js'
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'

type DirectS3InitInput = {
  fileName: string
  mimeType: string
  sizeBytes: bigint
  folderId: string | null
  targetAccountId: string | null
}

type DirectS3InitOptions = {
  enabled: boolean
  expiresInSeconds: number
  partSizeBytes: number
}

type DirectS3PartOptions = { partSizeBytes: number; partUrlExpiresInSeconds: number }
export type DirectS3CompletedPart = { partNumber: number; etag: string; sizeBytes?: number }

function expectedPartCount(sizeBytes: bigint, partSizeBytes: number) {
  return Number((sizeBytes + BigInt(partSizeBytes) - 1n) / BigInt(partSizeBytes))
}

/** The byte count the server advertises for one part slot; only the final slot may be short. */
function expectedPartSize(partNumber: number, sizeBytes: bigint, partSizeBytes: number) {
  if (partNumber === expectedPartCount(sizeBytes, partSizeBytes)) {
    return Number(sizeBytes) - (partNumber - 1) * partSizeBytes
  }
  return partSizeBytes
}

function validSessionParts(session: { s3MultipartUploadId: string | null; s3ObjectKey: string | null; targetConnectedAccountId: string | null }) {
  if (!session.s3MultipartUploadId || !session.s3ObjectKey || !session.targetConnectedAccountId) {
    throw new AppError('DIRECT_UPLOAD_INVALID_SESSION', 'The direct upload session is incomplete.', 409)
  }
  return { uploadId: session.s3MultipartUploadId, key: session.s3ObjectKey, accountId: session.targetConnectedAccountId }
}

async function ownedActiveSession(userId: string, sessionId: string) {
  const session = await prisma.uploadSession.findFirst({
    where: { id: sessionId, userId, status: 'direct_s3_uploading' },
  })
  if (!session) throw new AppError('DIRECT_UPLOAD_NOT_FOUND', 'Direct upload session not found.', 404)
  if (!session.s3UploadExpiresAt || session.s3UploadExpiresAt <= new Date()) {
    throw new AppError('DIRECT_UPLOAD_EXPIRED', 'Direct upload session has expired.', 410)
  }
  return session
}

export async function initDirectS3Upload(userId: string, input: DirectS3InitInput, options: DirectS3InitOptions) {
  if (!options.enabled) return { mode: 'server' as const }

  const placement = await resolveUploadPlacement(
    userId,
    input.folderId,
    input.targetAccountId,
    input.sizeBytes,
    new Map<string, bigint>(),
    'resumable',
  )
  if (placement.connectedAccount.provider !== 's3') return { mode: 'server' as const }

  const expiresAt = new Date(Date.now() + options.expiresInSeconds * 1000)
  const session = await prisma.uploadSession.create({
    data: {
      userId,
      targetConnectedAccountId: placement.connectedAccount.id,
      folderId: input.folderId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      status: 'direct_s3_uploading',
      s3UploadExpiresAt: expiresAt,
    },
  })

  const config = await getS3ConfigForAccount(placement.connectedAccount.id, userId)
  const folderPrefix = input.folderId ? placement.folderStorageLocation.providerFolderId : undefined
  const key = buildS3ObjectKey(config, userId, session.id, input.fileName, folderPrefix)
  try {
    const uploadId = await createS3MultipartUpload(config, key, input.mimeType)
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { s3MultipartUploadId: uploadId, s3ObjectKey: key },
    })
    return {
      mode: 'direct-s3' as const,
      sessionId: session.id,
      partSizeBytes: options.partSizeBytes,
      expiresAt: expiresAt.toISOString(),
      targetAccountId: placement.connectedAccount.id,
      targetAccountEmail: placement.connectedAccount.email,
    }
  } catch (error) {
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: 'failed', errorMessage: 'Could not initialize direct S3 upload.' },
    }).catch(() => undefined)
    throw error
  }
}

/**
 * Sign one part. Part URLs are issued per request (never batched) so a slow
 * transfer cannot outlive the signature, and every call re-validates ownership,
 * session liveness, and the part bound.
 */
export async function signDirectS3UploadPart(userId: string, sessionId: string, partNumber: number, options: DirectS3PartOptions) {
  const session = await ownedActiveSession(userId, sessionId)
  const totalParts = expectedPartCount(session.sizeBytes, options.partSizeBytes)
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) {
    throw new AppError('DIRECT_UPLOAD_INVALID_PART', 'Part number is outside this upload session.', 400)
  }
  const state = validSessionParts(session)
  const config = await getS3ConfigForAccount(state.accountId, userId)
  const url = await getS3PresignedUploadPartUrl(config, state.key, state.uploadId, partNumber, options.partUrlExpiresInSeconds)
  return { partNumber, url, expiresInSeconds: options.partUrlExpiresInSeconds }
}

/**
 * Validate the client-reported completion list against server-owned session
 * state. Declared part sizes are optional (clients written before the field
 * existed may omit them), but when present each must equal the exact byte count
 * advertised for that slot. The provider `HEAD` after completion stays the
 * final authority on the object size.
 */
function normalizeCompletedParts(parts: DirectS3CompletedPart[], sizeBytes: bigint, partSizeBytes: number) {
  const totalParts = expectedPartCount(sizeBytes, partSizeBytes)
  if (parts.length !== totalParts) throw new AppError('DIRECT_UPLOAD_INVALID_PARTS', 'All upload parts must be completed exactly once.', 400)
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber)
  for (let index = 0; index < ordered.length; index += 1) {
    const part = ordered[index]
    if (!Number.isInteger(part.partNumber) || part.partNumber !== index + 1 || !part.etag || part.etag.length > 512) {
      throw new AppError('DIRECT_UPLOAD_INVALID_PARTS', 'Upload part completion data is invalid.', 400)
    }
    const expected = expectedPartSize(index + 1, sizeBytes, partSizeBytes)
    if (part.sizeBytes !== undefined && (!Number.isInteger(part.sizeBytes) || part.sizeBytes !== expected)) {
      throw new AppError('DIRECT_UPLOAD_INVALID_PARTS', 'Upload part completion data is invalid.', 400)
    }
  }
  return ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag }))
}

export async function completeDirectS3Upload(userId: string, sessionId: string, parts: DirectS3CompletedPart[], options: Pick<DirectS3PartOptions, 'partSizeBytes'>) {
  const session = await ownedActiveSession(userId, sessionId)
  const state = validSessionParts(session)
  const normalizedParts = normalizeCompletedParts(parts, session.sizeBytes, options.partSizeBytes)
  const config = await getS3ConfigForAccount(state.accountId, userId)

  await completeS3MultipartUpload(config, state.key, state.uploadId, normalizedParts)
  try {
    const object = await headS3Object(config, state.key)
    if (object.contentLength !== session.sizeBytes) {
      throw new AppError('DIRECT_UPLOAD_SIZE_MISMATCH', 'Completed object size did not match the upload session.', 400)
    }

    const file = await prisma.file.create({
      data: {
        userId,
        connectedAccountId: state.accountId,
        folderId: session.folderId,
        provider: 's3',
        providerFileId: state.key,
        name: session.fileName,
        mimeType: session.mimeType,
        sizeBytes: session.sizeBytes,
        status: 'active',
      },
    })
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: 'completed', completedAt: new Date(), s3CompletedParts: parts },
    })
    await createAuditLog(userId, 'UPLOAD_FILE', 'file', file.id, { name: file.name, sizeBytes: file.sizeBytes.toString(), mode: 'direct_s3' })
    // The bytes never traversed the backend, so refresh the destination
    // account's tracked usage the way the server-side upload path does.
    void syncS3Quota(state.accountId).catch(() => undefined)
    return { status: 'completed' as const, file }
  } catch (error) {
    await Promise.resolve(deleteS3ObjectByKey(config, state.key)).catch(() => undefined)
    await Promise.resolve(prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: 'failed', errorMessage: error instanceof Error ? error.message : 'Could not complete direct S3 upload.' },
    })).catch(() => undefined)
    throw error
  }
}

export async function abortDirectS3Upload(userId: string, sessionId: string) {
  const session = await ownedActiveSession(userId, sessionId)
  const state = validSessionParts(session)
  const config = await getS3ConfigForAccount(state.accountId, userId)
  await abortS3MultipartUpload(config, state.key, state.uploadId)
  await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'aborted', completedAt: new Date() } })
  return { status: 'aborted' as const }
}

export async function sweepExpiredDirectS3Uploads(now = new Date()) {
  const sessions = await prisma.uploadSession.findMany({
    where: { status: 'direct_s3_uploading', s3UploadExpiresAt: { lt: now } },
  })
  for (const session of sessions) {
    try {
      const state = validSessionParts(session)
      const config = await getS3ConfigForAccount(state.accountId, session.userId)
      await abortS3MultipartUpload(config, state.key, state.uploadId)
    } catch {
      // A remote upload may already have expired or been aborted; the local
      // session still must stop advertising usable direct-upload state.
    }
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: 'failed', errorMessage: 'Direct S3 upload session expired.' },
    })
  }
  return { swept: sessions.length }
}

/**
 * Byte progress for a direct session. While the upload is in flight the backend
 * has not seen any bytes, so the provider's own part list is the only truthful
 * source; completed sessions report the full declared size and terminal
 * sessions report 0 (their remote parts are gone). Returns null when the
 * provider cannot be consulted.
 */
export async function directS3UploadedBytes(userId: string, sessionId: string) {
  const session = await prisma.uploadSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) return null
  if (session.status === 'completed') return session.sizeBytes
  if (session.status === 'aborted' || session.status === 'failed') return 0n
  try {
    const state = validSessionParts(session)
    const config = await getS3ConfigForAccount(state.accountId, userId)
    const parts = await listS3MultipartParts(config, state.key, state.uploadId)
    return parts.reduce((sum, part) => sum + part.size, 0n)
  } catch {
    return null
  }
}

/**
 * Periodic cleanup for abandoned direct sessions (closed tab, lost network).
 * Shaped like the remote-import temp sweeper: unref'd so it never holds the
 * process open, and absent entirely while the feature is disabled.
 */
export function startDirectS3UploadSweeper(intervalMs = 5 * 60 * 1000) {
  if (!env.S3_DIRECT_UPLOAD_ENABLED) return undefined
  const timer = setInterval(() => {
    void sweepExpiredDirectS3Uploads().catch((error) => console.error('[direct-s3-upload] sweeper failed:', error))
  }, intervalMs)
  timer.unref()
  return timer
}
