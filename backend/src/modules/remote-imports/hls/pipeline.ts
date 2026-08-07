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
import { materializeMedia, fetchMediaPlaylistSegments, buildSegmentCacheSeed } from './materialize.js'
import { resolveSelectedVariant, resolveSelectedAudio } from './selection.js'
import { resolveContainer, containerExtension, shouldAutoFallbackToMkv, type ContainerChoice } from './output.js'
import * as ffmpeg from './ffmpeg.js'
import { verifyOutput, type MediaVerification } from './verify.js'
import { ensureJobDir } from './materializer.js'
import { writeResumeMarker } from './job-dir.js'
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
  /**
   * Convert-only retry: skip the master-manifest fetch, variant/audio
   * selection and live poll — reuse the already-materialized segments on disk.
   * `playlistUrl` is the final media playlist URL; the pipeline re-fetches it
   * (cheap) to derive segment URIs, seeds `materializeMedia`'s `segmentCache`
   * with the on-disk filenames, and resumes at the remux step. `container` /
   * `expectAudio` honour the original selection.
   */
  resume?: {
    playlistUrl: string
    audioPlaylistUrl: string | null
    container: 'mkv' | 'mp4'
    expectAudio: boolean
  }
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
  const { jobDir, sourceUrl, selection, isLive, signal, recordingDurationSeconds, resume } = opts
  await ensureJobDir(jobDir)

  // Resolved during the run; needed to write the resume marker on remux failure.
  let videoPlaylistUrl: string
  let audioPlaylistUrl: string | null = null
  let expectAudio: boolean
  let container: 'mkv' | 'mp4'

  // ── 1–4 (fresh run): fetch + parse source, select variant/audio, poll. ────
  let segmentCache = new Map<string, string>()
  let allVideoSegments: NormalizedSegment[]

  if (resume) {
    // ── Convert-only retry: reuse the on-disk segments. ────────────────────
    // Skip the master manifest + variant/audio selection (the marker already
    // holds the resolved child playlist). Re-fetch the media playlist (cheap)
    // to derive segment URIs, then seed materializeMedia's cache with the
    // deterministic on-disk filenames so nothing is re-downloaded.
    assertNotAborted(signal)
    videoPlaylistUrl = resume.playlistUrl
    audioPlaylistUrl = resume.audioPlaylistUrl
    expectAudio = resume.expectAudio
    container = resume.container

    allVideoSegments = await resolveMediaSegments(videoPlaylistUrl)
    segmentCache = buildSegmentCacheSeed(jobDir, allVideoSegments, 'video')
  } else {
    // ── 1. Fetch + parse the ORIGINAL source manifest. ─────────────────────
    let sourceInfo: HlsManifestInfo
    try {
      const { body, finalUrl } = await fetchManifest(sourceUrl)
      sourceInfo = parseManifest(body, finalUrl)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(HLS_ERROR_CODES.HLS_INVALID_MANIFEST, HLS_ERROR_MESSAGES.HLS_INVALID_MANIFEST, 400)
    }

    // ── 2. Resolve the selected media playlist(s). ──────────────────────────
    let selectedVariant: HlsVariantMetadata | null = null
    let selectedAudio: HlsAudioTrackMetadata | null = null
    if (sourceInfo.sourceType === 'master') {
      selectedVariant = resolveSelectedVariant(sourceInfo.variants, selection.variantId)
      selectedAudio = resolveSelectedAudio(sourceInfo.audioTracks, selection.audioTrackId ?? null)
      videoPlaylistUrl = selectedVariant.childPlaylistUrl
    } else {
      videoPlaylistUrl = sourceInfo.manifestUrl
    }

    // ── 3. Fetch the (first) media playlist snapshot. ───────────────────────
    const firstVideoSegments = await resolveMediaSegments(videoPlaylistUrl)
    allVideoSegments = [...firstVideoSegments]

    // ── 4. LIVE recording: poll until the target is hit. ────────────────────
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

    // Optional alternate audio.
    if (selectedAudio?.playlistUrl) {
      audioPlaylistUrl = selectedAudio.playlistUrl
      const audioSegments = await resolveMediaSegments(audioPlaylistUrl)
      await materializeMedia({ jobDir, mediaLabel: 'audio', segments: audioSegments, segmentCache, signal })
    }

    expectAudio = Boolean(audioPlaylistUrl) || sourceInfo.sourceType === 'media'

    // ── 6. Verify FFmpeg + resolve container. ───────────────────────────────
    ffmpeg.verifyFfmpegAvailable()
    container = resolveContainer(selection.outputContainer, {
      hasSeparateAudio: Boolean(audioPlaylistUrl),
      hasSubtitles: false,
      hasDiscontinuities: allVideoSegments.some((s) => s.discontinuity),
    })
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

  // ── (resume) Optional alternate audio. ────────────────────────────────────
  if (resume && audioPlaylistUrl) {
    const audioSegments = await resolveMediaSegments(audioPlaylistUrl)
    const audioCache = buildSegmentCacheSeed(jobDir, audioSegments, 'audio')
    await materializeMedia({ jobDir, mediaLabel: 'audio', segments: audioSegments, segmentCache: audioCache, signal })
  }

  // ── 7. Remux. ─────────────────────────────────────────────────────────────
  const mediaSeconds = safeMediaDuration(allVideoSegments.reduce((sum, s) => sum + s.duration, 0))
  const onFfmpegProgress = (p: { percent: number | null }) => opts.onProgress?.({ stage: 'remux', remuxPercent: p.percent })

  // `actualContainer` tracks the real output container: auto-selected MP4 may
  // fall back to MKV below if the stream-copy mux fails.
  let actualContainer: 'mkv' | 'mp4' = container

  const outputPartPath = (c: 'mkv' | 'mp4') => path.join(jobDir, `output.${containerExtension(c)}.part`)

  // On a terminal remux/verify failure, write the resume marker so a
  // convert-only retry can reuse the materialized segments, then rethrow the
  // original error (the processor marks the row failed). The write is AWAITED:
  // the processor's cleanup keeps the job dir only while a marker exists, so
  // the marker must be on disk before the error reaches it — a fire-and-forget
  // write here races with that check and loses (the dir gets wiped).
  const writeMarkerAndRethrow = async (error: unknown): Promise<never> => {
    if (error instanceof AppError && (error.code === HLS_ERROR_CODES.HLS_REMUX_FAILED || error.code === HLS_ERROR_CODES.HLS_OUTPUT_INVALID)) {
      await writeResumeMarker(jobDir, {
        version: 1,
        mode: 'remux-only',
        playlistUrl: videoPlaylistUrl,
        audioPlaylistUrl,
        container: actualContainer,
        expectAudio,
        mediaDurationSeconds: mediaSeconds,
      }).catch((writeError) => {
        console.error('[hls] failed to write resume marker:', writeError instanceof Error ? writeError.message : String(writeError))
      })
    }
    throw error
  }

  // Conversion chain, mirroring the known-good script (code_example_convert.sh):
  //   1. stream-copy remux (fast path),
  //   2. auto-selected MP4 that fails to copy-mux → retry as MKV (safe default
  //      for raw HLS streams; a user-selected container is never changed),
  //   3. any copy failure → re-encode (H.264 + AAC) as a last resort.
  // A re-encode always succeeds or we fail; the marker is written on a terminal
  // failure so a convert-only retry can reuse the downloaded segments.
  const runRemux = async (forContainer: 'mkv' | 'mp4'): Promise<ffmpeg.FfmpegRunResult> => {
    try {
      return await ffmpeg.runFfmpegRemux(video.localPlaylistPath, outputPartPath(forContainer), forContainer, jobDir, signal, onFfmpegProgress, mediaSeconds)
    } catch (error) {
      // Auto-selected MP4: if the mux failed (e.g. a container that cannot hold
      // the stream-copied codec), retry once with MKV, which is the safe
      // default for raw HLS streams.
      if (error instanceof AppError && error.code === HLS_ERROR_CODES.HLS_REMUX_FAILED && forContainer === 'mp4' && shouldAutoFallbackToMkv(selection.outputContainer)) {
        actualContainer = 'mkv'
        try {
          return await ffmpeg.runFfmpegRemux(video.localPlaylistPath, outputPartPath(actualContainer), actualContainer, jobDir, signal, onFfmpegProgress, mediaSeconds)
        } catch (fallbackError) {
          return runReencode(actualContainer, fallbackError)
        }
      }
      return runReencode(forContainer, error)
    }
  }

  // Re-encode (H.264 + AAC) the local playlist — handles image2/png-pipe and
  // other sources a stream copy cannot mux. On failure, write the marker +
  // rethrow.
  const runReencode = async (forContainer: 'mkv' | 'mp4', originalError: unknown): Promise<ffmpeg.FfmpegRunResult> => {
    try {
      return await ffmpeg.runFfmpegReencode(video.localPlaylistPath, outputPartPath(forContainer), forContainer, jobDir, signal, onFfmpegProgress, mediaSeconds)
    } catch (error) {
      return writeMarkerAndRethrow(error)
    }
  }

  const remux = await runRemux(actualContainer)

  // ── 8. Verify output. ─────────────────────────────────────────────────────
  const verification: MediaVerification = await (async (): Promise<MediaVerification> => {
    try {
      return await verifyOutput(remux.outputPath, { expectVideo: true, expectAudio })
    } catch (error) {
      return writeMarkerAndRethrow(error)
    }
  })()

  // ── 9. Final file name (matches the container). ───────────────────────────
  const extension = containerExtension(actualContainer)
  const baseName = path.basename(new URL(videoPlaylistUrl).pathname).replace(/\.m3u8?$/i, '') || 'video'
  const fileName = hlsDerivedFileName(baseName, extension)

  return {
    outputPath: remux.outputPath,
    container: actualContainer,
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