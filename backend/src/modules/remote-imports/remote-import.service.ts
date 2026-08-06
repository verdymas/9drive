import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { encryptText } from '../../utils/crypto.js'
import { createAuditLog } from '../../utils/audit.js'
import { sanitizeFileName } from './filename-sanitize.js'
import { enqueueRemoteImport, removeRemoteImportJob } from './queue.js'
import { validateRemoteUrl } from './ssrf.js'
import { removeTempFile } from './temp-storage.js'

const MAX_NAME = 255

export type CreateRemoteImportInput = {
  userId: string
  sourceUrl: string
  folderId?: string | null
  connectedAccountId?: string | null
  fileName?: string | null
  mimeType?: string | null
}

/**
 * Create a Remote Import job: validate the URL (scheme/credentials/SSRF),
 * verify the user's folder + account, persist the row (URL encrypted), and
 * enqueue the job. Returns the created row for the 201 response.
 */
export async function createRemoteImport(input: CreateRemoteImportInput) {
  if (!env.REMOTE_IMPORT_ENABLED) throw new AppError('REMOTE_IMPORT_DISABLED', 'Remote import is disabled.', 403)

  await validateRemoteUrl(input.sourceUrl)

  let folderId = input.folderId ?? null
  if (folderId) {
    const folder = await prisma.folder.findFirst({ where: { id: folderId, userId: input.userId, deletedAt: null } })
    if (!folder) throw new AppError('FOLDER_NOT_FOUND', 'The destination folder does not exist.', 404)
  }

  let connectedAccountId = input.connectedAccountId ?? null
  if (connectedAccountId) {
    const account = await prisma.connectedAccount.findFirst({ where: { id: connectedAccountId, userId: input.userId, status: 'connected' } })
    if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'The storage account does not exist.', 404)
  }

  const fileName = sanitizeFileName(input.fileName ?? deriveFileName(input.sourceUrl))
  if (fileName.length > MAX_NAME) throw new AppError('FILE_NAME_TOO_LONG', 'The file name is too long.', 400)

  const created = await prisma.remoteImport.create({
    data: {
      userId: input.userId,
      folderId,
      connectedAccountId,
      sourceUrlEncrypted: encryptText(input.sourceUrl),
      displayUrl: displayUrl(input.sourceUrl),
      fileName,
      mimeType: input.mimeType || null,
      status: 'queued',
      stage: 'waiting',
    },
  })

  await createAuditLog(input.userId, 'IMPORT_URL_CREATE', 'remote_import', created.id, { name: created.fileName })
  try {
    await enqueueRemoteImport(created.id)
  } catch (error) {
    // Enqueue failure should not lose the user's intent; the row stays queued
    // and can be retried from the UI. Log without the URL.
    console.error('[remote-import] enqueue failed for import', created.id, error instanceof Error ? error.message : String(error))
  }
  return created
}

/** Last path segment of the URL, percent-decoded, as the default file name. */
function deriveFileName(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch {
    /* fall through */
  }
  return 'download'
}

/**
 * Display-only version of the URL for the UI. Query strings can carry signed
 * secrets; the UI never needs them — strip them here so they never reach the
 * frontend or logs.
 */
function displayUrl(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl)
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return 'Invalid URL'
  }
}

/** Serialize a remote import row for API responses (BigInt → string). */
export function serializeRemoteImport(importRow: any) {
  const { sourceUrlEncrypted: _url, finalUrlEncrypted: _final, resumeSessionEncrypted: _session, internalError: _internal, ...rest } = importRow
  return {
    ...rest,
    totalBytes: importRow.totalBytes?.toString() ?? null,
    downloadedBytes: importRow.downloadedBytes.toString(),
    uploadedBytes: importRow.uploadedBytes.toString(),
  }
}

export async function getRemoteImportForUser(importId: string, userId: string) {
  const row = await prisma.remoteImport.findFirst({ where: { id: importId, userId } })
  if (!row) throw new AppError('REMOTE_IMPORT_NOT_FOUND', 'Remote import not found.', 404)
  return row
}

export async function listRemoteImportsForUser(userId: string, limit = 50, cursor?: string) {
  const rows = await prisma.remoteImport.findMany({
    where: { userId, ...(cursor ? { id: { lt: cursor } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    include: { file: { select: { id: true, name: true, sizeBytes: true } } },
  })
  return rows
}

/** Cancel an import: stop the worker if running and remove the queued job. */
export async function cancelRemoteImport(importId: string, userId: string) {
  const row = await getRemoteImportForUser(importId, userId)
  if (row.status === 'completed' || row.status === 'cancelled') return row

  // Remove from queue first (worker won't pick it up); in-flight jobs check
  // the status between phases and abort.
  await removeRemoteImportJob(importId).catch(() => undefined)
  const updated = await prisma.remoteImport.update({
    where: { id: importId },
    data: { status: 'cancelled', cancelledAt: new Date() },
  })
  await removeTempFile(importId)
  await createAuditLog(userId, 'IMPORT_URL_CANCEL', 'remote_import', importId, { name: updated.fileName })
  return updated
}

/** Retry a failed or cancelled import: clear errors, re-enqueue. */
export async function retryRemoteImport(importId: string, userId: string) {
  const row = await getRemoteImportForUser(importId, userId)
  if (row.status !== 'failed' && row.status !== 'cancelled') {
    throw new AppError('REMOTE_IMPORT_NOT_RETRYABLE', 'Only failed or cancelled imports can be retried.', 400)
  }
  const updated = await prisma.remoteImport.update({
    where: { id: importId },
    data: {
      status: 'queued',
      stage: 'waiting',
      attempt: { increment: 1 },
      errorCode: null,
      errorMessage: null,
      failedAt: null,
      cancelledAt: null,
      completedAt: null,
      startedAt: null,
    },
  })
  await enqueueRemoteImport(importId)
  await createAuditLog(userId, 'IMPORT_URL_RETRY', 'remote_import', importId, { name: updated.fileName })
  return updated
}

/** Delete an import row (does not touch the provider file). */
export async function deleteRemoteImport(importId: string, userId: string) {
  const row = await getRemoteImportForUser(importId, userId)
  await removeRemoteImportJob(importId).catch(() => undefined)
  await removeTempFile(importId)
  await prisma.remoteImport.delete({ where: { id: importId } })
  await createAuditLog(userId, 'IMPORT_URL_DELETE', 'remote_import', importId, { name: row.fileName })
  return row
}
