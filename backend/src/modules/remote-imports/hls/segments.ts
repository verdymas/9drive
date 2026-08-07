/**
 * HLS segment model + rewritten-local-playlist builder (§6, §8, §10, §11).
 *
 * The worker downloads every remote resource into local files and REWRITES the
 * media playlist so it references only local paths. FFmpeg then reads the local
 * playlist — it never sees a remote URL.
 *
 * Encryption policy:
 *  - Only METHOD=AES-128 is supported, and only while every key URI is HTTP(S),
 *    retrievable through the secure fetcher, size-limited, and stored inside
 *    the job directory.
 *  - SAMPLE-AES / SAMPLE-AES-CTR / DRM KEYFORMATs / FairPlay / Widevine /
 *    PlayReady are REJECTED explicitly up front — never a corrupted output.
 */
import type { Segment as ParserSegment, KeyAttributes } from 'm3u8-parser'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'

export type ByteRange = { length: number; offset: number }

export type SegmentKey = {
  method: string | null
  /** Absolute key URL (server-side only). */
  uri: string | null
  iv: string | null
  /** DRM/unsupported keyformat marker. */
  keyformat: string | null
}

export type SegmentMap = {
  /** Absolute map URL (server-side only). */
  uri: string | null
  byterange: ByteRange | null
}

export type NormalizedSegment = {
  /** Absolute URI resolved against the FINAL manifest URL. */
  uri: string
  duration: number
  byterange: ByteRange | null
  map: SegmentMap | null
  key: SegmentKey | null
  discontinuity: boolean
  title: string | null
  /** Monotonic 1-based index (deterministic local naming). */
  index: number
  /** True when the media is fragmented MP4 (an EXT-X-MAP is present). */
  isFmp4: boolean
}

const DRM_KEYFORMATS = new Set(['com.apple.streamingkeydelivery', 'com.microsoft.playready', 'com.widevine.alpha'])

/**
 * Enforce the encryption policy across all segments. Every key must be:
 *  - METHOD=AES-128 (or no key at all),
 *  - not a DRM KEYFORMAT,
 *  - an HTTP(S) URI (the secure fetcher re-enforces this during download).
 * Anything else (SAMPLE-AES, SAMPLE-AES-CTR, FairPlay key delivery, …) is
 * rejected up front — never a silently-corrupt output.
 */
export function assertSupportedEncryption(segments: NormalizedSegment[]): void {
  for (const segment of segments) {
    const key = segment.key
    if (!key || !key.uri) continue
    if (key.keyformat && DRM_KEYFORMATS.has(key.keyformat)) {
      throw new AppError(HLS_ERROR_CODES.HLS_DRM_NOT_SUPPORTED, HLS_ERROR_MESSAGES.HLS_DRM_NOT_SUPPORTED, 400)
    }
    const method = key.method ?? 'AES-128'
    if (method !== 'AES-128') {
      throw new AppError(HLS_ERROR_CODES.HLS_ENCRYPTION_NOT_SUPPORTED, HLS_ERROR_MESSAGES.HLS_ENCRYPTION_NOT_SUPPORTED, 400)
    }
  }
}

/**
 * Normalize `m3u8-parser` segments into our flat model, resolving every URI
 * against the FINAL manifest URL, and compute implicit consecutive byte-range
 * offsets per the HLS spec.
 */
export function normalizeSegments(manifestSegments: ParserSegment[], manifestUrl: string): NormalizedSegment[] {
  const result: NormalizedSegment[] = []
  // EXT-X-BYTERANGE offsets are relative to the previous segment's end when
  // omitted; the parser already carries resolved offsets, but we keep our own
  // cursor so the identity is fully deterministic.
  let byteRangeCursor = 0
  let mapCursor = 0

  // True when ANY segment carries a map (fragmented MP4 media).
  const isFmp4 = manifestSegments.some((s) => Boolean(s.map?.uri))

  for (let i = 0; i < manifestSegments.length; i += 1) {
    const raw = manifestSegments[i]

    let byterange: ByteRange | null = null
    if (raw.byterange) {
      const offset = raw.byterange.offset ?? byteRangeCursor
      byterange = { length: raw.byterange.length, offset }
      byteRangeCursor = offset + raw.byterange.length
    } else {
      byteRangeCursor = 0
    }

    let map: SegmentMap | null = null
    if (raw.map && typeof raw.map === 'object') {
      const rawMap = raw.map
      let mapRange: ByteRange | null = null
      if (rawMap.byterange) {
        const offset = rawMap.byterange.offset ?? mapCursor
        mapRange = { length: rawMap.byterange.length, offset }
        mapCursor = offset + rawMap.byterange.length
      } else {
        mapCursor = 0
      }
      // The parser emits `map.uri` lowercase (same shape as segment keys).
      const mapUri = (rawMap as { uri?: string }).uri ?? rawMap.uri
      map = {
        uri: mapUri ? new URL(mapUri, manifestUrl).href : null,
        byterange: mapRange,
      }
    } else {
      mapCursor = 0
    }

    result.push({
      uri: new URL(raw.uri, manifestUrl).href,
      duration: Number.isFinite(raw.duration) ? raw.duration : 0,
      byterange,
      map,
      key: normalizeKey(raw.key, manifestUrl),
      discontinuity: Boolean(raw.discontinuity),
      title: raw.title ?? null,
      index: i + 1,
      isFmp4,
    })
  }
  return result
}

/**
 * Normalize an m3u8-parser key object into our SegmentKey. The parser emits
 * LOWERCASE `uri`/`method`/`iv`/`keyformat` (see `dist/m3u8-parser.cjs.js`),
 * while our ambient shim declares uppercase — read both so a real parsed
 * manifest never silently loses its key URI (which would strip the key from
 * the rewritten playlist and hand FFmpeg undecryptable ciphertext).
 */
function normalizeKey(rawKey: KeyAttributes | undefined | null, manifestUrl: string): SegmentKey {
  if (!rawKey) return { method: null, uri: null, iv: null, keyformat: null }
  const rawUri = (rawKey as { uri?: string }).uri ?? rawKey.URI
  const rawMethod = (rawKey as { method?: string }).method ?? rawKey.METHOD
  const rawIv = (rawKey as { iv?: string }).iv ?? rawKey.IV
  const rawKeyformat = (rawKey as { keyformat?: string }).keyformat ?? rawKey.KEYFORMAT
  let uri: string | null = null
  if (rawUri) {
    try {
      uri = new URL(rawUri, manifestUrl).href
    } catch {
      uri = rawUri
    }
  }
  return {
    method: rawMethod ?? null,
    uri,
    iv: rawIv ?? null,
    keyformat: rawKeyformat ?? null,
  }
}

/**
 * Generate the local REWRITTEN playlist body. `localFor` maps a segment to the
 * absolute path of its materialized local file; `keyLocalFor` / `mapLocalFor`
 * map key/map URIs to their local paths. All emitted URIs are bare relative
 * filenames (FFmpeg resolves them against the playlist's directory).
 */
export function buildRewrittenPlaylist(
  segments: NormalizedSegment[],
  localFor: (segment: NormalizedSegment) => string,
  keyLocalFor: (uri: string) => string,
  mapLocalFor: (uri: string) => string,
): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS']

  let targetDuration = Math.max(1, Math.ceil(Math.max(...segments.map((s) => s.duration), 1)))
  lines.push(`#EXT-X-TARGETDURATION:${targetDuration}`)
  lines.push('#EXT-X-MEDIA-SEQUENCE:0')

  let lastKeyUri: string | null = null
  let lastMapUri: string | null = null

  for (const segment of segments) {
    // Emit EXT-X-MAP whenever the segment's map changes (fMP4).
    if (segment.map?.uri && segment.map.uri !== lastMapUri) {
      const local = mapLocalFor(segment.map.uri)
      lines.push(`#EXT-X-MAP:URI="${pathBasename(local)}"`)
      lastMapUri = segment.map.uri
    }
    // Emit EXT-X-KEY whenever the segment's key changes.
    const keyUri = segment.key?.uri ?? null
    if (keyUri && keyUri !== lastKeyUri) {
      const local = keyLocalFor(keyUri)
      const ivAttr = segment.key?.iv ? `,IV="0x${segment.key.iv.replace(/^0x/i, '')}"` : ''
      const method = segment.key?.method ?? 'AES-128'
      lines.push(`#EXT-X-KEY:METHOD="${method}",URI="${pathBasename(local)}"${ivAttr}`)
      lastKeyUri = keyUri
    }
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
    const title = segment.title ?? ''
    lines.push(`#EXTINF:${formatDuration(segment.duration)},${title}`)
    // The payload was materialized into its own safe local file — the rewrite
    // references that file only (no byterange needed; the local file IS the range).
    lines.push(pathBasename(localFor(segment)))
  }

  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

function pathBasename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}

function formatDuration(duration: number): string {
  if (!Number.isFinite(duration) || duration <= 0) return '1'
  return duration.toFixed(3)
}

export type { ParserSegment }
export function countMediaDuration(segments: NormalizedSegment[]): number {
  return segments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0)
}