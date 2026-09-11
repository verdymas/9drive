import fsp from 'node:fs/promises'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { encryptText } from '../../utils/crypto.js'
import { syncGoogleQuota } from '../google/google.service.js'
import { syncS3Quota } from '../s3/s3.service.js'
import { syncTelegramUsage } from '../telegram/telegram-usage.service.js'
import { resolveUploadPlacement } from '../storage/upload-placement.service.js'
import { createSecureFetcherForWorkerId, type SecureRemoteFetcher } from './secure-fetcher.js'
import { registerFile, uploadTempFile } from './processor-upload.js'
import { STAGES, type RemoteImportProcessorContext } from './processor-context.js'
import { buildHlsPipelineSelection } from './processor-hls-selection.js'
import { type ContainerChoice } from './hls/output.js'
import { runHlsPipeline } from './hls/pipeline.js'
import { hlsJobDir, readResumeMarker, removeJobDir, removeResumeMarker, writeResumeMarker } from './hls/job-dir.js'
import { ensureJobDir } from './hls/materializer.js'
import { verifyOutput } from './hls/verify.js'

export type HlsRecord = {
  id: string
  userId: string
  folderId: string | null
  connectedAccountId: string | null
  workerId: string | null
  fileName: string
  mimeType: string | null
  sourceType: string | null
  hlsVariantId: string | null
  hlsAudioTrackId: string | null
  hlsOutputContainer: string | null
  hlsIsLive: boolean | null
  hlsRecordingDurationSeconds: number | null
  fileId: string | null
  retryFromStage?: string | null
}

export type HlsProcessorDependencies = {
  assertWorkerUsable(record: Pick<HlsRecord, 'workerId'>): Promise<void>
}

/**
 * Run the HLS pipeline for an import whose `sourceType` is hls_master/media.
 * The orchestration owns only HLS-specific lifecycle; shared provider upload
 * and registration remain in processor-upload.ts.
 */
export async function processHlsImport(
  context: RemoteImportProcessorContext,
  outerFetcher: SecureRemoteFetcher | null | undefined,
  dependencies: HlsProcessorDependencies,
) {
  const record = context.record as HlsRecord
  const importId = context.importId
  const userId = context.userId
  const folderId = context.folderId
  const sourceUrl = context.sourceUrl
  const requestContext = context.requestContext

  if (!env.REMOTE_IMPORT_HLS_ENABLED) {
    await context.markFailed('HLS_DISABLED', 'HLS imports are disabled.')
    return null
  }

  // Worker guard lives at the top of the HLS path too (the direct path guards
  // in processRemoteImportJob; HLS may also be reached via retry-convert).
  await dependencies.assertWorkerUsable(record)
  const fetcher = outerFetcher ?? (await createSecureFetcherForWorkerId(record.workerId, { requestContext, sourceUrl }))

  const jobDir = hlsJobDir(userId, importId)
  const reservation = await context.admitTempStorage('segments', null)
  if (!reservation) return 'deferred' as const
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
    else if (current?.status === 'processing') await context.heartbeat()
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
      await context.updateStage(STAGES.REGISTERING)
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
        context.logProgress(STAGES.FINISHED, 'hls register-retry completed')
        if (record.connectedAccountId) {
          const prov = existing.provider ?? ''
          if (prov === 's3') syncS3Quota(record.connectedAccountId).catch(() => undefined)
          else if (prov === 'telegram') syncTelegramUsage(record.connectedAccountId).catch(() => undefined)
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
        await context.updateStage(STAGES.VERIFYING)
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
      await context.updateStage(resumeMarker ? STAGES.REMUXING : STAGES.SEGMENTS)
      const pipeline = await runHlsPipeline({
        jobDir,
        sourceUrl,
        requestContext,
        fetcher,
        isLive: Boolean(record.hlsIsLive),
        recordingDurationSeconds: record.hlsRecordingDurationSeconds ?? undefined,
        selection: buildHlsPipelineSelection({
          variantId: record.hlsVariantId,
          audioTrackId: record.hlsAudioTrackId,
          outputContainer: record.hlsOutputContainer,
        }),
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
            await context.updateStage(STAGES.SEGMENTS, {
              hlsCompletedSegmentCount: p.segmentsCompleted,
              hlsSegmentCount: p.segmentsTotal,
              hlsMediaDurationSeconds: p.mediaDurationSeconds ?? null,
              downloadedBytes: p.downloadedBytes?.toString(),
            })
          } else if (p.stage === 'remux') {
            await context.updateStage(STAGES.REMUXING, { remuxProgress: p.remuxPercent ?? null })
          }
        },
      })

      if (!pipeline) {
        await context.markFailed('HLS_INVALID_MANIFEST', 'The source is not a valid HLS playlist.')
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
    await context.updateStage(STAGES.VERIFYING, {
      hlsMediaDurationSeconds: mediaDurationSeconds,
      hlsSegmentCount: segmentCount,
      outputDurationSeconds,
      outputCodecSummary: outputCodecSummary?.slice(0, 191) ?? null,
      remuxProgress: null,
    })

    // ── Storage selection (same routing as direct imports). ─────────────────
    await context.updateStage(STAGES.SELECTING_STORAGE)
    // Placement: a user-chosen account pin (import record) is authoritative —
    // the import fails with a clear quota error rather than silently switching
    // providers. Without a pin, Automatic routing applies (destination folder
    // locations are only a soft preference).
    let placement
    try {
      const reportedBytes = downloadedBytes > 0n ? downloadedBytes : BigInt((await fsp.stat(outputPath!)).size)
      placement = await resolveUploadPlacement(userId, folderId, record.connectedAccountId, reportedBytes, undefined, 'remote-import')
    } catch (error: any) {
      // GOOGLE_REAUTH_REQUIRED / TELEGRAM_SESSION_INVALID must preserve the
      // remuxed output: write a resume marker so the job dir survives (the
      // finally keeps the dir only while a marker exists) and the retry resumes
      // at 'uploading' — the output file is already on disk, so no FFmpeg or
      // segment re-download.
      if (error?.code === 'GOOGLE_REAUTH_REQUIRED') {
        await writeResumeMarker(jobDir, {
          version: 1,
          mode: 'remux-only',
          playlistUrl: sourceUrl,
          audioPlaylistUrl: null,
          container: mimeCodeSuffix,
          expectAudio: Boolean(record.hlsAudioTrackId || record.sourceType === 'hls_media'),
          mediaDurationSeconds: mediaDurationSeconds ?? 0,
        }).catch(() => undefined)
        await context.markFailed('GOOGLE_REAUTH_REQUIRED', 'Google Drive authorization expired. Reconnect the account, then retry.')
        return null
      }
      if (error?.code === 'TELEGRAM_SESSION_INVALID') {
        await writeResumeMarker(jobDir, {
          version: 1,
          mode: 'remux-only',
          playlistUrl: sourceUrl,
          audioPlaylistUrl: null,
          container: mimeCodeSuffix,
          expectAudio: Boolean(record.hlsAudioTrackId || record.sourceType === 'hls_media'),
          mediaDurationSeconds: mediaDurationSeconds ?? 0,
        }).catch(() => undefined)
        await context.markFailed('TELEGRAM_SESSION_INVALID', 'Telegram authorization expired. Reconnect the account, then retry.')
        return null
      }
      const code = error?.code === 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT' ? 'NO_ACCOUNT_WITH_ENOUGH_SPACE' : (error?.code ?? 'IMPORT_FAILED')
      await context.markFailed(code, error?.message ?? 'No connected storage account has enough space.')
      return null
    }
    const account = placement.connectedAccount

    // ── Upload the remuxed file. ────────────────────────────────────────────
    // The provider object must carry the user's CANONICAL name
    // (`record.fileName`), never the pipeline-derived one.
    console.debug(`[remote-import:filename] stage=upload canonical=${record.fileName}`)
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
    const file = await registerFile(importId, { ...record, connectedAccountId: account.id, fileName: record.fileName, mimeType }, uploaded.providerFileId, sizeBytes, { existingFileId: uploaded.fileId ?? undefined })

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
    context.logProgress(STAGES.FINISHED, 'hls import completed')

    if (account.provider === 's3') syncS3Quota(account.id).catch(() => undefined)
    else if (account.provider === 'telegram') syncTelegramUsage(account.id).catch(() => undefined)
    else syncGoogleQuota(account.id).catch(() => undefined)

    // Success: a convert-only retry just completed — drop the marker so the
    // job dir is removed by the cleanup below. A fresh run had none anyway.
    await removeResumeMarker(jobDir).catch(() => undefined)
    return { outputPath: outputPath! }
  } finally {
    reservation.release()
    clearInterval(pollCancel)
    // Keep the job dir ONLY while a resume marker exists (a remux/verify
    // failure leaves one so a convert-only retry can reuse the segments).
    // Success and pre-remux failures leave no marker and get cleaned up.
    if (!(await readResumeMarker(jobDir))) {
      await removeJobDir(jobDir).catch(() => undefined)
    }
  }
}
