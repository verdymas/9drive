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

export type CreateRemoteImportHlsOptions = {
  sourceType: 'hls_master' | 'hls_media'
  variantId?: string
  audioTrackId?: string
  outputContainer?: 'auto' | 'mkv' | 'mp4'
  /** True when the selected media playlist is live/event (no ENDLIST). */
  isLive?: boolean
  recordingDurationSeconds?: number
}

export type CreateRemoteImportInput = {
  userId: string
  sourceUrl: string
  folderId?: string | null
  connectedAccountId?: string | null
  /** User-entered filename. When supplied it wins over any server detection. */
  fileName?: string | null
  /** Server-side detected filename (from the probe), used when the user did
   *  not type one. Always re-sanitized at creation — never trusted as-is. */
  detectedFileName?: string | null
  mimeType?: string | null
  /** HLS import options; when present the import is routed to the HLS pipeline. */
  hls?: CreateRemoteImportHlsOptions | null
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

  // Filename precedence: an explicitly user-supplied name always wins over a
  // server-detected one (the probe result is a convenience, never a mandate),
  // and the winner is sanitized AGAIN here — a probe could have happened long
  // ago or the header could have changed between probe and import creation.
  const rawFileName = input.fileName?.trim() || input.detectedFileName || deriveFileName(input.sourceUrl)
  const fileName = sanitizeFileName(rawFileName)
  if (fileName.length > MAX_NAME) throw new AppError('FILE_NAME_TOO_LONG', 'The file name is too long.', 400)

  // For HLS imports whose source name still carries a `.m3u8`/`.m3u` suffix,
  // the final stored name must match the OUTPUT container — never store a
  // playlist extension for a remuxed file. The pipeline also re-derives it,
  // but persisting the correct extension at creation keeps the UI honest.
  const hls = input.hls
  const finalFileName = hls ? hlsFinalFileName(fileName, hls.outputContainer) : fileName

  const created = await prisma.remoteImport.create({
    data: {
      userId: input.userId,
      folderId,
      connectedAccountId,
      sourceUrlEncrypted: encryptText(input.sourceUrl),
      displayUrl: displayUrl(input.sourceUrl),
      fileName: finalFileName,
      mimeType: input.mimeType || null,
      status: 'queued',
      stage: 'waiting',
      ...(hls
        ? {
            sourceType: hls.sourceType,
            hlsVariantId: hls.variantId ?? null,
            hlsAudioTrackId: hls.audioTrackId ?? null,
            hlsOutputContainer: hls.outputContainer ?? null,
            hlsIsLive: Boolean(hls.isLive),
            hlsRecordingDurationSeconds: hls.recordingDurationSeconds ?? null,
          }
        : {}),
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

/**
 * Derive the stored filename for an HLS import: the `.m3u8`/`.m3u` suffix is
 * replaced by the output container's extension (auto → mkv, the safe default;
 * the pipeline re-derives it later once the real container is known).
 */
function hlsFinalFileName(fileName: string, outputContainer: string | undefined): string {
  const extension = outputContainer === 'mp4' ? 'mp4' : outputContainer === 'mkv' ? 'mkv' : 'mkv'
  return fileName.replace(/\.(m3u8|m3u)$/i, '').replace(/\.+$/, '') + `.${extension}`
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

/**
 * Serialize a remote import row for API responses (BigInt → string).
 *
 * The final `file` relation is included in list responses and carries its own
 * `sizeBytes` BigInt — the spread below already keeps the mapped row, and
 * without a `toString()` here it would survive to `res.json()` and fail
 * JSON serialization (Node: "Do not know how to serialize a BigInt").
 */
export function serializeRemoteImport(importRow: any) {
  const { sourceUrlEncrypted: _encrypted, finalUrlEncrypted: _final, resumeSessionEncrypted: _session, internalError: _internal, ...rest } = importRow
  return {
    ...rest,
    totalBytes: importRow.totalBytes?.toString() ?? null,
    downloadedBytes: importRow.downloadedBytes.toString(),
    uploadedBytes: importRow.uploadedBytes.toString(),
    file: importRow.file ? { ...importRow.file, sizeBytes: importRow.file.sizeBytes.toString() } : null,
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
  await removeJobDirIfExists(userId, importId)
  await createAuditLog(userId, 'IMPORT_URL_CANCEL', 'remote_import', importId, { name: updated.fileName })
  return updated
}

/**
 * Remove the HLS job directory for an import when it exists. Safe: the job
 * directory is always under the temp root and validated before removal.
 */
async function removeJobDirIfExists(userId: string, importId: string): Promise<void> {
  try {
    const { hlsJobDir, removeJobDir } = await import('./hls/job-dir.js')
    await removeJobDir(hlsJobDir(userId, importId)).catch(() => undefined)
  } catch {
    /* job-dir module errors are swallowed — best-effort cleanup */
  }
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
      internalError: null,
      failedAt: null,
      cancelledAt: null,
      completedAt: null,
      startedAt: null,
    },
  })
  // A retry re-runs the whole pipeline — clear any stale HLS scratch dir so
  // segments from the failed attempt never leak into the next one.
  await removeJobDirIfExists(userId, importId)
  await enqueueRemoteImport(importId)
  await createAuditLog(userId, 'IMPORT_URL_RETRY', 'remote_import', importId, { name: updated.fileName })
  return updated
}

/** Convert-only retry: re-enqueue the HLS remux WITHOUT wiping the job dir. */
export async function retryRemoteConvert(importId: string, userId: string) {
  const row = await getRemoteImportForUser(importId, userId)
  const isHls = row.sourceType === 'hls_master' || row.sourceType === 'hls_media'
  const ok = row.status === 'failed' && isHls && (row.errorCode === 'HLS_REMUX_FAILED' || row.errorCode === 'HLS_OUTPUT_INVALID')
  if (!ok) {
    throw new AppError('REMOTE_IMPORT_NOT_CONVERT_RETRYABLE', 'Only a failed HLS conversion can be retried this way.', 400)
  }
  const updated = await prisma.remoteImport.update({
    where: { id: importId },
    data: {
      status: 'queued',
      stage: 'waiting',
      attempt: { increment: 1 },
      errorCode: null,
      errorMessage: null,
      internalError: null,
      failedAt: null,
      cancelledAt: null,
      completedAt: null,
      startedAt: null,
    },
  })
  // Deliberately NOT removeJobDirIfExists: the job dir holds the downloaded
  // segments the convert-only retry reuses (signaled by resume.json).
  await enqueueRemoteImport(importId)
  await createAuditLog(userId, 'IMPORT_URL_RETRY_CONVERT', 'remote_import', importId, { name: updated.fileName })
  return updated
}

/** Delete an import row (does not touch the provider file). */
export async function deleteRemoteImport(importId: string, userId: string) {
  const row = await getRemoteImportForUser(importId, userId)
  await removeRemoteImportJob(importId).catch(() => undefined)
  await removeTempFile(importId)
  await removeJobDirIfExists(userId, importId)
  await prisma.remoteImport.delete({ where: { id: importId } })
  await createAuditLog(userId, 'IMPORT_URL_DELETE', 'remote_import', importId, { name: row.fileName })
  return row
}
