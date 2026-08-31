/**
 * Secure local HLS materialization (§6 of the spec).
 *
 * The worker NEVER lets FFmpeg fetch the remote playlist or segments. Instead:
 *
 *   Remote M3U8
 *       ↓  SSRF-safe application fetcher (followRemoteUrl)
 *   Parse + validate the manifest
 *       ↓
 *   Securely download playlists, segments, maps, and permitted AES-128 keys
 *       ↓
 *   Store under SAFE generated local filenames in {jobDir}/
 *       ↓
 *   Create a REWRITTEN local media playlist (references local files only)
 *       ↓
 *   FFmpeg reads ONLY the local playlist (-protocol_whitelist file,crypto)
 *
 * Safety invariants:
 *  - No untrusted segment path is ever used as a filesystem path.
 *  - Paths are validated within the job directory before read/write/rename.
 *  - Byte-range resources (EXT-X-BYTERANGE) issue validated Range requests,
 *    verify 206 / Content-Range, and materialize exact ranges.
 *  - AES-128 keys are fetched through the secure fetcher, strictly limited,
 *    and stored only inside the job directory.
 *  - SAMPLE-AES / DRM KEYFORMATs are rejected up front.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { followRemoteUrl } from '../url-downloader.js'
import { hopHeaderResolver, type RemoteImportRequestContext } from '../request-context.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'

export type MaterializeOptions = {
  jobDir: string
  signal?: AbortSignal
  maxTotalBytes: bigint
  onProgress?: (progress: { segmentsCompleted: number; segmentsTotal: number; bytesDownloaded: bigint }) => void
}

export type MaterializeResult = {
  /** Absolute path of the rewritten local playlist FFmpeg reads. */
  localPlaylistPath: string
  /** Bytes downloaded across all local files. */
  downloadedBytes: bigint
  /** Number of materialized segments. */
  segmentCount: number
}

/** Fixed-width zero-padded placeholders — never derived from remote URIs. */
function pad(index: number, width = 6): string {
  return String(index).padStart(width, '0')
}

/** Local segment filename under a media label (video-000001.ts / audio-000001.ts). */
export function segmentLocalName(mediaLabel: string, index: number): string {
  return `${mediaLabel}-${pad(index)}.ts`
}

export function mapLocalName(mediaLabel: string, counter: number): string {
  return `${mediaLabel}-init-${pad(counter)}.mp4`
}

export function keyLocalName(mediaLabel: string, counter: number): string {
  return `${mediaLabel}-key-${pad(counter)}.bin`
}

export function manifestLocalName(mediaLabel: string): string {
  return `${mediaLabel}.m3u8`
}

/** Kind-aware stable error for a truncated (size-mismatched) download. */
function truncatedDownloadError(kind?: string): AppError {
  if (kind === 'map') return new AppError(HLS_ERROR_CODES.HLS_MAP_DOWNLOAD_FAILED, HLS_ERROR_MESSAGES.HLS_MAP_DOWNLOAD_FAILED, 502)
  if (kind === 'key') return new AppError(HLS_ERROR_CODES.HLS_KEY_DOWNLOAD_FAILED, HLS_ERROR_MESSAGES.HLS_KEY_DOWNLOAD_FAILED, 502)
  return new AppError(HLS_ERROR_CODES.HLS_SEGMENT_DOWNLOAD_FAILED, HLS_ERROR_MESSAGES.HLS_SEGMENT_DOWNLOAD_FAILED, 502)
}

export function masterManifestLocalName(): string {
  return 'master.m3u8'
}

/**
 * Resolve a local path strictly inside `jobDir`. Guards `..` / absolute
 * traversal so no remote value can escape the job directory.
 */
export function pathInJobDir(jobDir: string, ...parts: string[]): string {
  const joined = path.join(jobDir, ...parts)
  const resolved = path.resolve(joined)
  const root = path.resolve(jobDir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'Invalid local job path.', 500)
  }
  return resolved
}

/** Compatibility alias — validates `candidate` is inside `root`. */
export function assertInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'Invalid local path.', 500)
  }
  return resolved
}

export async function ensureJobDir(jobDir: string): Promise<void> {
  await fsp.mkdir(jobDir, { recursive: true, mode: 0o700 })
}

/**
 * Streaming-download a remote resource into a local file with:
 *  - SSRF validation on the final hop AND every redirect hop,
 *  - a configured byte cap (segment/manifest/key-specific limits),
 *  - abort support.
 * Returns the bytes written. Partial output is removed by the caller's cleanup.
 */
export async function downloadResource(
  url: string,
  targetLocalPath: string,
  opts: {
    maxBytes?: bigint
    signal?: AbortSignal
    kind?: 'segment' | 'map' | 'key' | 'playlist' | 'audio'
    requestContext?: RemoteImportRequestContext
    fetcher?: import('../secure-fetcher.js').SecureRemoteFetcher | null
  },
): Promise<bigint> {
  const maxBytes = opts.maxBytes ?? BigInt(env.REMOTE_IMPORT_MAX_BYTES)
  if (opts.fetcher) {
    // Use generic fetcher (Direct or relay) — never raw followRemoteUrl when a fetcher is available
    return opts.fetcher.downloadToFile(url, targetLocalPath, { maxBytes, signal: opts.signal, requestContext: opts.requestContext, sourceUrl: url, kind: opts.kind })
  }
  let written = 0n
  await followRemoteUrl(url, {
    getHopHeaders: hopHeaderResolver(url, opts.requestContext),
    onResponse: async (res) => {
      // With a request context attached, a 401/403 means the user's context or
      // signed URL has expired (§23). Without context, an authenticated source
      // is classified as unsupported — 9Drive never forwards credentials it
      // was not explicitly given, so the only honest answer is a stable error,
      // not a retry storm.
      if (res.statusCode === 401 || res.statusCode === 403) {
        if (opts.requestContext) {
          throw new AppError(HLS_ERROR_CODES.REMOTE_SOURCE_ACCESS_EXPIRED, HLS_ERROR_MESSAGES.REMOTE_SOURCE_ACCESS_EXPIRED, res.statusCode)
        }
        throw new AppError(HLS_ERROR_CODES.HLS_AUTHENTICATED_SOURCE_UNSUPPORTED, HLS_ERROR_MESSAGES.HLS_AUTHENTICATED_SOURCE_UNSUPPORTED, 400)
      }
      if (res.statusCode >= 400) throw new AppError('DOWNLOAD_HTTP_ERROR', `Remote server responded ${res.statusCode}.`, 502)
      if (typeof (res.body as { on?: unknown }).on === 'function') {
        (res.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
      }
      const handle = await fsp.open(targetLocalPath, 'w')
      // Truncation guard: when the server advertises a Content-Length AND is
      // not compressing the body, the bytes we read MUST match — a short
      // download is a corrupt segment by definition.
      const declared = (() => {
        const cl = res.headers['content-length']
        const enc = (res.headers['content-encoding'] ?? '').toLowerCase()
        if (!cl || enc === 'gzip' || enc === 'br' || enc === 'deflate') return null
        const n = Number(cl)
        return Number.isFinite(n) && n >= 0 ? BigInt(n) : null
      })()
      try {
        for await (const chunk of res.body) {
          if (opts.signal?.aborted) throw new Error('ABORTED')
          written += BigInt(chunk.byteLength)
          if (written > maxBytes) {
            throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_TOO_LARGE, HLS_ERROR_MESSAGES.HLS_SEGMENT_TOO_LARGE, 413)
          }
          await handle.write(chunk)
        }
        if (declared !== null && written !== declared) {
          throw truncatedDownloadError(opts.kind)
        }
      } finally {
        await handle.close()
      }
    },
  })
  return written
}

/**
 * Download a byte-range of a remote resource. Issues a validated Range
 * request, verifies `206 Partial Content` + a matching `Content-Range`, and
 * materializes exactly `[offset, offset+length)`.
 */
export async function downloadByteRange(
  url: string,
  offset: number,
  length: number,
  targetLocalPath: string,
  opts: { signal?: AbortSignal; requestContext?: RemoteImportRequestContext; fetcher?: import('../secure-fetcher.js').SecureRemoteFetcher | null },
): Promise<bigint> {
  const rangeHeader = `bytes=${offset}-${offset + length - 1}`
  if (opts.fetcher) {
    const res = await opts.fetcher.fetch({ method: 'GET', url, headers: { Range: rangeHeader }, range: rangeHeader, requestContext: opts.requestContext as any } as any)
    if (res.status !== 206) {
      throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_RANGE_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_RANGE_INVALID, 502)
    }
    const cr = res.headers['content-range']
    if (!cr || !new RegExp(`^bytes ${offset}-${offset + length - 1}/`).test(cr)) {
      throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_RANGE_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_RANGE_INVALID, 502)
    }
    let written = 0n
    const fsp = await import('node:fs/promises')
    const handle = await fsp.open(targetLocalPath, 'w')
    try {
      const iterable = typeof res.body === 'string' ? (async function* () { yield Buffer.from(res.body as string) })() : (res.body as AsyncIterable<Uint8Array>)
      for await (const chunk of iterable) {
        if (opts.signal?.aborted) throw new Error('ABORTED')
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        written += BigInt(buf.byteLength)
        if (written > BigInt(length)) throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_RANGE_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_RANGE_INVALID, 502)
        await handle.write(buf)
      }
    } finally {
      await handle.close()
    }
    if (written !== BigInt(length)) {
      throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_RANGE_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_RANGE_INVALID, 502)
    }
    return written
  }
  let written = 0n
  let saw206 = false
  await followRemoteUrl(url, {
    headers: { Range: rangeHeader },
    getHopHeaders: hopHeaderResolver(url, opts.requestContext),
    onResponse: async (res) => {
      if (res.statusCode === 206) {
        const cr = res.headers['content-range']
        if (!cr || !new RegExp(`^bytes ${offset}-${offset + length - 1}/`).test(cr)) {
          // Server returned a different range than requested — materialize
          // nothing rather than silently corrupting the payload.
          throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_RANGE_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_RANGE_INVALID, 502)
        }
        saw206 = true
      }
      if (typeof (res.body as { on?: unknown }).on === 'function') {
        (res.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
      }
      const handle = await fsp.open(targetLocalPath, 'w')
      try {
        for await (const chunk of res.body) {
          if (opts.signal?.aborted) throw new Error('ABORTED')
          written += BigInt(chunk.byteLength)
          if (written > BigInt(length)) throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_RANGE_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_RANGE_INVALID, 502)
          await handle.write(chunk)
        }
      } finally {
        await handle.close()
      }
    },
  })
  if (!saw206) {
    // The source ignored Range (answered 200) — the range did not materialize.
    throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_RANGE_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_RANGE_INVALID, 502)
  }
  if (written !== BigInt(length)) {
    throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_RANGE_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_RANGE_INVALID, 502)
  }
  return written
}