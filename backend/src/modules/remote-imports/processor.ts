import type { Job } from 'bullmq'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'
import type { RemoteImportJobData } from './queue.js'
import { followRemoteUrl } from './url-downloader.js'
import { uploadToGoogleResumable } from './google-resumable-uploader.js'
import { createTempPartFile, removeTempFile, appendStreamToTemp } from './temp-storage.js'
import { sanitizeFileName } from './filename-sanitize.js'
import { runHlsPipeline } from './hls/pipeline.js'
import { hlsJobDir, readResumeMarker, removeJobDir, removeResumeMarker } from './hls/job-dir.js'
import type { ContainerChoice } from './hls/output.js'
import { ensureJobDir } from './hls/materializer.js'
import { verifyOutput } from './hls/verify.js'

const STAGES = {
  PROBING: 'probing',
  DOWNLOADING: 'downloading',
  SEGMENTS: 'segments',
  REMUXING: 'remuxing',
  VERIFYING: 'verifying',
  SELECTING_STORAGE: 'selecting_storage',
  UPLOADING: 'uploading',
  REGISTERING: 'registering',
  CLEANING: 'cleaning',
  FINISHED: 'finished',
} as const

type Stage = (typeof STAGES)[keyof typeof STAGES]

/** True when the stored import is an HLS source. */
function isHlsRecord(record: { sourceType?: string | null }): boolean {
  return record.sourceType === 'hls_master' || record.sourceType === 'hls_media'
}

/**
 * Update the domain row's stage + progress. `progress` must be a small
 * object of bytes/fields (never the URL, never tokens). Errors are swallowed
 * so a transient DB blip never fails the import itself.
 *
 * Every progress write doubles as heartbeat evidence (§38): meaningful,
 * throttled progress IS liveness. The HLS conversion additionally writes a
 * heartbeat from its 5s poll loop so an idle (byte-silent) FFmpeg process
 * still proves the worker is alive.
 */
async function updateStage(importId: string, stage: Stage, progress: Record<string, unknown> = {}) {
  await prisma.remoteImport.update({
    where: { id: importId },
    data: { stage, ...progress, heartbeatAt: new Date() },
  }).catch(() => undefined)
}

/** Rolling liveness evidence for long, byte-silent phases (idle FFmpeg). */
async function writeHeartbeat(importId: string) {
  await prisma.remoteImport.update({
    where: { id: importId },
    data: { heartbeatAt: new Date() },
  }).catch(() => undefined)
}

/**
 * Begin the upload phase: record the upload's total bytes (final output size,
 * distinct from the SOURCE `totalBytes` — for HLS the two differ) and reset
 * the uploaded counter for this execution. Returns the stat for the caller.
 */
async function startUploadPhase(importId: string, localPath: string) {
  const stat = await fsp.stat(localPath)
  const totalBytes = BigInt(stat.size)
  await updateStage(importId, STAGES.UPLOADING, {
    uploadedBytes: 0,
    uploadTotalBytes: totalBytes,
  })
  return totalBytes
}

/** Throttle a stage-update call to REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS. */
function throttledProgressUpdater(importId: string, stage: Stage) {
  let lastWrite = 0
  return async (progress: Record<string, unknown>) => {
    const now = Date.now()
    if (now - lastWrite < env.REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS) return
    lastWrite = now
    await updateStage(importId, stage, progress)
  }
}

function nowIso() {
  return new Date().toISOString()
}

function logProgress(importId: string, stage: Stage, message: string) {
  // Log-only; never includes URL query strings or secrets.
  console.log(`[remote-import] ${nowIso()} ${importId} ${stage}: ${message}`)
}

/** Fetch + stream a remote URL to a temp part file with byte cap and idle timeout. */
async function downloadToTemp(importId: string, startUrl: string, maxBytes: bigint): Promise<{ finalUrl: string; tempPartPath: string; contentLength: bigint | null; supportsRange: boolean }> {
  const partPath = await createTempPartFile(importId)
  let supportsRange = false
  let contentLength: bigint | null = null
  let finalUrl = startUrl
  let totalBytes = 0n

  await followRemoteUrl(startUrl, {
    onResponse: async (res) => {
      const rawLength = res.headers['content-length']
      if (rawLength) contentLength = BigInt(rawLength)
      supportsRange = res.headers['accept-ranges'] === 'bytes' || res.statusCode === 206
      if (res.statusCode >= 400) {
        throw new AppError('DOWNLOAD_HTTP_ERROR', `Remote server responded ${res.statusCode}.`, 502)
      }

      // Idle-timeout and size-cap aborts are deliberate — keep the body's
      // 'error' event from becoming an unhandled rejection.
      if (typeof (res.body as { on?: unknown }).on === 'function') {
        (res.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
      }

      const fileStream = appendStreamToTemp(partPath)
      const writeProgress = throttledProgressUpdater(importId, STAGES.DOWNLOADING)

      try {
        for await (const chunk of res.body) {
          totalBytes += BigInt(chunk.byteLength)
          if (totalBytes > maxBytes) {
            fileStream.destroy()
            throw new AppError('DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.', 413)
          }
          if (!fileStream.write(chunk)) {
            await new Promise<void>((resolve) => fileStream.once('drain', resolve))
          }
          await writeProgress({ downloadedBytes: totalBytes.toString() })
        }
        // Final write is NOT throttled: the bar reaches 100% the moment the
        // download finishes rather than up to one interval later.
        await updateStage(importId, STAGES.DOWNLOADING, { downloadedBytes: totalBytes.toString() })
        await new Promise<void>((resolve, reject) => fileStream.end((err: Error | null) => (err ? reject(err) : resolve())))
      } catch (error) {
        fileStream.destroy()
        throw error
      }
      return { finalUrl, contentLength, supportsRange }
    },
  })

  await updateStage(importId, STAGES.VERIFYING, { downloadedBytes: totalBytes.toString() })
  return { finalUrl, tempPartPath: partPath, contentLength, supportsRange }
}

/**
 * Stream the temp part file into the destination provider and return provider
 * metadata. The upload phase is started here (stage `uploading` + uploadTotal
 * bytes from the local file) and the completed progress is written back
 * through the same `onUploadProgress` channel used by the live bar.
 */
async function uploadTempFile(
  importId: string,
  account: { id: string; provider: string },
  userId: string,
  folderId: string | null,
  fileName: string,
  mimeType: string,
  tempPartPath: string,
  providerFolderId: string,
  onUploadProgress?: (uploadedBytes: bigint) => void,
) {
  const uploadTotalBytes = await startUploadPhase(importId, tempPartPath)
  const fileStream = fs.createReadStream(tempPartPath)

  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id, userId)
    const provisionalFile = await prisma.file.create({
      data: { userId, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType, sizeBytes: 0n, status: 'uploading' },
    })
    const providerFileId = buildS3ObjectKey(config, userId, provisionalFile.id, fileName, folderId ? providerFolderId : undefined)
    try {
      // One throttled updater for the whole upload (per-call creations would
      // reset the throttle window and write on every part event).
      const uploadProgress = throttledProgressUpdater(importId, STAGES.UPLOADING)
      await uploadS3Object(config, providerFileId, fileStream, mimeType, {
        onProgress: (uploadedBytes) => {
          void uploadProgress({ uploadedBytes: uploadedBytes.toString() })
        },
      })
      // S3's httpUploadProgress is per-part; force the final write so the bar
      // reaches 100% the moment the upload completes (§ spec).
      await prisma.remoteImport.update({ where: { id: importId }, data: { uploadedBytes: uploadTotalBytes } }).catch(() => undefined)
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId, status: 'active' } })
      return { providerFileId, fileId: provisionalFile.id }
    } catch (error) {
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      throw error
    }
  }

  // Google Drive — resumable upload streams the temp file directly, records
  // the session encrypted (for crash-safe), and returns provider metadata.
  const uploadProgress = throttledProgressUpdater(importId, STAGES.UPLOADING)
  const uploaded = await uploadToGoogleResumable(importId, account.id, userId, fileName, mimeType, tempPartPath, providerFolderId, (bytes) => {
    void uploadProgress({ uploadedBytes: bytes.toString() })
  })
  return { providerFileId: uploaded.providerFileId, fileId: null }
}

/**
 * Register the imported file in the virtual filesystem (idempotent by
 * providerFileId when the row already points at one).
 */
async function registerFile(importId: string, remoteImport: { userId: string; folderId: string | null; connectedAccountId: string | null; fileName: string; mimeType: string | null; tempPath?: string | null }, providerFileId: string, sizeBytes: bigint) {
  await updateStage(importId, STAGES.REGISTERING)
  const accountId = remoteImport.connectedAccountId
  if (!accountId) throw new Error('Missing connected account for file registration.')
  const provider = (await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })).provider

  const existing = await prisma.file.findFirst({
    where: { userId: remoteImport.userId, provider, providerFileId },
  })
  if (existing) return existing

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

/** Mark the import failed with a safe, loggable message (never the URL). */
async function markFailed(importId: string, code: string, message: string, internalError?: string) {
  await prisma.remoteImport.update({
    where: { id: importId },
    data: {
      status: 'failed',
      stage: STAGES.FINISHED,
      errorCode: code,
      errorMessage: message.slice(0, 4096),
      internalError: internalError ? internalError.slice(0, 16_384) : null,
      failedAt: new Date(),
    },
  }).catch(() => undefined)
}

/**
 * Run the HLS pipeline for an import whose `sourceType` is hls_master/media.
 * Returns the remuxed output path + the provider upload metadata.
 */
async function processHlsImport(
  job: Job<RemoteImportJobData>,
  record: {
    id: string
    userId: string
    folderId: string | null
    connectedAccountId: string | null
    fileName: string
    mimeType: string | null
    sourceType: string | null
    hlsVariantId: string | null
    hlsAudioTrackId: string | null
    hlsOutputContainer: string | null
    hlsIsLive: boolean | null
    hlsRecordingDurationSeconds: number | null
    sourceUrlEncrypted: string
    fileId: string | null
    retryFromStage?: string | null
  },
) {
  const importId = record.id
  const userId = record.userId
  const folderId = record.folderId
  const sourceUrl = decryptText(record.sourceUrlEncrypted)

  if (!env.REMOTE_IMPORT_HLS_ENABLED) {
    await markFailed(importId, 'HLS_DISABLED', 'HLS imports are disabled.')
    return null
  }

  const jobDir = hlsJobDir(userId, importId)
  await ensureJobDir(jobDir)

  // A convert-only retry (`retryRemoteConvert`) re-enqueues WITHOUT wiping the
  // job dir; a `resume.json` marker in it tells us to resume at the remux step.
  // A generic Retry wipes the dir, so an absent marker always means a full run.
  const resumeMarker = await readResumeMarker(jobDir)

  const signalController = new AbortController()
  // The worker checks the DB between phases; this controller is only for
  // cancel requests that arrive DURING a phase (polled below). The same 5s
  // loop doubles as the heartbeat writer (§38): an idle FFmpeg process still
  // proves the worker is alive.
  const pollCancel = setInterval(async () => {
    const current = await prisma.remoteImport.findUnique({ where: { id: importId } }).catch(() => null)
    if (current?.status === 'cancelled') signalController.abort()
    else if (current?.status === 'processing') await writeHeartbeat(importId)
  }, 5000)

  try {
    // ── Stage-aware retry (§32) ─────────────────────────────────────────────
    // `retryFromStage` is set server-side by the retry API. Resume rather than
    // re-run:
    //  - `registering` — the provider upload already succeeded and the File
    //    row exists; only the finalize step remains (no second upload — the
    //    stored provider object must never be duplicated).
    //  - `uploading` — the remuxed output exists on disk and is valid; skip
    //    FFmpeg (and segment download) entirely, upload + register.
    //  - `remuxing`    — segments materialized; `resume.json` carries the
    //    resolved playlist so the pipeline resumes at remux.
    //  - otherwise — full run (segments → remux → upload).
    const retryFromStage = record.retryFromStage

    if (retryFromStage === 'registering' && record.fileId) {
      await updateStage(importId, STAGES.REGISTERING)
      const existing = await prisma.file.findUnique({ where: { id: record.fileId } })
      if (existing) {
        await prisma.remoteImport.update({
          where: { id: importId },
          data: {
            status: 'completed',
            stage: STAGES.FINISHED,
            fileId: existing.id,
            completedAt: new Date(),
            tempPath: null,
            finalUrlEncrypted: encryptText(sourceUrl),
          },
        })
        logProgress(importId, STAGES.FINISHED, 'hls register-retry completed')
        if (record.connectedAccountId) {
          const prov = existing.provider ?? ''
          if (prov === 's3') syncS3Quota(record.connectedAccountId).catch(() => undefined)
          else syncGoogleQuota(record.connectedAccountId).catch(() => undefined)
        }
        return { outputPath: null }
      }
      // File row gone (shouldn't happen) — fall through to a full re-run.
    }

    // A convert-only retry resumes at remuxing (marker present); a full run
    // materializes segments first. Only the stage label differs — the pipeline
    // decides the real resume by the marker handed below.
    let outputPath: string | null = null
    // Metadata for the upload/finalize tail; empty for an upload-resume (only
    // the container is known), fully populated by a pipeline run.
    let mediaDurationSeconds: number | null = null
    let segmentCount: number | null = null
    let outputDurationSeconds: number | null = null
    let outputCodecSummary: string | undefined = undefined
    let downloadedBytes: bigint = 0n
    let mimeCodeSuffix: 'mp4' | 'mkv' = 'mkv'
    if (retryFromStage === 'uploading') {
      // The output already exists and was verified last attempt (§32 Case C).
      // Locate it (the container may have been auto-resolved), verify again
      // (cheap), then jump to upload.
      for (const ext of ['mp4', 'mkv'] as const) {
        const candidate = `${jobDir}/output.${ext}`
        try {
          await fsp.access(candidate)
          outputPath = candidate
          mimeCodeSuffix = ext
          break
        } catch {
          /* try next container */
        }
      }
      if (outputPath) {
        await updateStage(importId, STAGES.VERIFYING)
        const verification = await verifyOutput(outputPath, { expectVideo: true, expectAudio: Boolean(record.hlsAudioTrackId && resumeMarker?.expectAudio) })
        outputDurationSeconds = verification.durationSeconds
        outputCodecSummary = verification.codecs.join(', ')
      } else {
        // Output vanished — fall back to a full run below.
        outputPath = null
      }
    }

    if (!outputPath) {
      // Full run or remux-resume: run the pipeline.
      await updateStage(importId, resumeMarker ? STAGES.REMUXING : STAGES.SEGMENTS)
      const pipeline = await runHlsPipeline({
        jobDir,
        sourceUrl,
        isLive: Boolean(record.hlsIsLive),
        recordingDurationSeconds: record.hlsRecordingDurationSeconds ?? undefined,
        selection: {
          variantId: record.hlsVariantId,
          audioTrackId: record.hlsAudioTrackId,
          outputContainer: (record.hlsOutputContainer as ContainerChoice) ?? 'auto',
        },
        // Convert-only resume: reuse the materialized segments on disk; the
        // marker carries the resolved playlist URLs + container + expectAudio.
        ...(resumeMarker
          ? {
              resume: {
                playlistUrl: resumeMarker.playlistUrl,
                audioPlaylistUrl: resumeMarker.audioPlaylistUrl,
                container: resumeMarker.container,
                expectAudio: resumeMarker.expectAudio,
              },
            }
          : {}),
        signal: signalController.signal,
        onProgress: async (p) => {
          if (p.stage === 'segments' || p.stage === 'live' || p.stage === 'recording') {
            await updateStage(importId, STAGES.SEGMENTS, {
              hlsCompletedSegmentCount: p.segmentsCompleted,
              hlsSegmentCount: p.segmentsTotal,
              hlsMediaDurationSeconds: p.mediaDurationSeconds ?? null,
              downloadedBytes: p.downloadedBytes?.toString(),
            })
          } else if (p.stage === 'remux') {
            await updateStage(importId, STAGES.REMUXING, { remuxProgress: p.remuxPercent ?? null })
          }
        },
      })

      if (!pipeline) {
        await markFailed(importId, 'HLS_INVALID_MANIFEST', 'The source is not a valid HLS playlist.')
        return null
      }
      outputPath = pipeline.outputPath
      mediaDurationSeconds = pipeline.mediaDurationSeconds
      segmentCount = pipeline.segmentCount
      outputDurationSeconds = pipeline.outputDurationSeconds
      outputCodecSummary = pipeline.codecSummary
      downloadedBytes = pipeline.downloadedBytes
      mimeCodeSuffix = pipeline.container
    }

    // ── Finalize HLS metadata before upload. ────────────────────────────────
    await updateStage(importId, STAGES.VERIFYING, {
      hlsMediaDurationSeconds: mediaDurationSeconds,
      hlsSegmentCount: segmentCount,
      outputDurationSeconds: outputDurationSeconds,
      outputCodecSummary: outputCodecSummary?.slice(0, 191) ?? null,
      remuxProgress: null,
    })

    // ── Storage selection (same routing as direct imports). ─────────────────
    await updateStage(importId, STAGES.SELECTING_STORAGE)
    // Placement: a user-chosen account pin (import record) is authoritative —
    // the import fails with a clear quota error rather than silently switching
    // providers. Without a pin, Automatic routing applies (destination folder
    // locations are only a soft preference).
    let placement
    try {
      const reportedBytes = downloadedBytes > 0n ? downloadedBytes : BigInt((await fsp.stat(outputPath!)).size)
      placement = await resolveUploadPlacement(userId, folderId, record.connectedAccountId, reportedBytes, undefined, 'remote-import')
    } catch (error: any) {
      const code = error?.code === 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' ? 'NO_ACCOUNT_WITH_ENOUGH_SPACE' : (error?.code ?? 'IMPORT_FAILED')
      await markFailed(importId, code, error?.message ?? 'No connected storage account has enough space.')
      return null
    }
    const account = placement.connectedAccount

    // ── Upload the remuxed file. ────────────────────────────────────────────
    // The provider object must carry the user's CANONICAL name
    // (`record.fileName`), never the pipeline-derived one (playlist basename
    // or `output.<ext>`) — the name shown in the create modal is the name
    // ultimately uploaded (§3/§5).
    const mimeType = record.mimeType ?? (mimeCodeSuffix === 'mp4' ? 'video/mp4' : 'video/x-matroska')
    const uploaded = await uploadTempFile(
      importId,
      { id: account.id, provider: account.provider },
      userId,
      folderId,
      record.fileName,
      mimeType,
      outputPath!,
      placement.folderStorageLocation.providerFolderId,
    )
    const sizeBytes = BigInt((await fsp.stat(outputPath!)).size)

    // ── Register + link. ────────────────────────────────────────────────────
    const file = await registerFile(importId, { ...record, connectedAccountId: account.id, fileName: record.fileName, mimeType }, uploaded.providerFileId, sizeBytes)

    await prisma.remoteImport.update({
      where: { id: importId },
      data: {
        status: 'completed',
        stage: STAGES.FINISHED,
        fileId: file.id,
        completedAt: new Date(),
        downloadedBytes: downloadedBytes || sizeBytes,
        uploadedBytes: sizeBytes,
        uploadTotalBytes: sizeBytes,
        tempPath: null,
        finalUrlEncrypted: encryptText(sourceUrl),
      },
    })
    logProgress(importId, STAGES.FINISHED, 'hls import completed')

    if (account.provider === 's3') syncS3Quota(account.id).catch(() => undefined)
    else syncGoogleQuota(account.id).catch(() => undefined)

    // Success: a convert-only retry just completed — drop the marker so the
    // job dir is removed by the cleanup below. A fresh run had none anyway.
    await removeResumeMarker(jobDir).catch(() => undefined)
    return { outputPath: outputPath! }
  } finally {
    clearInterval(pollCancel)
    // Keep the job dir ONLY while a resume marker exists (a remux/verify
    // failure leaves one so a convert-only retry can reuse the segments).
    // Success and pre-remux failures leave no marker and get cleaned up.
    if (!(await readResumeMarker(jobDir))) {
      await removeJobDir(jobDir).catch(() => undefined)
    }
  }
}

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

  const userId = record.userId
  const folderId = record.folderId
  const fileName = sanitizeFileName(record.fileName)
  const mimeType = record.mimeType ?? 'application/octet-stream'
  const sourceUrl = decryptText(record.sourceUrlEncrypted)
  const maxBytes = BigInt(env.REMOTE_IMPORT_MAX_BYTES)
  const startedAt = Date.now()
  const jobTimeoutMs = env.REMOTE_IMPORT_JOB_TIMEOUT_HOURS * 60 * 60 * 1000

  const assertWithinTimeout = () => {
    if (Date.now() - startedAt > jobTimeoutMs) {
      throw new AppError('IMPORT_TIMEOUT', `Import exceeded the ${env.REMOTE_IMPORT_JOB_TIMEOUT_HOURS}h time limit.`, 408)
    }
  }

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

    // ── HLS imports skip the direct-download path entirely. ─────────────────
    if (isHlsRecord(record)) {
      const result = await processHlsImport(job, record)
      if (result) return
      // processHlsImport already finalized status on failure; just return.
      return
    }

    // Probe the URL: follow redirects with SSRF validation, get size/range.
    // A ranged GET (`bytes=0-0`) keeps the probe cheap; servers that ignore
    // the range still answer 200 with a full body, which we abort after the
    // first chunk (we only need headers + content-length).
    let finalUrl: string
    try {
      const probe = await followRemoteUrl(sourceUrl, {
        headers: { Range: 'bytes=0-0' },
        onResponse: async (res) => {
          const length = res.headers['content-length']
          const supportsRange = res.headers['accept-ranges'] === 'bytes' || res.statusCode === 206
          if (typeof (res.body as { on?: unknown }).on === 'function') {
            (res.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
          }
          const reader = res.body[Symbol.asyncIterator]()
          await reader.next().catch(() => undefined)
          await reader.return?.().catch(() => undefined)
          return { length, supportsRange }
        },
      })
      finalUrl = probe.finalUrl
      if (probe.result.length) {
        const declared = BigInt(probe.result.length)
        if (declared > maxBytes) {
          await markFailed(importId, 'DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.')
          return
        }
        await prisma.remoteImport.update({ where: { id: importId }, data: { totalBytes: declared, sourceRangeSupported: probe.result.supportsRange } })
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'DOWNLOAD_TOO_LARGE') {
        await markFailed(importId, 'DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.')
        return
      }
      throw error
    }

    const downloaded = await downloadToTemp(importId, finalUrl, maxBytes)
    finalUrl = downloaded.finalUrl

    assertWithinTimeout()

    // Re-check cancellation between phases.
    const afterDownload = await prisma.remoteImport.findUnique({ where: { id: importId } })
    if (afterDownload?.status === 'cancelled') {
      await removeTempFile(importId)
      return
    }

    assertWithinTimeout()

    // Select destination account (default routing or pinned account).
    await updateStage(importId, STAGES.SELECTING_STORAGE)
    // Placement: a user-chosen account pin (import record) is authoritative —
    // the import fails with a clear quota error rather than silently switching
    // providers. Without a pin, Automatic routing applies (destination folder
    // locations are only a soft preference).
    let placement
    try {
      placement = await resolveUploadPlacement(userId, folderId, record.connectedAccountId, downloaded.contentLength ?? 0n, undefined, 'remote-import')
    } catch (error: any) {
      const code = error?.code === 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' ? 'NO_ACCOUNT_WITH_ENOUGH_SPACE' : (error?.code ?? 'IMPORT_FAILED')
      await markFailed(importId, code, error?.message ?? 'No connected storage account has enough space.')
      await removeTempFile(importId)
      return
    }
    const account = placement.connectedAccount

    // Upload. `uploadTempFile` starts the upload phase (stage + uploadTotalBytes
    // from the local file) and writes throttled progress for both providers.
    const uploaded = await uploadTempFile(importId, { id: account.id, provider: account.provider }, userId, folderId, fileName, mimeType, downloaded.tempPartPath, placement.folderStorageLocation.providerFolderId)
    assertWithinTimeout()
    await updateStage(importId, STAGES.REGISTERING)

    // Register file + link the import row.
    const sizeBytes = downloaded.contentLength ?? (await fsp.stat(downloaded.tempPartPath)).size
    const file = await registerFile(importId, { ...record, connectedAccountId: account.id, fileName, mimeType }, uploaded.providerFileId, BigInt(sizeBytes))

    const totalSize = BigInt(sizeBytes)
    await prisma.remoteImport.update({
      where: { id: importId },
      data: {
        status: 'completed',
        stage: STAGES.FINISHED,
        fileId: file.id,
        completedAt: new Date(),
        downloadedBytes: totalSize,
        uploadedBytes: totalSize,
        uploadTotalBytes: totalSize,
        tempPath: null,
        finalUrlEncrypted: encryptText(finalUrl),
      },
    })
    logProgress(importId, STAGES.FINISHED, 'import completed')

    // Quota sync (best-effort).
    if (account.provider === 's3') syncS3Quota(account.id).catch(() => undefined)
    else syncGoogleQuota(account.id).catch(() => undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const code = error instanceof AppError ? error.code : 'IMPORT_FAILED'
    const meta = (error as { meta?: string })?.meta
    await markFailed(importId, code, message, meta)
    console.error(`[remote-import] ${importId} failed: ${code} ${message}${meta ? ` :: ${meta.slice(-800)}` : ''}`)
  } finally {
    await removeTempFile(importId)
  }
}