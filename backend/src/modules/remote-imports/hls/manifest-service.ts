/**
 * hls-parser round-trip manifest service (§4, §5, §24 of the refactor spec).
 *
 * Replaces the handcrafted string-concatenation playlist builder
 * (`buildRewrittenPlaylist` in segments.ts) with the maintained `hls-parser`
 * library:
 *
 *   parse(original) → rewrite parsed objects to local URIs → stringify()
 *
 * The original media playlist text is parsed with `hls-parser`, the parsed
 * segments/maps/keys are rewritten to generated local filenames, and
 * `stringify()` serializes a valid local-only playlist. All HLS semantics are
 * preserved by the library: version, target duration, media sequence,
 * playlist type, endlist, discontinuities, EXT-X-MAP, EXT-X-BYTERANGE
 * (materialized → removed), EXT-X-KEY + IV, program-date-time.
 *
 * Security: hls-parser is used strictly as a parser/serializer — it never
 * performs network access. Every URI still goes through 9Drive's SSRF-safe
 * fetcher before any socket opens, and the rewritten playlist references only
 * generated local filenames inside the job directory.
 */
import { parse as hlsParse, stringify as hlsStringify, types } from 'hls-parser'
import path from 'node:path'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'
import type { NormalizedSegment } from './segments.js'

function localName(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}

/**
 * Rewrite a parsed hls-parser media playlist so every referenced resource
 * points at a generated local filename, then serialize with `stringify()`.
 *
 * @param originalBody the ORIGINAL media playlist text (unmodified)
 * @param segments     the normalized segment model (absolute URIs + indexes)
 * @param localFor     maps a segment to its materialized local path
 * @param keyLocalFor  maps a key absolute URI to its local key path
 * @param mapLocalFor  maps a map absolute URI to its local init-map path
 * @returns the rewritten local playlist body
 */
export function rewriteMediaPlaylist(
  originalBody: string,
  segments: NormalizedSegment[],
  localFor: (segment: NormalizedSegment) => string,
  keyLocalFor: (uri: string) => string,
  mapLocalFor: (uri: string) => string,
): string {
  let playlist: types.MediaPlaylist
  try {
    const parsed = hlsParse(originalBody) as types.MediaPlaylist | types.MasterPlaylist
    if (!parsed || parsed.isMasterPlaylist === true || parsed.isMasterPlaylist === undefined) {
      throw new Error('not a media playlist')
    }
    playlist = parsed
  } catch {
    throw new AppError(HLS_ERROR_CODES.HLS_INVALID_MANIFEST, HLS_ERROR_MESSAGES.HLS_INVALID_MANIFEST, 400)
  }

  const parsedSegments = Array.isArray(playlist.segments) ? playlist.segments : []
  // The parse could disagree with our normalized model (e.g. the body changed
  // between parse passes) — guard by count.
  if (parsedSegments.length !== segments.length) {
    throw new AppError(HLS_ERROR_CODES.HLS_SOURCE_CHANGED, HLS_ERROR_MESSAGES.HLS_SOURCE_CHANGED, 400)
  }

  // Absolute key/map URIs (normalized model) → local filenames.
  const keyLocalByName = new Map<string, string>()
  const mapLocalByName = new Map<string, string>()
  for (const segment of segments) {
    if (segment.key?.uri) keyLocalByName.set(segment.key.uri, localName(keyLocalFor(segment.key.uri)))
    if (segment.map?.uri) mapLocalByName.set(segment.map.uri, localName(mapLocalFor(segment.map.uri)))
  }

  for (let i = 0; i < parsedSegments.length; i += 1) {
    const parsedSegment = parsedSegments[i]
    const normalized = segments[i]
    if (!parsedSegment || !normalized) continue

    // URI → generated local filename (the segment was materialized into its
    // own local file — no byterange needed; the local file IS the range).
    parsedSegment.uri = localName(localFor(normalized))
    if (parsedSegment.byterange) {
      // The local file IS the full materialized range — clear + omit the
      // EXT-X-BYTERANGE tag (stringify emits it whenever the field is present).
      ;(parsedSegment as { byterange?: unknown }).byterange = undefined
    }

    // EXT-X-MAP → local init-map filename.
    if (parsedSegment.map && normalized.map?.uri) {
      const localMap = mapLocalByName.get(normalized.map.uri)
      if (localMap) parsedSegment.map.uri = localMap
      if (parsedSegment.map.byterange) {
        ;(parsedSegment.map as { byterange?: unknown }).byterange = undefined
      }
    }

    // EXT-X-KEY → local key file (absolute URI in normalized model).
    if (parsedSegment.key && normalized.key?.uri) {
      const localKey = keyLocalByName.get(normalized.key.uri)
      if (localKey) parsedSegment.key.uri = localKey
    }
  }

  return hlsStringify(playlist)
}

/**
 * Re-parse the GENERATED local playlist and verify it is a valid, local-only
 * media playlist (§18). Every referenced resource must be a bare local
 * filename inside the job directory; no remote URI (http/https/file) may
 * remain. Returns the segment count + the URIs of any files that must be
 * checked on disk (the caller does the async existence check).
 */
export function validateLocalPlaylist(body: string, jobDir: string): { segmentCount: number; localFiles: string[] } {
  let playlist: types.MediaPlaylist
  try {
    const parsed = hlsParse(body) as types.MediaPlaylist | types.MasterPlaylist
    if (!parsed || parsed.isMasterPlaylist === true || parsed.isMasterPlaylist === undefined) {
      throw new Error('not a media playlist')
    }
    playlist = parsed
  } catch {
    throw new AppError(HLS_ERROR_CODES.HLS_LOCAL_PLAYLIST_INVALID, HLS_ERROR_MESSAGES.HLS_LOCAL_PLAYLIST_INVALID, 500)
  }

  const segments = Array.isArray(playlist.segments) ? playlist.segments : []
  if (segments.length === 0) {
    throw new AppError(HLS_ERROR_CODES.HLS_LOCAL_PLAYLIST_INVALID, HLS_ERROR_MESSAGES.HLS_LOCAL_PLAYLIST_INVALID, 500)
  }

  const root = path.resolve(jobDir)
  const localFiles: string[] = []

  const check = (uri: string | undefined): void => {
    if (!uri) return
    if (/^[a-z]+:\/\//i.test(uri) || uri.startsWith('file:')) {
      throw new AppError(HLS_ERROR_CODES.HLS_LOCAL_PLAYLIST_INVALID, HLS_ERROR_MESSAGES.HLS_LOCAL_PLAYLIST_INVALID, 500)
    }
    const resolved = path.resolve(jobDir, uri)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new AppError(HLS_ERROR_CODES.HLS_LOCAL_PLAYLIST_INVALID, HLS_ERROR_MESSAGES.HLS_LOCAL_PLAYLIST_INVALID, 500)
    }
    localFiles.push(uri)
  }

  for (const segment of segments) {
    check(segment.uri)
    check(segment.map?.uri)
    check(segment.key?.uri)
  }

  return { segmentCount: segments.length, localFiles }
}
