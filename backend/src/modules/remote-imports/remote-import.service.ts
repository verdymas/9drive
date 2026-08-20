import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { encryptText } from '../../utils/crypto.js'
import { sanitizeFileName } from './filename-sanitize.js'
import {
  decryptRequestContext,
  encryptRequestContext,
  serializeRequestContext,
  type RemoteImportRequestContext,
} from './request-context.js'
import { enqueueRemoteImport, removeRemoteImportJob, remoteImportJobId } from './queue.js'
import { validateRemoteUrl } from './ssrf.js'
import { removeTempFile, tempFilePath } from './temp-storage.js'
import { hlsJobDir, readResumeMarker, removeJobDir } from './hls/job-dir.js'
import { reconcileQueuedRow } from './queue-reconcile.js'
import { containerExtension } from './hls/output.js'
import { hasDriver } from '../remote-fetch-workers/driver-registry.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from '../remote-fetch-workers/errors.js'
import fsp from 'node:fs/promises'

const MAX_NAME = 255

/** Stale-queued threshold for reconcile-on-read (kept in sync with the sweep). */
const REMOTE_IMPORT_QUEUE_START_TIMEOUT_MS = env.REMOTE_IMPORT_QUEUE_START_TIMEOUT_SECONDS * 1000

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
  /**
   * Selected Remote Fetch Worker (network relay). Null/absent = Direct / no
   * relay. Persisted BEFORE enqueueing so the same worker survives retries.
   */
  workerId?: string | null
  /** User-entered filename. When supplied it wins over any server detection. */
  fileName?: string | null
  /** Server-side detected filename (from the probe), used when the user did
   *  not type one. Always re-sanitized at creation — never trusted as-is. */
  detectedFileName?: string | null
  mimeType?: string | null
  /** HLS import options; when present the import is routed to the HLS pipeline. */
  hls?: CreateRemoteImportHlsOptions | null
  /** User-supplied referer/origin/user-agent/cookie for protected sources. */
  requestContext?: RemoteImportRequestContext | null
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

  // Network Route: validate the selected Remote Fetch Worker (spec §28). The
  // worker must exist, be enabled, and use a driver installed in the registry.
  // Network Worker and destination Storage Account are separate concepts.
  let workerId = input.workerId ?? null
  let workerNameSnapshot: string | null = null
  if (workerId) {
    const worker = await prisma.remoteFetchWorker.findFirst({ where: { id: workerId, deletedAt: null } })
    if (!worker) throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_INVALID, 'The selected network worker does not exist.', 400)
    if (!worker.isEnabled) throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_DISABLED, 'The selected network worker is disabled.', 400)
    if (!hasDriver(worker.driver)) throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_DRIVER_UNSUPPORTED, 'The selected network worker uses an unsupported service.', 400)
    workerNameSnapshot = worker.name
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
  // playlist extension for a remuxed file. A user-entered explicit extension
  // that CONTRADICTS the selected container (e.g. `Movie.mp4` while MKV is
  // selected) is rejected before creation: the displayed filename must be the
  // one ultimately uploaded (§4).
  const hls = input.hls
  const finalFileName = hls ? hlsFinalFileName(fileName, hls.outputContainer) : fileName

  const created = await prisma.remoteImport.create({
    data: {
      userId: input.userId,
      folderId,
      connectedAccountId,
      workerId,
      workerNameSnapshot,
      sourceUrlEncrypted: encryptText(input.sourceUrl),
      requestContextEncrypted: input.requestContext ? encryptRequestContext(input.requestContext) : null,
      displayUrl: displayUrl(input.sourceUrl),
      fileName: finalFileName,
      mimeType: input.mimeType || null,
      status: 'queued',
      stage: 'waiting',
      attempt: 1,
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
    await enqueueRemoteImport(created.id, 1)
    // queuedAt is set only when queue.add() actually succeeded (§29/§30).
    await prisma.remoteImport.update({
      where: { id: created.id },
      data: { queuedAt: new Date(), jobId: remoteImportJobId(created.id, 1) },
    }).catch(() => undefined)
  } catch (error) {
    // Enqueue failure must NOT leave the row `queued` with no job behind it:
    // mark it failed so the user can retry, and surface the error. Log without
    // the URL.
    console.error('[remote-import] enqueue failed for import', created.id, error instanceof Error ? error.message : String(error))
    await prisma.remoteImport.update({
      where: { id: created.id },
      data: { status: 'failed', stage: 'finished', errorCode: 'REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED', errorMessage: 'The import could not be queued. Please retry.', failedAt: new Date() },
    }).catch(() => undefined)
    throw new AppError('REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED', 'The import could not be queued. Please retry.', 502)
  }
  return created
}

/**
 * Derive the stored filename for an HLS import: the `.m3u8`/`.m3u` suffix is
 * replaced by the output container's extension (auto → mkv, the safe default;
 * the pipeline re-derives it later once the real container is known).
 *
 * A user-entered explicit extension that contradicts the selected container is
 * rejected with FILE_NAME_EXTENSION_MISMATCH — the name the user sees in the
 * create modal must be the name that is ultimately uploaded (§4).
 */
export function hlsFinalFileName(fileName: string, outputContainer: string | undefined): string {
  const extension = outputContainer === 'mp4' ? 'mp4' : 'mkv'
  const explicit = fileName.match(/\.([a-zA-Z0-9]{1,8})$/)
  if (explicit && !/^\.(m3u8|m3u)$/i.test(explicit[0])) {
    const given = explicit[1].toLowerCase()
    // A name whose extension already matches the output container is the
    // canonical requested name — never re-derive it (no double extension).
    if (given === extension) return fileName
    throw new AppError('FILE_NAME_EXTENSION_MISMATCH', `The file name extension (.${given}) must match the selected output container (${extension.toUpperCase()}).`, 400)
  }
  const base = fileName.replace(/\.(m3u8|m3u)$/i, '').replace(/\.+$/, '')
  return `${base || 'video'}.${extension}`
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

/** `uploadedBytes / (uploadTotalBytes ?? totalBytes)` clamped to [0, 100]. */
export function computeUploadProgress(row: {
  uploadedBytes: bigint
  uploadTotalBytes?: bigint | null
  totalBytes?: bigint | null
}): number {
  const numerator = row.uploadedBytes
  const denominator = row.uploadTotalBytes ?? row.totalBytes
  if (!denominator || denominator <= 0n) return 0
  if (numerator >= denominator) return 100
  return Number((numerator * 100n) / denominator)
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
  const {
    sourceUrlEncrypted: _encrypted,
    requestContextEncrypted: _requestContextEncrypted,
    finalUrlEncrypted: _final,
    resumeSessionEncrypted: _session,
    internalError: _internal,
    ...rest
  } = importRow
  return {
    ...rest,
    // Never the encrypted blob NOR the decrypted values — booleans only, so
    // the UI can say "Request context attached" without ever seeing secrets.
    requestContext: serializeRequestContext(decryptRequestContext(importRow.requestContextEncrypted)),
    totalBytes: importRow.totalBytes?.toString() ?? null,
    downloadedBytes: importRow.downloadedBytes.toString(),
    uploadedBytes: importRow.uploadedBytes.toString(),
    uploadTotalBytes: importRow.uploadTotalBytes?.toString() ?? null,
    uploadProgress: computeUploadProgress(importRow),
    file: importRow.file ? { ...importRow.file, sizeBytes: importRow.file.sizeBytes.toString() } : null,
  }
}

export async function getRemoteImportForUser(importId: string, userId: string) {
  const row = await prisma.remoteImport.findFirst({
    where: { id: importId, userId },
    include: {
      connectedAccount: { select: { id: true, provider: true, email: true, displayName: true } },
      worker: { select: { id: true, name: true, driver: true, region: true, status: true, isEnabled: true } },
    },
  })
  if (!row) throw new AppError('REMOTE_IMPORT_NOT_FOUND', 'Remote import not found.', 404)
  // Reconcile-on-read: a `queued` row past the start timeout with a missing
  // queue job is failed here so the UI never shows a stuck queued state while
  // waiting for the worker's periodic sweep (§35).
  if (row.status === 'queued' && row.queuedAt && Date.now() - row.queuedAt.getTime() > REMOTE_IMPORT_QUEUE_START_TIMEOUT_MS) {
    const action = await reconcileQueuedRow({
      id: row.id, status: row.status, stage: row.stage, jobId: row.jobId, attempt: row.attempt, queuedAt: row.queuedAt, heartbeatAt: null, fileName: row.fileName,
    })
    if (action === 'failed-missing' || action === 'failed') {
      // Re-read so the response reflects the reconciled state.
      return prisma.remoteImport.findFirstOrThrow({
        where: { id: importId, userId },
        include: {
          connectedAccount: { select: { id: true, provider: true, email: true, displayName: true } },
          worker: { select: { id: true, name: true, driver: true, region: true, status: true, isEnabled: true } },
        },
      })
    }
  }
  return row
}

export async function listRemoteImportsForUser(userId: string, limit = 50, cursor?: string) {
  const rows = await prisma.remoteImport.findMany({
    where: { userId, ...(cursor ? { id: { lt: cursor } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    include: {
      file: { select: { id: true, name: true, sizeBytes: true } },
      connectedAccount: { select: { id: true, provider: true, email: true, displayName: true } },
      worker: { select: { id: true, name: true, driver: true, region: true, status: true, isEnabled: true } },
    },
  })
  void reconcileStaleQueuedRows(rows)
  return rows
}

/**
 * Fire-and-forget reconcile for stale `queued` rows seen in list responses.
 * Only the newest rows (the visible page) are checked; Redis down is a no-op.
 */
async function reconcileStaleQueuedRows(rows: { id: string; status: string; stage: string; jobId: string | null; attempt: number; queuedAt: Date | null; fileName: string }[]) {
  const cutoff = Date.now() - REMOTE_IMPORT_QUEUE_START_TIMEOUT_MS
  await Promise.all(
    rows
      .filter((r) => r.status === 'queued' && r.queuedAt && r.queuedAt.getTime() < cutoff)
      .map((r) => reconcileQueuedRow({ ...r, heartbeatAt: null } as any).catch(() => undefined)),
  )
}

/** Cancel an import: stop the worker if running and remove the queued job. */
export async function cancelRemoteImport(importId: string, userId: string) {
  const row = await getRemoteImportForUser(importId, userId)
  if (row.status === 'completed' || row.status === 'cancelled') return row

  // Remove from queue first (worker won't pick it up); in-flight jobs check
  // the status between phases and abort.
  await removeRemoteImportJob(importId, row.attempt).catch(() => undefined)
  const updated = await prisma.remoteImport.update({
    where: { id: importId },
    data: { status: 'cancelled', cancelledAt: new Date() },
  })
  await removeTempFile(importId)
  await removeJobDirIfExists(userId, importId)
  await createAuditLog(userId, 'IMPORT_URL_CANCEL', 'remote_import', importId, { name: updated.fileName })
  return updated
}

/** Remove the HLS job directory for an import when it exists (best-effort). */
async function removeJobDirIfExists(userId: string, importId: string): Promise<void> {
  await removeJobDir(hlsJobDir(userId, importId)).catch(() => undefined)
}

/**
 * Determine where a retry should resume, server-side, from persisted state
 * only (§32 — never trust a frontend-provided stage):
 *
 * - `registering` — provider upload already succeeded (`fileId` set); only the
 *   9Drive File registration remains.
 * - `uploading`    — the local output file still exists on disk (direct: the
 *   `.part` temp file; HLS: the remuxed output in the job dir); skip remux and
 *   go straight to upload.
 * - `remuxing`    — the HLS job dir holds a `resume.json` marker (segments
 *   materialized); resume at FFmpeg without re-downloading segments.
 * - `segments`    — HLS full re-run (download + remux).
 * - `downloading` — direct full re-run (re-download the source).
 */
export async function determineRetryStage(
  row: { id: string; userId: string; sourceType: string | null; fileId: string | null },
): Promise<'segments' | 'remuxing' | 'uploading' | 'registering' | 'downloading'> {
  const isHls = row.sourceType === 'hls_master' || row.sourceType === 'hls_media'
  if (!isHls) {
    // Direct import: resume at upload when the temp part survives, else re-download.
    try {
      await fsp.access(tempFilePath(row.id))
      return 'uploading'
    } catch {
      return 'downloading'
    }
  }
  if (row.fileId) return 'registering'
  const jobDir = hlsJobDir(row.userId, row.id)
  // Local output exists → remux completed; skip FFmpeg and upload what we
  // have. The container may have been auto-resolved, so probe both.
  for (const ext of ['mkv', 'mp4'] as const) {
    try {
      await fsp.access(`${jobDir}/output.${containerExtension(ext)}`)
      return 'uploading'
    } catch {
      /* not this container; try the next */
    }
  }
  // No output yet: a `resume.json` marker means the segments were materialized
  // and a remux-only retry can resume at FFmpeg (§32 Case B).
  if (await readResumeMarker(jobDir)) return 'remuxing'
  return 'segments'
}

/**
 * Queue a retry WITHOUT ever leaving the DB row `queued` when the enqueue
 * fails (§30). Order:
 *
 *   validate → determine retry stage → queue.add(attempt+1)
 *     → on success: CAS persist queued state (status, stage, jobId, queuedAt,
 *       retryRequestedAt, attempt+1, cleared error fields)
 *     → on failure: restore stable failed state + enqueue error, throw 502
 *
 * Single-flight: the same execution can never be created twice because the
 * CAS `updateMany({ where: { id, status: { in: ['failed', 'cancelled'] } } })`
 * admits only one winner; concurrent retries of a row that is already
 * queued/processing are rejected with 409 REMOTE_IMPORT_ALREADY_ACTIVE
 * (§40/§41).
 */
async function enqueueRetry(
  importId: string,
  userId: string,
  kind: 'full' | 'convert',
) {
  const row = await getRemoteImportForUser(importId, userId)
  if (row.status === 'queued' || row.status === 'processing') {
    throw new AppError('REMOTE_IMPORT_ALREADY_ACTIVE', 'This import is already queued or in progress.', 409)
  }
  if (kind === 'convert') {
    const isHls = row.sourceType === 'hls_master' || row.sourceType === 'hls_media'
    const ok = row.status === 'failed' && isHls && (row.errorCode === 'HLS_REMUX_FAILED' || row.errorCode === 'HLS_OUTPUT_INVALID')
    if (!ok) {
      throw new AppError('REMOTE_IMPORT_NOT_CONVERT_RETRYABLE', 'Only a failed HLS conversion can be retried this way.', 400)
    }
  } else if (row.status !== 'failed' && row.status !== 'cancelled') {
    throw new AppError('REMOTE_IMPORT_NOT_RETRYABLE', 'Only failed or cancelled imports can be retried.', 400)
  }

  // The retry keeps the SAME selected worker (spec §30). If the worker has
  // since been deleted/disabled/unsupported, fail clearly — NEVER silently
  // switch to Direct or to another worker.
  if (row.workerId) {
    const worker = await prisma.remoteFetchWorker.findFirst({ where: { id: row.workerId, deletedAt: null } })
    if (!worker || !worker.isEnabled || !hasDriver(worker.driver)) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_UNAVAILABLE, REMOTE_FETCH_WORKER_ERROR_MESSAGES.REMOTE_IMPORT_WORKER_UNAVAILABLE, 409)
    }
  }

  const nextAttempt = row.attempt + 1
  const retryFromStage = await determineRetryStage(row)

  let jobId: string
  try {
    // Enqueue first: the BullMQ job is the source of truth for execution.
    jobId = await enqueueRemoteImport(importId, nextAttempt)
  } catch (error) {
    // Persist a stable failed/retryable state — NEVER leave the row queued.
    await prisma.remoteImport.update({
      where: { id: importId },
      data: {
        status: 'failed',
        stage: 'finished',
        errorCode: 'REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED',
        errorMessage: 'The retry could not be queued. Please try again.',
        internalError: error instanceof Error ? error.message.slice(0, 4096) : String(error).slice(0, 4096),
        failedAt: new Date(),
      },
    }).catch(() => undefined)
    console.error('[remote-import] retry enqueue failed for import', importId, error instanceof Error ? error.message : String(error))
    throw new AppError('REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED', 'The retry could not be queued. Please try again.', 502)
  }

  // A full retry re-runs the whole pipeline — clear any stale HLS scratch dir
  // so segments from the failed attempt never leak into the next one. A
  // convert-only retry relies on the job dir (segments + resume marker) being
  // preserved, so it never wipes. An auth-only failure (GOOGLE_REAUTH_REQUIRED)
  // also preserves the dir: the remuxed output + resume marker let the retry
  // resume at upload instead of re-downloading the HLS segments.
  if (kind === 'full' && row.errorCode !== 'GOOGLE_REAUTH_REQUIRED') await removeJobDirIfExists(userId, importId)

  // CAS: only one retry request may transition failed→queued; if another
  // request already moved the row, this is a duplicate → conflict.
  const updated = await prisma.remoteImport.updateMany({
    where: { id: importId, status: { in: ['failed', 'cancelled'] } },
    data: {
      status: 'queued',
      stage: 'waiting',
      attempt: nextAttempt,
      jobId,
      queuedAt: new Date(),
      retryRequestedAt: new Date(),
      retryFromStage,
      errorCode: null,
      errorMessage: null,
      internalError: null,
      failedAt: null,
      cancelledAt: null,
      completedAt: null,
      startedAt: null,
      heartbeatAt: null,
    },
  })
  if (updated.count !== 1) {
    throw new AppError('REMOTE_IMPORT_ALREADY_ACTIVE', 'This import is already queued or in progress.', 409)
  }

  // Re-read so the response carries what the DB actually has, including the
  // relation; the audit log must not block the retry.
  const fresh = await prisma.remoteImport.findUniqueOrThrow({
    where: { id: importId },
    include: {
      connectedAccount: { select: { id: true, provider: true, email: true, displayName: true } },
      worker: { select: { id: true, name: true, driver: true, region: true, status: true, isEnabled: true } },
    },
  })
  try {
    await createAuditLog(userId, 'IMPORT_URL_RETRY', 'remote_import', importId, { name: row.fileName })
  } catch {
    /* audit failures are non-fatal */
  }
  return fresh
}

/** Retry a failed or cancelled import: clear errors, re-enqueue (full re-run). */
export async function retryRemoteImport(importId: string, userId: string) {
  return enqueueRetry(importId, userId, 'full')
}

/** Convert-only retry: re-enqueue the HLS remux WITHOUT wiping the job dir. */
export async function retryRemoteConvert(importId: string, userId: string) {
  return enqueueRetry(importId, userId, 'convert')
}

/** Delete an import row (does not touch the provider file). */
export async function deleteRemoteImport(importId: string, userId: string) {
  const row = await getRemoteImportForUser(importId, userId)
  await removeRemoteImportJob(importId, row.attempt).catch(() => undefined)
  await removeTempFile(importId)
  await removeJobDirIfExists(userId, importId)
  await prisma.remoteImport.delete({ where: { id: importId } })
  await createAuditLog(userId, 'IMPORT_URL_DELETE', 'remote_import', importId, { name: row.fileName })
  return row
}