/**
 * HLS remote-import pipeline driver (§5, §7, §11, §14-§16 of the spec).
 *
 * Flow for an HLS import:
 *
 *   1. Fetch + parse the source manifest (master or media).
 *   2. Resolve the selected variant (+ optional alternate audio) from the
 *      FRESH playlist — a client-supplied raw URL is never trusted.
 *   3. Fetch + parse the selected media playlist(s).
 *   4. materializeMedia(): download maps/keys/segments into the job dir and
 *      write REWRITTEN local playlists (video.m3u8 / audio.m3u8).
 *   5. LIVE imports: poll the media playlist, accumulating NEW segments into
 *      the job dir's segment cache, until the recording duration is reached.
 *   6. Verify FFmpeg availability, resolve the output container.
 *   7. runFfmpegRemux(): local-input remux with `-protocol_whitelist file,crypto`.
 *   8. verifyOutput(): ffprobe JSON + size checks.
 *
 * The output is the FINAL remuxed local file path + metadata that the caller
 * (processor) uploads and registers. All errors are stable AppError codes;
 * no internal path or URL is ever part of a message.
 */
import path from 'node:path'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'
import { fetchManifest, parseManifest, type HlsAudioTrackMetadata, type HlsManifestInfo, type HlsVariantMetadata } from './manifest.js'
import { materializeMedia, fetchMediaPlaylistSegments } from './materialize.js'
import { resolveSelectedVariant, resolveSelectedAudio } from './selection.js'
import { resolveContainer, containerExtension, type ContainerChoice } from './output.js'
import { runFfmpegRemux, verifyFfmpegAvailable } from './ffmpeg.js'
import { verifyOutput, type MediaVerification } from './verify.js'
import { ensureJobDir } from './materializer.js'
import type { NormalizedSegment } from './segments.js'
import { hlsDerivedFileName, fileNameHasExtension } from './output.js'

export type HlsSelection = {
  variantId: string | null | undefined
  audioTrackId: string | null | undefined
  outputContainer: ContainerChoice
}

export type HlsPipelineOptions = {
  jobDir: string
  sourceUrl: string
  selection: HlsSelection
  isLive: boolean
  recordingDurationSeconds?: number
  signal?: AbortSignal
  onProgress?: (progress: {
    stage: string
    segmentsCompleted?: number
    segmentsTotal?: number
    remuxPercent?: number | null
    mediaDurationSeconds?: number
    downloadedBytes?: bigint
  }) => void
}

export type HlsPipelineResult = {
  outputPath: string
  container: 'mkv' | 'mp4'
  verification: MediaVerification
  fileName: string
  mediaDurationSeconds: number
  segmentCount: number
  downloadedBytes: bigint
  outputDurationSeconds: number | null
  codecSummary: string
}

function safeMediaDuration(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    const err = new AppError('ABORTED', 'The import was cancelled.', 499)
    err.name = 'AbortError'
    throw err
  }
}

/** Re-fetch + parse a media playlist into normalized segments. */
async function resolveMediaSegments(playlistUrl: string): Promise<NormalizedSegment[]> {
  const fetched = await fetchMediaPlaylistSegments(playlistUrl)
  if (fetched.length === 0) throw new AppError(HLS_ERROR_CODES.HLS_NO_VALID_VARIANT, HLS_ERROR_MESSAGES.HLS_NO_VALID_VARIANT, 400)
  return fetched
}

/**
 * Run the full HLS pipeline. `sourceUrl` is the original user-supplied URL —
 * re-fetched and re-parsed fresh (the probe snapshot may be stale). Live/event
 * imports are recorded: the media playlist is polled and segments accumulate in
 * `segmentCache` until `recordingDurationSeconds` of media time, then remuxed.
 */
export async function runHlsPipeline(opts: HlsPipelineOptions): Promise<HlsPipelineResult> {
  const { jobDir, sourceUrl, selection, isLive, signal, recordingDurationSeconds } = opts
  await ensureJobDir(jobDir)

  // ── 1. Fetch + parse the ORIGINAL source manifest. ───────────────────────
  let sourceInfo: HlsManifestInfo
  try {
    const { body, finalUrl } = await fetchManifest(sourceUrl)
    sourceInfo = parseManifest(body, finalUrl)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(HLS_ERROR_CODES.HLS_INVALID_MANIFEST, HLS_ERROR_MESSAGES.HLS_INVALID_MANIFEST, 400)
  }

  // ── 2. Resolve the selected media playlist(s). ────────────────────────────
  let videoPlaylistUrl: string
  let selectedVariant: HlsVariantMetadata | null = null
  let selectedAudio: HlsAudioTrackMetadata | null = null
  const videoSourceType: 'master' | 'media' = sourceInfo.sourceType === 'master' ? 'master' : 'media'

  if (sourceInfo.sourceType === 'master') {
    selectedVariant = resolveSelectedVariant(sourceInfo.variants, selection.variantId)
    selectedAudio = resolveSelectedAudio(sourceInfo.audioTracks, selection.audioTrackId ?? null)
    videoPlaylistUrl = selectedVariant.childPlaylistUrl
  } else {
    videoPlaylistUrl = sourceInfo.manifestUrl
  }

  // ── 3. Fetch the (first) media playlist snapshot. ─────────────────────────
  const firstVideoSegments = await resolveMediaSegments(videoPlaylistUrl)

  // ── 4. LIVE recording: poll the media playlist until the target is hit. ──
  const segmentCache = new Map<string, string>()
  const allVideoSegments: NormalizedSegment[] = [...firstVideoSegments]

  if (isLive) {
    const targetSeconds = recordingDurationSeconds ?? env.REMOTE_IMPORT_HLS_MIN_RECORD_SECONDS
    if (!targetSeconds || targetSeconds < env.REMOTE_IMPORT_HLS_MIN_RECORD_SECONDS || targetSeconds > env.REMOTE_IMPORT_HLS_MAX_RECORD_SECONDS) {
      throw new AppError(HLS_ERROR_CODES.HLS_LIVE_DURATION_INVALID, HLS_ERROR_MESSAGES.HLS_LIVE_DURATION_INVALID, 400)
    }

    const pollIntervalMs = Math.max(1000, Math.round((firstVideoSegments[0]?.duration ?? 6) * 1000 * 0.7))

    while (true) {
      assertNotAborted(signal)
      const snapshot = await resolveMediaSegments(videoPlaylistUrl)
      if (snapshot.length > firstVideoSegments.length) {
        allVideoSegments.push(...snapshot.slice(firstVideoSegments.length))
      }
      opts.onProgress?.({
        stage: 'recording',
        mediaDurationSeconds: safeMediaDuration(allVideoSegments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0)),
      })
      if (safeMediaDuration(allVideoSegments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0)) >= targetSeconds) break
      await sleep(pollIntervalMs)
    }
  }

  // ── 5. Materialize the FULL accumulated segment set (cache avoids
  // re-downloading segments already fetched by the live loop). ───────────────
  const video = await materializeMedia({
    jobDir,
    mediaLabel: 'video',
    segments: allVideoSegments,
    segmentCache,
    signal,
    onProgress: (p) => opts.onProgress?.({
      stage: isLive ? 'live' : 'segments',
      segmentsCompleted: p.segmentsCompleted,
      segmentsTotal: p.segmentsTotal,
      mediaDurationSeconds: safeMediaDuration(allVideoSegments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0)),
      downloadedBytes: p.bytesDownloaded,
    }),
  })

  // Optional alternate audio.
  let audioPlaylistUrl: string | null = null
  if (selectedAudio?.playlistUrl) {
    audioPlaylistUrl = selectedAudio.playlistUrl
    const audioSegments = await resolveMediaSegments(audioPlaylistUrl)
    await materializeMedia({ jobDir, mediaLabel: 'audio', segments: audioSegments, segmentCache, signal })
  }

  // ── 6. Verify FFmpeg + resolve container. ─────────────────────────────────
  verifyFfmpegAvailable()
  const container = resolveContainer(selection.outputContainer, {
    hasSeparateAudio: Boolean(audioPlaylistUrl),
    hasSubtitles: false,
    hasDiscontinuities: allVideoSegments.some((s) => s.discontinuity),
  })

  // ── 7. Remux. ─────────────────────────────────────────────────────────────
  const outputPartPath = path.join(jobDir, `output.${containerExtension(container)}.part`)
  const remux = await runFfmpegRemux(
    video.localPlaylistPath,
    outputPartPath,
    container,
    jobDir,
    signal,
    (p) => opts.onProgress?.({ stage: 'remux', remuxPercent: p.percent }),
    safeMediaDuration(allVideoSegments.reduce((sum, s) => sum + s.duration, 0)),
  )

  // ── 8. Verify output. ─────────────────────────────────────────────────────
  const verification = await verifyOutput(remux.outputPath, {
    expectVideo: true,
    expectAudio: Boolean(audioPlaylistUrl) || videoSourceType === 'media',
  })

  // ── 9. Final file name (matches the container). ───────────────────────────
  const extension = containerExtension(container)
  const baseName = path.basename(new URL(videoPlaylistUrl).pathname).replace(/\.m3u8?$/i, '') || 'video'
  const fileName = hlsDerivedFileName(baseName, extension)

  return {
    outputPath: remux.outputPath,
    container,
    verification,
    fileName,
    mediaDurationSeconds: safeMediaDuration(allVideoSegments.reduce((sum, s) => sum + s.duration, 0)),
    segmentCount: allVideoSegments.length,
    downloadedBytes: video.downloadedBytes,
    outputDurationSeconds: verification.durationSeconds,
    codecSummary: verification.codecs.join(', '),
  }
}

/** Re-export container helpers for the processor. */
export { resolveContainer, containerExtension, hlsDerivedFileName, fileNameHasExtension }