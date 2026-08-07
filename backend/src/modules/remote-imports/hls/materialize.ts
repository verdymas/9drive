/**
 * HLS materialization driver (§8, §9, §10 of the spec).
 *
 * Given one media playlist (video OR alternate audio) fetched through the
 * SSRF-safe fetcher, this module:
 *
 *  1. validates encryption + counts,
 *  2. downloads every unique map/key/segment through the secure fetcher, with
 *     byte caps and bounded concurrency,
 *  3. writes a REWRITTEN local playlist (video.m3u8 / audio.m3u8) that
 *     references ONLY local files,
 *  4. returns local paths for FFmpeg.
 *
 * A `segmentCache` Map may be passed so LIVE playlists can re-materialize a
 * growing window without re-downloading segments already on disk. All remote
 * resources are keyed by absolute URI, never by a path derived from it.
 */
import fsp from 'node:fs/promises'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'
import { fetchManifest, parseMediaPlaylist } from './manifest.js'
import {
  downloadResource,
  downloadByteRange,
  pathInJobDir,
  segmentLocalName,
  mapLocalName,
  keyLocalName,
  manifestLocalName,
} from './materializer.js'
import { assertSupportedEncryption, buildRewrittenPlaylist, type NormalizedSegment, type SegmentMap } from './segments.js'

export type MediaLabel = 'video' | 'audio'

export type MaterializeMediaOptions = {
  jobDir: string
  /** Local-file label ('video' | 'audio'); sets the generated filename prefix. */
  mediaLabel: MediaLabel
  segments: NormalizedSegment[]
  /** Persistent cache {absoluteUri → localPath} for live windows. */
  segmentCache?: Map<string, string>
  signal?: AbortSignal
  onProgress?: (progress: { segmentsCompleted: number; segmentsTotal: number; bytesDownloaded: bigint }) => void
}

export type MaterializeMediaResult = {
  /** Absolute rewritten media playlist path FFmpeg reads. */
  localPlaylistPath: string
  downloadedBytes: bigint
  segmentCount: number
  mediaDurationSeconds: number
}

const MAX_SEGMENT_BYTES = () => BigInt(env.REMOTE_IMPORT_HLS_MAX_SEGMENT_BYTES)
const MAX_KEY_BYTES = () => BigInt(env.REMOTE_IMPORT_HLS_MAX_KEY_BYTES)

/** Simple promise-based rate limiter: at most `limit` concurrent downloads. */
export function semaphore(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < limit) {
        active += 1
        resolve()
        return
      }
      queue.push(resolve)
    })
  const release = () => {
    active -= 1
    const next = queue.shift()
    if (next) {
      active += 1
      next()
    }
  }
  return { acquire, release }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    const err = new AppError('ABORTED', 'The import was cancelled.', 499)
    err.name = 'AbortError'
    throw err
  }
}

/**
 * Materialize one media playlist (video or alternate audio). `segments` is the
 * CURRENT set to materialize; when a `segmentCache` is supplied, already-cached
 * URIs are reused and only new ones are downloaded.
 */
export async function materializeMedia(opts: MaterializeMediaOptions): Promise<MaterializeMediaResult> {
  const { jobDir, segments, mediaLabel, signal } = opts
  const cache = opts.segmentCache ?? new Map<string, string>()

  assertSupportedEncryption(segments)

  // ── Phase A: maps + keys, deduplicated by URI, downloaded sequentially. ──
  const mapPaths = new Map<string, string>()
  const keyPaths = new Map<string, string>()
  let mapCounter = 0
  let keyCounter = 0
  let downloadedBytes = 0n

  for (const segment of segments) {
    if (segment.map?.uri && !mapPaths.has(segment.map.uri)) {
      mapCounter += 1
      mapPaths.set(segment.map.uri, pathInJobDir(jobDir, mapLocalName(mediaLabel, mapCounter)))
    }
    if (segment.key?.uri && !keyPaths.has(segment.key.uri)) {
      keyCounter += 1
      keyPaths.set(segment.key.uri, pathInJobDir(jobDir, keyLocalName(mediaLabel, keyCounter)))
    }
  }

  for (const [uri, targetPath] of mapPaths) {
    assertNotAborted(signal)
    const map = segments.find((s) => s.map?.uri === uri)?.map as SegmentMap | undefined
    if (map?.byterange) {
      downloadedBytes += await downloadByteRange(uri, map.byterange.offset, map.byterange.length, targetPath, { signal })
    } else {
      downloadedBytes += await downloadResource(uri, targetPath, { maxBytes: MAX_SEGMENT_BYTES(), signal, kind: 'map' })
    }
  }

  for (const [uri, targetPath] of keyPaths) {
    assertNotAborted(signal)
    try {
      downloadedBytes += await downloadResource(uri, targetPath, { maxBytes: MAX_KEY_BYTES(), signal, kind: 'key' })
    } catch (error) {
      if (error instanceof AppError && error.code === HLS_ERROR_CODES.HLS_SEGMENT_TOO_LARGE) {
        throw new AppError(HLS_ERROR_CODES.HLS_KEY_DOWNLOAD_FAILED, HLS_ERROR_MESSAGES.HLS_KEY_DOWNLOAD_FAILED, 502)
      }
      throw error
    }
  }

  // ── Phase B: segments — bounded concurrency, retries, cache-aware. ───────
  const sem = semaphore(env.REMOTE_IMPORT_HLS_SEGMENT_CONCURRENCY)
  let segmentsCompleted = 0
  let totalDownloadedForSegments = 0n
  const segmentPaths = new Map<string, string>()

  const downloadOne = async (segment: NormalizedSegment): Promise<void> => {
    await sem.acquire()
    try {
      assertNotAborted(signal)

      const cachedPath = cache.get(segment.uri)
      if (cachedPath) {
        // Already on disk from an earlier live poll — reference it locally.
        segmentPaths.set(segment.uri, cachedPath)
        segmentsCompleted += 1
        return
      }

      const target = pathInJobDir(jobDir, segmentLocalName(mediaLabel, segment.index))
      segmentPaths.set(segment.uri, target)

      const attemptDownload = () => {
        if (segment.byterange) {
          return downloadByteRange(segment.uri, segment.byterange.offset, segment.byterange.length, target, { signal })
        }
        return downloadResource(segment.uri, target, { maxBytes: MAX_SEGMENT_BYTES(), signal, kind: 'segment' })
      }

      let lastError: unknown = null
      const attempts = Math.max(1, env.REMOTE_IMPORT_HLS_SEGMENT_ATTEMPTS)
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        assertNotAborted(signal)
        try {
          const bytes = await attemptDownload()
          if (bytes === 0n) {
            throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_DOWNLOAD_FAILED, HLS_ERROR_MESSAGES.HLS_SEGMENT_DOWNLOAD_FAILED, 502)
          }
          cache.set(segment.uri, target)
          totalDownloadedForSegments += bytes
          segmentsCompleted += 1
          opts.onProgress?.({
            segmentsCompleted,
            segmentsTotal: Math.max(segments.length, segmentsCompleted),
            bytesDownloaded: downloadedBytes + totalDownloadedForSegments,
          })
          return
        } catch (error) {
          lastError = error
          if (error instanceof Error && error.name === 'AbortError') throw error
          if (attempt < attempts) await sleep(500 * attempt)
        }
      }
      throw lastError
    } finally {
      sem.release()
    }
  }

  await Promise.all(segments.map((segment) => downloadOne(segment).catch((error) => Promise.reject(error))))

  // ── Phase C: write the REWRITTEN local playlist. ──────────────────────────
  const localPlaylistPath = pathInJobDir(jobDir, manifestLocalName(mediaLabel))
  const body = buildRewrittenPlaylist(
    segments,
    (s) => segmentPaths.get(s.uri) ?? pathInJobDir(jobDir, segmentLocalName(mediaLabel, s.index)),
    (uri) => keyPaths.get(uri) ?? pathInJobDir(jobDir, keyLocalName(mediaLabel, 1)),
    (uri) => mapPaths.get(uri) ?? pathInJobDir(jobDir, mapLocalName(mediaLabel, 1)),
  )
  await fsp.writeFile(localPlaylistPath, body, 'utf8')

  const mediaDurationSeconds = segments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0)
  return {
    localPlaylistPath,
    downloadedBytes: downloadedBytes + totalDownloadedForSegments,
    segmentCount: segments.length,
    mediaDurationSeconds,
  }
}

/**
 * Seed a segment cache from on-disk files for a convert-only retry.
 *
 * Maps each segment URI to the deterministic local filename that
 * `materializeMedia` would have chosen for it (`video-000001.ts`, …), so a
 * resume run re-parses the media playlist and reuses the already-downloaded
 * segments instead of re-fetching them. Keys (`.bin`) and init maps (`.mp4`)
 * are deliberately NOT seeded — they re-download (small, bounded).
 */
export function buildSegmentCacheSeed(jobDir: string, segments: NormalizedSegment[], mediaLabel: MediaLabel): Map<string, string> {
  const cache = new Map<string, string>()
  for (const segment of segments) {
    cache.set(segment.uri, pathInJobDir(jobDir, segmentLocalName(mediaLabel, segment.index)))
  }
  return cache
}

/** Re-fetch a LIVE media playlist (the worker polls it). */
export async function fetchMediaPlaylistSegments(playlistUrl: string): Promise<NormalizedSegment[]> {
  const { body, finalUrl } = await fetchManifest(playlistUrl)
  return (await parseMediaPlaylist(body, finalUrl)).segments
}