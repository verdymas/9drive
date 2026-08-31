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
import fsp from 'node:fs/promises'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'
import { fetchManifest, parseManifest, type HlsAudioTrackMetadata, type HlsManifestInfo, type HlsVariantMetadata } from './manifest.js'
import { materializeMedia, fetchMediaPlaylistSegments, buildSegmentCacheSeed } from './materialize.js'
import { resolveSelectedVariant, resolveSelectedAudio } from './selection.js'
import { resolveContainer, containerExtension, type ContainerChoice } from './output.js'
import * as ffmpeg from './ffmpeg.js'
import { verifyOutput, type MediaVerification } from './verify.js'
import { ensureJobDir, segmentLocalName } from './materializer.js'
import { writeResumeMarker } from './job-dir.js'
import { assertChildAccessible, type RemoteImportRequestContext } from '../request-context.js'
import { buildRewrittenPlaylist, type NormalizedSegment } from './segments.js'
import { hlsDerivedFileName, fileNameHasExtension } from './output.js'
import { validateSegmentFile, type SegmentValidation, selectConcatSegments } from './segment-validator.js'

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
   * User-supplied request context (referer/origin/user-agent/cookie) applied to
   * the master manifest, child playlists, segments, maps, keys and live
   * refresh — everything passes through the centralized header policy.
   */
  requestContext?: RemoteImportRequestContext
  fetcher?: import('../secure-fetcher.js').SecureRemoteFetcher | null
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

/**
 * Re-fetch + parse a media playlist into normalized segments + the original
 * body (the body drives the hls-parser round-trip serialization of the
 * rewritten local playlist).
 */
async function resolveMediaSegments(
  playlistUrl: string,
  requestContext?: RemoteImportRequestContext,
  fetcher?: import('../secure-fetcher.js').SecureRemoteFetcher | null,
): Promise<{ segments: NormalizedSegment[]; body: string }> {
  const fetched = await fetchMediaPlaylistSegments(playlistUrl, requestContext, fetcher ?? null)
  if (fetched.segments.length === 0) throw new AppError(HLS_ERROR_CODES.HLS_NO_VALID_VARIANT, HLS_ERROR_MESSAGES.HLS_NO_VALID_VARIANT, 400)
  return fetched
}

/**
 * Run the full HLS pipeline. `sourceUrl` is the original user-supplied URL —
 * re-fetched and re-parsed fresh (the probe snapshot may be stale). Live/event
 * imports are recorded: the media playlist is polled and segments accumulate in
 * `segmentCache` until `recordingDurationSeconds` of media time, then remuxed.
 */
export async function runHlsPipeline(opts: HlsPipelineOptions): Promise<HlsPipelineResult> {
  const { jobDir, sourceUrl, selection, isLive, signal, recordingDurationSeconds, resume, requestContext, fetcher } = opts
  await ensureJobDir(jobDir)

  // Resolved during the run; needed to write the resume marker on remux failure.
  let videoPlaylistUrl: string
  let audioPlaylistUrl: string | null = null
  let expectAudio: boolean
  let container: 'mkv' | 'mp4'

  // ── 1–4 (fresh run): fetch + parse source, select variant/audio, poll. ────
  let segmentCache = new Map<string, string>()
  let allVideoSegments: NormalizedSegment[]
  // The original media playlist body (drives the hls-parser round-trip
  // serialization of the rewritten local playlist).
  let videoPlaylistBody: string

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

    const fetchedVideo = await resolveMediaSegments(videoPlaylistUrl, requestContext, fetcher ?? null)
    allVideoSegments = fetchedVideo.segments
    videoPlaylistBody = fetchedVideo.body
    segmentCache = buildSegmentCacheSeed(jobDir, allVideoSegments, 'video')
  } else {
    // ── 1. Fetch + parse the ORIGINAL source manifest. ─────────────────────
    let sourceInfo: HlsManifestInfo
    try {
      const { body, finalUrl } = await fetchManifest(sourceUrl, env.REMOTE_IMPORT_HLS_MAX_MANIFEST_BYTES, requestContext, fetcher ?? null)
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
    const firstVideoFetched = await resolveMediaSegments(videoPlaylistUrl, requestContext, fetcher ?? null)
    const firstVideoSegments = firstVideoFetched.segments
    videoPlaylistBody = firstVideoFetched.body
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
        const snapshot = await resolveMediaSegments(videoPlaylistUrl, requestContext, fetcher ?? null)
        if (snapshot.segments.length > firstVideoSegments.length) {
          allVideoSegments.push(...snapshot.segments.slice(firstVideoSegments.length))
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
      const audioFetched = await resolveMediaSegments(audioPlaylistUrl, requestContext, fetcher ?? null)
      await materializeMedia({
        jobDir,
        mediaLabel: 'audio',
        segments: audioFetched.segments,
        originalBody: audioFetched.body,
        segmentCache,
        signal,
        requestContext,
        sourceUrl,
        fetcher: fetcher ?? null,
      })
    }

    // Audio is expected when the master variant declares an AUDIO group (a
    // separate audio rendition), or when an alternate audio track was explicitly
    // selected. A bare media playlist (no master) is not assumed to carry audio —
    // many video-only HLS streams exist (surveillance, dash cams, silent feeds).
    // The verification step will warn instead of failing if audio is absent.
    expectAudio = Boolean(audioPlaylistUrl) || (sourceInfo.sourceType === 'master' && selectedVariant?.audioGroup != null)

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
    originalBody: videoPlaylistBody,
    segmentCache,
    signal,
    requestContext,
    sourceUrl,
    fetcher: fetcher ?? null,
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
    const audioFetched = await resolveMediaSegments(audioPlaylistUrl, requestContext, fetcher ?? null)
    const audioSegments = audioFetched.segments
    const audioCache = buildSegmentCacheSeed(jobDir, audioSegments, 'audio')
    await materializeMedia({
      jobDir,
      mediaLabel: 'audio',
      segments: audioSegments,
      originalBody: audioFetched.body,
      segmentCache: audioCache,
      signal,
      requestContext,
      sourceUrl,
      fetcher: fetcher ?? null,
    })
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

  // Conversion chain (§3, §9, §16 of the refactor spec, plus the raw-payload
  // fallback from code_example_convert.sh):
  //   1. stream-copy remux (fast path). MKV is the auto default — the safe
  //      container for raw HLS streams (MPEG-TS, fMP4, separate audio).
  //   2. a USER-selected MP4 that cannot stream-copy mux → stable error
  //      HLS_MP4_STREAM_COPY_UNSUPPORTED suggesting MKV (§16) — never a
  //      silent transcode, never a silent container swap.
  //   3. any auto/MKV copy failure → re-encode (H.264 + AAC).
  //   4. re-encode failure → repair-and-retry: if any segment is invalid
  //      (HTML error page, missing sync, wrong packet size), drop those
  //      segments and remux the cleaned playlist. The HLS demuxer handles
  //      per-segment packet sizes, so the [mpegts] changing packet size
  //      log is harmless here — only a corrupt or wrong-content segment
  //      can defeat the playlist path.
  //   5. concat-raw-TS copy: the HLS demuxer refusal is often a
  //      playlist/segment quirk while the raw MPEG-TS payload is fine — the
  //      lenient forced `-f mpegts` demuxer (200M probes) syncs onto it. Only
  //      attempted when every remaining segment is a real MPEG-TS / M2TS
  //      payload with a uniform packet size and PAT/PMT in segment 1.
  // A conversion always succeeds or we fail; the marker is written on a
  // terminal failure so a convert-only retry can reuse the downloaded segments.
  const runRemux = async (forContainer: 'mkv' | 'mp4', playlistPath: string = video.localPlaylistPath): Promise<ffmpeg.FfmpegRunResult> => {
    try {
      await ffmpeg.probeMediaInput(playlistPath, 'playlist').catch(() => undefined)
      return await ffmpeg.runFfmpegRemux(playlistPath, outputPartPath(forContainer), forContainer, jobDir, signal, onFfmpegProgress, mediaSeconds)
    } catch (error) {
      // Auto-selected MKV that fails to copy-mux → re-encode as a last resort.
      // (Auto never resolves to MP4 anymore — `recommendContainer` returns MKV
      // — so the old "auto MP4 → retry as MKV" branch is gone.)
      if (selection.outputContainer === 'mp4') {
        // A USER-selected MP4: a stream-copy incompatibility is a stable,
        // actionable error — do NOT silently re-encode or swap the container.
        throw new AppError(
          HLS_ERROR_CODES.HLS_MP4_STREAM_COPY_UNSUPPORTED,
          HLS_ERROR_MESSAGES.HLS_MP4_STREAM_COPY_UNSUPPORTED,
          400,
        )
      }
      return runReencode(forContainer, error)
    }
  }

  // Re-encode (H.264 + AAC) the local playlist — handles image2/png-pipe and
  // other sources a stream copy cannot mux. On failure, fall through to the
  // raw-payload concat copy below.
  const runReencode = async (forContainer: 'mkv' | 'mp4', originalError: unknown): Promise<ffmpeg.FfmpegRunResult> => {
    try {
      return await ffmpeg.runFfmpegReencode(video.localPlaylistPath, outputPartPath(forContainer), forContainer, jobDir, signal, onFfmpegProgress, mediaSeconds)
    } catch (error) {
      return runRepairAndRetry(forContainer, error)
    }
  }

  // Repair-and-retry (remux fix §4): if any materialized segment is invalid
  // or mismatched, write a new local playlist that references only the valid
  // segments and retry the HLS demuxer remux on it. Only attempted for raw
  // (unkeyed, no-init-map, no-byterange, no-discontinuity) streams — exactly
  // the shape the next step (raw-concat) can consume as a last resort.
  // NOTE: `NormalizedSegment.key` is ALWAYS an object (`normalizeKey` returns
  // a null-valued shape) — check `key.uri`, not the object itself.
  const canConcatRawTs = (): boolean =>
    allVideoSegments.every((s) => !s.map && !s.byterange && !s.key?.uri) && !allVideoSegments.some((s) => s.discontinuity)

  const runRepairAndRetry = async (forContainer: 'mkv' | 'mp4', originalError: unknown): Promise<ffmpeg.FfmpegRunResult> => {
    if (!canConcatRawTs()) return runConcatTsCopy(forContainer, originalError)
    const localPaths = allVideoSegments.map((s) => path.join(jobDir, segmentLocalName('video', s.index)))
    const validations: SegmentValidation[] = []
    for (let i = 0; i < localPaths.length; i += 1) {
      validations.push(await validateSegmentFile(localPaths[i], { index: i + 1 }))
    }
    const selectionResult = selectConcatSegments(validations)
    // Nothing to repair: jump to the raw-concat path.
    if (selectionResult.payload.length === 0 || (selectionResult.payload.length === validations.length && selectionResult.uniform)) {
      return runConcatTsCopy(forContainer, originalError)
    }
    const keepIndexes = new Set(selectionResult.payload.map((v) => v.index))
    const repairedSegments = allVideoSegments.filter((s) => keepIndexes.has(s.index))
    if (repairedSegments.length === 0) return runConcatTsCopy(forContainer, originalError)
    const repairedPlaylist = path.join(jobDir, 'video.repaired.m3u8')
    const localFor = (s: NormalizedSegment) => path.join(jobDir, segmentLocalName('video', s.index))
    const keyLocalFor = () => path.join(jobDir, 'video-key-000001.bin')
    const mapLocalFor = () => path.join(jobDir, 'video-init-000001.mp4')
    const body = buildRewrittenPlaylist(repairedSegments, localFor, keyLocalFor, mapLocalFor)
    await fsp.writeFile(repairedPlaylist, body, 'utf8')
    console.log(`[hls-remux] repair-playlist segments=${repairedSegments.length}/${allVideoSegments.length} dropped=${selectionResult.dropped.length} packetSizes=${selectionResult.packetSizes.join(',')}`)
    try {
      return await ffmpeg.runFfmpegRemux(repairedPlaylist, outputPartPath(forContainer), forContainer, jobDir, signal, onFfmpegProgress, mediaSeconds)
    } catch (error) {
      return runConcatTsCopy(forContainer, error)
    }
  }

  // Raw-payload fallback: concat the local TS segments and force `-f mpegts`
  // (the code_example_convert.sh repair method). Only safe when every segment
  // is a standalone MPEG-TS file — no init maps, byteranges, key URIs or
  // discontinuities (a discontinuity invalidates the raw concat; those streams
  // go through the HLS demuxer which honors the discontinuity markers).
  const runConcatTsCopy = async (forContainer: 'mkv' | 'mp4', originalError: unknown): Promise<ffmpeg.FfmpegRunResult> => {
    if (!canConcatRawTs()) return writeMarkerAndRethrow(originalError)
    const segmentPaths = allVideoSegments.map((s) => path.join(jobDir, segmentLocalName('video', s.index)))
    try {
      return await ffmpeg.runFfmpegConcatTsCopy(segmentPaths, outputPartPath(forContainer), forContainer, jobDir, signal, onFfmpegProgress)
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