import type { Job } from 'bullmq'
import fsp from 'node:fs/promises'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText } from '../../utils/crypto.js'
import { decryptRequestContext } from './request-context.js'
import { markTelegramReauthRequired } from '../telegram/telegram.service.js'
import type { RemoteImportJobData } from './queue.js'
import { removeTempFile, tempFilePath } from './temp-storage.js'
import { sanitizeFileName } from './filename-sanitize.js'
import { hasDriver, resolveDriver } from '../remote-fetch-workers/driver-registry.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES } from '../remote-fetch-workers/errors.js'
import { createSecureFetcherForWorkerId } from './secure-fetcher.js'
import { createRemoteImportProcessorContext, isHlsRecord, STAGES } from './processor-context.js'
import { admitTempStorage, markFailed } from './processor-progress.js'
import { tryGoogleStreamThrough, tryS3StreamThrough, type RegisterImportedFile } from './processor-direct.js'
import { downloadSourceToTemp } from './processor-download.js'
import { continueFromPart, registerFile } from './processor-upload.js'
import { processHlsImport } from './processor-hls.js'
import { probeSource } from './processor-probe.js'

/**
 * Execution-time worker guard (spec §29-§31). The selected worker must still
 * exist, be enabled, and use a supported driver. Transport is resolved
 * generically via the driver registry — no `if (driver === 'cloudflare')`.
 */
async function assertWorkerUsable(record: { workerId: string | null }) {
  if (!record.workerId) return
  const worker = await prisma.remoteFetchWorker.findFirst({ where: { id: record.workerId, deletedAt: null } })
  if (!worker) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_UNAVAILABLE, 'The selected network worker is no longer available.', 409)
  }
  if (!worker.isEnabled) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_DISABLED, 'The selected network worker is disabled.', 409)
  }
  if (!hasDriver(worker.driver)) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_DRIVER_UNSUPPORTED, 'The selected network worker uses an unsupported service.', 409)
  }
  // Provisioned workers have no endpoint until the deployment succeeds.
  if (!worker.endpointUrl) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.REMOTE_IMPORT_WORKER_UNAVAILABLE, 'The selected network worker is no longer available.', 409)
  }
  // Generic transport check: unsupported only when driver has no createTransport
  const driver = resolveDriver(worker.driver)
  if (!driver.createTransport) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_TRANSPORT_NOT_IMPLEMENTED, 'Relay transport for this worker is not implemented yet. Switch this import to Direct or choose a different worker.', 501)
  }
}

/**
 * Run the HLS pipeline for an import whose `sourceType` is hls_master/media.
 * Returns the remuxed output path + the provider upload metadata.
 */
/**
 * Main worker processor. Drives one import through every stage and writes
 * progress back to the `remote_imports` row. The temp file is removed
 * regardless of outcome; a `CANCELLED` import aborts early.
 */
export async function processRemoteImportJob(job: Job<RemoteImportJobData>) {
  const { importId } = job.data
  const record = await prisma.remoteImport.findUnique({ where: { id: importId } })
  if (!record) return
  if (record.status === 'cancelled') return
  keepPartForReauth = false

  const userId = record.userId
  const folderId = record.folderId
  const fileName = sanitizeFileName(record.fileName)
  const mimeType = record.mimeType ?? 'application/octet-stream'
  // Safe provenance diagnostics — the persisted canonical filename is
  // authoritative; nothing downstream re-derives it from the URL/headers.
  console.debug(`[remote-import:filename] stage=start canonical=${fileName}`)
  const sourceUrl = decryptText(record.sourceUrlEncrypted)
  const requestContext = decryptRequestContext(record.requestContextEncrypted) ?? undefined
  const maxBytes = BigInt(env.REMOTE_IMPORT_MAX_BYTES)
  const startedAt = Date.now()
  const jobTimeoutMs = env.REMOTE_IMPORT_JOB_TIMEOUT_HOURS * 60 * 60 * 1000
  const context = createRemoteImportProcessorContext({
    importId,
    record,
    userId,
    folderId,
    fileName,
    mimeType,
    sourceUrl,
    requestContext,
    maxBytes,
    startedAt,
    jobTimeoutMs,
  })
  const assertWithinTimeout = context.assertWithinTimeout

  try {
    if (record.status !== 'queued' && record.status !== 'failed' && record.status !== 'processing') return

    // The worker already transitioned the row to processing at pickup (§31).
    // Here we only align the stage: a retry resumes where its retryFromStage
    // says to (remuxing for convert-retries), never reverting to probing.
    if (record.status !== 'processing' || record.stage === 'waiting') {
      await prisma.remoteImport.update({
        where: { id: importId },
        data: { status: 'processing', stage: record.retryFromStage ?? STAGES.PROBING, jobId: job.id },
      })
    }

    // ── Selected worker guard: a worker-backed import must still be usable, and
    // relay transport is resolved generically via registry.
    await assertWorkerUsable(record)
    const fetcher = await createSecureFetcherForWorkerId(record.workerId, { requestContext, sourceUrl })

    // ── HLS imports skip the direct-download path entirely. ─────────────────
    if (isHlsRecord(record)) {
      const result = await processHlsImport(context, fetcher, { assertWorkerUsable })
      if (result === 'deferred') return 'deferred'
      if (result) return
      // processHlsImport already finalized status on failure; just return.
      return
    }

    // ── Upload-resume retry (§32 Case C): the temp part from a failed
    // upload (incl. GOOGLE_REAUTH_REQUIRED) survives on disk — skip the probe
    // and download entirely and go straight to placement + upload.
    const resumePartPath = tempFilePath(importId)
    const resumePartExists = await fsp.access(resumePartPath).then(() => true).catch(() => false)
    if (record.retryFromStage === 'uploading' && resumePartExists) {
      const partStat = await fsp.stat(resumePartPath)
      await continueFromPart({
        context,
        sourceUrl,
        tempPartPath: resumePartPath,
        contentLength: BigInt(partStat.size),
      })
      return
    }

    // Probe the URL: via SecureRemoteFetcher (Direct or relay) — never raw followRemoteUrl.
    let finalUrl: string
    let probedContentLength: bigint | null = record.totalBytes
    let sourceRangeSupported = false
    try {
      const probed = await probeSource(context, fetcher)
      finalUrl = probed.finalUrl
      sourceRangeSupported = probed.sourceRangeSupported
      if (probed.contentLength != null) {
        await prisma.remoteImport.update({ where: { id: importId }, data: { totalBytes: probed.contentLength, sourceRangeSupported } })
        probedContentLength = probed.contentLength
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'DOWNLOAD_TOO_LARGE') {
        await markFailed(importId, 'DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.')
        return
      }
      throw error
    }

    const directPhaseInput = {
      context: context as any,
      fetcher,
      registerFile: registerFile as unknown as RegisterImportedFile,
      sourceUrl: finalUrl,
      contentLength: probedContentLength,
      sourceRangeSupported,
    }
    if (await tryGoogleStreamThrough(directPhaseInput)) return
    if (await tryS3StreamThrough(directPhaseInput)) return

    const reservation = await admitTempStorage(importId, 'downloading', record.sourceType, probedContentLength)
    if (!reservation) return 'deferred'
    try {
      const downloaded = await downloadSourceToTemp(context as any, fetcher, finalUrl)
      finalUrl = downloaded.finalUrl

      assertWithinTimeout()

      // Re-check cancellation between phases.
      const afterDownload = await prisma.remoteImport.findUnique({ where: { id: importId } })
      if (afterDownload?.status === 'cancelled') {
        await removeTempFile(importId)
        return
      }

      assertWithinTimeout()

      // Shared placement→upload→register tail (also used by upload-resume retries).
      await continueFromPart({
        context,
        sourceUrl: finalUrl,
        tempPartPath: downloaded.tempPartPath,
        contentLength: downloaded.contentLength,
      })
    } finally {
      reservation.release()
    }
  } catch (error) {
    // The tail already finalized a placement failure (with the mapped stable
    // code) and signals via this marker so the row is not overwritten. A
    // reauth marker also preserves the local part for the resume retry.
    if (error instanceof AppError && (error as { placementFinalized?: boolean }).placementFinalized) {
      if (error.code === '__PLACEMENT_REAUTH__') keepPartForReauth = true
      return
    }
    if (error instanceof AppError && error.code === 'ABORTED') {
      const current = await prisma.remoteImport.findUnique({ where: { id: importId } }).catch(() => null)
      if (current?.status === 'cancelled') return
    }
    const message = error instanceof Error ? error.message : 'Unknown error'
    const code = error instanceof AppError ? error.code : 'IMPORT_FAILED'
    const meta = (error as { meta?: string })?.meta
    await markFailed(importId, code, message, meta)
    console.error(`[remote-import] ${importId} failed: ${code} ${message}${meta ? ` :: ${meta.slice(-800)}` : ''}`)
    // Auth-only failures keep the local .part so a retry after reconnect can
    // resume at upload instead of re-downloading a possibly multi-GB source.
    if (code === 'GOOGLE_REAUTH_REQUIRED') keepPartForReauth = true
    // A revoked/expired Telegram MTProto session is a permanent auth failure:
    // mark the account for reconnect (Settings → Reconnect Telegram) and keep
    // the part so the retry resumes at upload after reconnecting.
    if (code === 'TELEGRAM_SESSION_INVALID' && record.connectedAccountId) {
      await markTelegramReauthRequired(record.connectedAccountId, message).catch(() => undefined)
      keepPartForReauth = true
    }
  } finally {
    if (!keepPartForReauth) await removeTempFile(importId)
  }
}

/** Set when the execution failed with GOOGLE_REAUTH_REQUIRED — the local part
 * survives so the post-reconnect retry resumes at upload. */
let keepPartForReauth = false
