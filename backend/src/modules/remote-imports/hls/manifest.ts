/**
 * HLS manifest parsing + classification for Remote Import.
 *
 * Use `m3u8-parser` (videojs) — a maintained parser — to turn manifest text
 * into a structured object. We deliberately do NOT parse HLS with line-splitting
 * and ad hoc regexes; the parser is used only as a parser and never performs
 * network access, so every URI it surfaces still goes through 9Drive's
 * SSRF-safe fetcher before a socket is opened.
 *
 * Responsibilities in this module:
 *  - classify a manifest body as a master playlist, a media playlist, or
 *    neither (with `hls-*` evidence for probe source detection),
 *  - enforce the configured manifest-size, playlist-depth, variant-count and
 *    segment-count limits,
 *  - produce normalized, self-contained metadata (variants + audio
 *    renditions) with STABLE opaque ids derived from normalized playlist
 *    metadata — never trusting any client-supplied variant URL,
 *  - resolve relative URIs against the FINAL manifest URL (post-redirect).
 */
import { Parser, type Playlist, type MediaRendition } from 'm3u8-parser'
import crypto from 'node:crypto'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { followRemoteUrl } from '../url-downloader.js'
import { hopHeaderResolver, type RemoteImportRequestContext } from '../request-context.js'
import { normalizeSegments, type NormalizedSegment } from './segments.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'

export type HlsPlaylistKind = 'vod' | 'event' | 'live'

/** A variant inside a master playlist, exposed safely to the frontend. */
export type HlsVariantMetadata = {
  /** Stable opaque selection id — derived from normalized metadata. */
  id: string
  /** Server-side only; never serialized to the client. */
  childPlaylistUrl: string
  bandwidth: number
  averageBandwidth: number | null
  width: number | null
  height: number | null
  frameRate: number | null
  codecs: string[]
  audioGroup: string | null
  /** Safe human label, e.g. "1080p · 5.8 Mbps". */
  label: string
}

/** A single `#EXT-X-MEDIA` audio rendition from a master playlist. */
export type HlsAudioTrackMetadata = {
  id: string
  language: string | null
  name: string | null
  isDefault: boolean
  isAutoSelect: boolean
  /** Server-side render url — never serialized to the client. */
  playlistUrl: string | null
  groupId: string
}

export type HlsManifestInfo = {
  sourceType: 'master' | 'media'
  playlistType: HlsPlaylistKind
  isFinite: boolean
  variants: HlsVariantMetadata[]
  audioTracks: HlsAudioTrackMetadata[]
  /** Durative info for media playlists. */
  durationSeconds: number | null
  /** Total media playlist body (server-side only; not serialized). */
  body: string
  /** The manifest URL the body was fetched from (final, post-redirect). */
  manifestUrl: string
}

/** Content types we treat as HLS-compatible. */
const HLS_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/x-apple-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
])

/** HLS-specific tags that distinguish real HLS from an ordinary M3U playlist. */
const HLS_SPECIFIC_TAGS = [
  '#EXT-X-STREAM-INF',
  '#EXT-X-TARGETDURATION',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-DISCONTINUITY',
  '#EXT-X-KEY',
  '#EXT-X-MAP',
  '#EXT-X-ENDLIST',
  '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-VERSION',
  '#EXT-X-BYTERANGE',
  '#EXT-X-MEDIA',
  '#EXT-X-I-FRAME-STREAM-INF',
  '#EXT-X-INDEPENDENT-SEGMENTS',
]

export function isHlsContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return HLS_CONTENT_TYPES.has(base)
}

export function looksLikeM3u8Url(url: URL): boolean {
  return url.pathname.toLowerCase().endsWith('.m3u8')
}

/**
 * Prefix check — the caller reads a strictly size-limited text prefix.
 * Accepts `#EXTM3U` at the very start, and requires at least one HLS-specific
 * tag so an ordinary M3U audio playlist is never treated as HLS.
 */
export function m3u8PrefixIsHls(prefix: string): boolean {
  const startsWithExtm3u = /^﻿?\s*#EXTM3U\b/.test(prefix)
  if (!startsWithExtm3u) return false
  return HLS_SPECIFIC_TAGS.some((tag) => prefix.includes(tag))
}

/** Plain M3U (no HLS tags): starts with `#EXTM3U` but is not HLS. */
export function plainM3uBody(prefix: string): boolean {
  return /^﻿?\s*#EXTM3U\b/.test(prefix) && !HLS_SPECIFIC_TAGS.some((tag) => prefix.includes(tag))
}

/** Normalize `#EXT-X-PLAYLIST-TYPE` + ENDLIST into a kind. */
export function classifyPlaylistKind(endList: boolean, playlistType?: 'VOD' | 'EVENT'): HlsPlaylistKind {
  if (endList) return 'vod'
  if (playlistType === 'EVENT') return 'event'
  return 'live'
}

/** Stable opaque id from normalized metadata — never the raw URL. */
function stableId(...parts: Array<string | number | null | undefined>): string {
  const normalized = parts.map((p) => (p ?? '').toString().trim().toLowerCase()).join('|')
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16)
}

export function formatMbps(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '0 Mbps'
  const mbps = bitsPerSecond / 1_000_000
  return `${mbps.toFixed(mbps >= 100 ? 0 : mbps >= 10 ? 1 : 2)} Mbps`
}

export function safeVariantLabel(variant: { width: number | null; height: number | null; bandwidth: number; averageBandwidth: number | null }): string {
  const height = variant.height ?? null
  const dim = height ? `${height}p · ` : ''
  return `${dim}${formatMbps(variant.averageBandwidth ?? variant.bandwidth)}`
}

/** Safe codec list from `CODECS` (comma-separated). */
function parseCodecs(codecAttr: string | undefined): string[] {
  if (!codecAttr) return []
  return codecAttr
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 16)
}

/**
 * Request profile for probing and fetching HLS manifests. 9Drive never sends
 * browser cookies, Authorization, Origin or Referer unless the user explicitly
 * supplied a request context (see request-context.ts) — an authenticated
 * source without context is answered with a clear auth error instead of
 * guessing.
 */
export const HLS_MANIFEST_PROFILE_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.apple.mpegurl, application/x-mpegurl, audio/mpegurl, */*',
  'Accept-Encoding': 'identity',
}

/**
 * Context-aware status mapping (spec §23): with a request context attached, a
 * 401/403 means the user's context (or signed URL) has expired — the spec
 * message tells them to capture a fresh media request. Without context the
 * caller's own mapping (auth-required / forbidden) applies.
 */
function contextAwareStatusError(statusCode: number, hasContext: boolean): AppError {
  if (hasContext && (statusCode === 401 || statusCode === 403)) {
    return new AppError(HLS_ERROR_CODES.REMOTE_SOURCE_ACCESS_EXPIRED, HLS_ERROR_MESSAGES.REMOTE_SOURCE_ACCESS_EXPIRED, statusCode)
  }
  switch (statusCode) {
    case 401: return new AppError(HLS_ERROR_CODES.REMOTE_SOURCE_AUTHENTICATION_REQUIRED, HLS_ERROR_MESSAGES.REMOTE_SOURCE_AUTHENTICATION_REQUIRED, 401)
    case 403: return new AppError(HLS_ERROR_CODES.HLS_MANIFEST_FORBIDDEN, HLS_ERROR_MESSAGES.HLS_MANIFEST_FORBIDDEN, 403)
    case 404: return new AppError(HLS_ERROR_CODES.HLS_MANIFEST_NOT_FOUND, HLS_ERROR_MESSAGES.HLS_MANIFEST_NOT_FOUND, 404)
    default: return new AppError(HLS_ERROR_CODES.HLS_MANIFEST_FETCH_FAILED, HLS_ERROR_MESSAGES.HLS_MANIFEST_FETCH_FAILED, 502)
  }
}

/**
 * Typed bounded manifest GET for the PROBE path (secure fetcher; never the
 * redacted URL). Unlike the worker's `fetchManifest`, HTTP failure status codes
 * are translated into stable, distinct AppError codes instead of a single
 * DOWNLOAD_HTTP_ERROR — HEAD-403 vs manifest-GET-403 no longer collapse.
 *
 * Returns the final post-redirect URL (relative children resolve against it,
 * signed query parameters and all).
 */
export async function fetchManifestForProbe(
  url: string,
  opts: { maxBytes?: number; signal?: AbortSignal; requestContext?: RemoteImportRequestContext } = {},
): Promise<{ body: string; finalUrl: string }> {
  const maxBytes = opts.maxBytes ?? env.REMOTE_IMPORT_HLS_MAX_MANIFEST_BYTES
  let collected = 0
  let body = ''
  try {
    const result = await followRemoteUrl(url, {
      headers: HLS_MANIFEST_PROFILE_HEADERS,
      getHopHeaders: hopHeaderResolver(url, opts.requestContext),
      onResponse: async (res, finalURL) => {
        if (res.statusCode >= 400) {
          throw contextAwareStatusError(res.statusCode, Boolean(opts.requestContext))
        }
        if (typeof (res.body as { on?: unknown }).on === 'function') {
          (res.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
        }
        for await (const chunk of res.body) {
          if (opts.signal?.aborted) {
            const err = new AppError('ABORTED', 'The import was cancelled.', 499)
            err.name = 'AbortError'
            throw err
          }
          collected += chunk.byteLength
          if (collected > maxBytes || body.length > maxBytes) {
            throw new AppError(HLS_ERROR_CODES.HLS_MANIFEST_TOO_LARGE, HLS_ERROR_MESSAGES.HLS_MANIFEST_TOO_LARGE, 413)
          }
          body += Buffer.from(chunk).toString('utf8')
        }
        return finalURL
      },
    })
    return { body, finalUrl: result.finalUrl }
  } catch (error) {
    // An idle-timeout mid-stream (or a connect timeout) is a DISTINCT outcome
    // from a plain network failure — map it to HLS_MANIFEST_TIMEOUT.
    if (isManifestTimeoutError(error)) {
      throw new AppError(HLS_ERROR_CODES.HLS_MANIFEST_TIMEOUT, HLS_ERROR_MESSAGES.HLS_MANIFEST_TIMEOUT, 504)
    }
    throw error
  }
}

/** Distinguish the manifest timeout from other network failures. */
function isManifestTimeoutError(error: unknown): boolean {
  if (error instanceof AppError) return false
  const name = error instanceof Error ? error.name : ''
  return (
    name.includes('HeadersTimeout') ||
    name.includes('BodyTimeout') ||
    name.includes('ConnectTimeout') ||
    name.includes('Timeout') ||
    name.includes('SocketError') ||
    name.includes('UND_ERR')
  )
}

/**
 * Fetch + parse a manifest through the SSRF-safe fetcher. `maxBytes` is the
 * configured manifest cap; a larger body throws HLS_MANIFEST_TOO_LARGE and the
 * response is aborted mid-stream — the full manifest never downloads.
 */
export async function fetchManifest(
  url: string,
  maxBytes: number = env.REMOTE_IMPORT_HLS_MAX_MANIFEST_BYTES,
  requestContext?: RemoteImportRequestContext,
): Promise<{ body: string; finalUrl: string }> {
  let collected = 0
  let body = ''
  const result = await followRemoteUrl(url, {
    getHopHeaders: hopHeaderResolver(url, requestContext),
    onResponse: async (res, finalURL) => {
      if (res.statusCode >= 400) {
        // Worker parity with the probe: a context-bearing 401/403 is an
        // expired source/context, not a plain download error (§23).
        if (requestContext && (res.statusCode === 401 || res.statusCode === 403)) {
          throw new AppError(HLS_ERROR_CODES.REMOTE_SOURCE_ACCESS_EXPIRED, HLS_ERROR_MESSAGES.REMOTE_SOURCE_ACCESS_EXPIRED, res.statusCode)
        }
        throw new AppError('DOWNLOAD_HTTP_ERROR', `Remote server responded ${res.statusCode}.`, 502)
      }
      if (typeof (res.body as { on?: unknown }).on === 'function') {
        (res.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
      }
      for await (const chunk of res.body) {
        collected += chunk.byteLength
        if (collected > maxBytes || body.length > maxBytes) {
          throw new AppError(HLS_ERROR_CODES.HLS_MANIFEST_TOO_LARGE, HLS_ERROR_MESSAGES.HLS_MANIFEST_TOO_LARGE, 413)
        }
        body += Buffer.from(chunk).toString('utf8')
      }
      return finalURL
    },
  })
  return { body, finalUrl: result.finalUrl }
}

/**
 * Parse manifest `body` that was fetched from `manifestUrl` and classify it.
 * Throws a stable AppError on structural, variant-count or segment-count
 * violations.
 */
export function parseManifest(
  body: string,
  manifestUrl: string,
  opts: { maxVariants?: number; maxSegments?: number } = {},
): HlsManifestInfo {
  const maxVariants = opts.maxVariants ?? env.REMOTE_IMPORT_HLS_MAX_VARIANTS
  const maxSegments = opts.maxSegments ?? env.REMOTE_IMPORT_HLS_MAX_SEGMENTS

  const parser = new Parser()
  try {
    parser.push(body)
    parser.end()
  } catch {
    throw new AppError(HLS_ERROR_CODES.HLS_INVALID_MANIFEST, HLS_ERROR_MESSAGES.HLS_INVALID_MANIFEST, 400)
  }

  const manifest = parser.manifest
  const segments = Array.isArray(manifest.segments) ? manifest.segments : []
  const playlists = Array.isArray(manifest.playlists) ? manifest.playlists : []

  const hasMasterSignals = playlists.length > 0
  const hasMediaSignals = segments.length > 0

  if (hasMasterSignals) {
    if (playlists.length > maxVariants) {
      throw new AppError(HLS_ERROR_CODES.HLS_TOO_MANY_VARIANTS, HLS_ERROR_MESSAGES.HLS_TOO_MANY_VARIANTS, 400)
    }
    return {
      sourceType: 'master',
      playlistType: 'vod',
      isFinite: true,
      durationSeconds: null,
      variants: playlists.map((playlist) => buildVariant(playlist.uri, playlist.attributes, manifestUrl)),
      audioTracks: buildAudioTracks(manifest.mediaGroups?.AUDIO ?? {}, manifestUrl),
      body,
      manifestUrl,
    }
  }

  if (hasMediaSignals) {
    if (segments.length > maxSegments) {
      throw new AppError(HLS_ERROR_CODES.HLS_TOO_MANY_SEGMENTS, HLS_ERROR_MESSAGES.HLS_TOO_MANY_SEGMENTS, 400)
    }
    // A body with `#EXTINF`-listed files is only HLS when it carries at least
    // one HLS-specific tag (RFC 8216 makes `#EXT-X-TARGETDURATION` REQUIRED).
    // An ordinary MP3 M3U that a bounded probe sampled must never be treated
    // as media HLS even when a hint (e.g. an `audio/x-mpegurl` content-type
    // that claims to be a media playlist) fired.
    if (!HLS_SPECIFIC_TAGS.some((tag) => body.includes(tag))) {
      throw new AppError(HLS_ERROR_CODES.HLS_INVALID_MANIFEST, HLS_ERROR_MESSAGES.HLS_INVALID_MANIFEST, 400)
    }
    const isFinite = Boolean(manifest.endList)
    const kind = classifyPlaylistKind(isFinite, manifest.playlistType)
    const duration = segments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0)
    return {
      sourceType: 'media',
      playlistType: kind,
      isFinite,
      durationSeconds: Number.isFinite(duration) ? duration : null,
      variants: [],
      audioTracks: [],
      body,
      manifestUrl,
    }
  }

  throw new AppError(HLS_ERROR_CODES.HLS_INVALID_MANIFEST, HLS_ERROR_MESSAGES.HLS_INVALID_MANIFEST, 400)
}

/**
 * Parse a media playlist body into its classified info + the normalized
 * segment model (URIs resolved against `manifestUrl`). Throws a stable code
 * when the body is not a media playlist (e.g. a master was supplied).
 */
export function parseMediaPlaylist(body: string, manifestUrl: string): { info: HlsManifestInfo; segments: NormalizedSegment[] } {
  const info = parseManifest(body, manifestUrl)
  if (info.sourceType !== 'media') {
    throw new AppError(HLS_ERROR_CODES.HLS_SOURCE_CHANGED, HLS_ERROR_MESSAGES.HLS_SOURCE_CHANGED, 400)
  }
  // Re-run the tokenizer to extract the raw media segments (parseManifest
  // classifies but does not expose the parser's segment model publicly).
  const parser = new Parser()
  parser.push(body)
  parser.end()
  const rawSegments = Array.isArray(parser.manifest.segments) ? parser.manifest.segments : []
  return { info, segments: normalizeSegments(rawSegments, manifestUrl) }
}

function buildVariant(uri: string, attributes: Playlist['attributes'], manifestUrl: string): HlsVariantMetadata {
  const childPlaylistUrl = new URL(uri, manifestUrl).href
  const width = attributes?.RESOLUTION?.width ?? null
  const height = attributes?.RESOLUTION?.height ?? null
  const bandwidth = attributes?.BANDWIDTH ?? 0
  const averageBandwidth = attributes?.['AVERAGE-BANDWIDTH'] ?? null
  const id = stableId(uri, bandwidth, averageBandwidth, width, height, attributes?.CODECS, attributes?.AUDIO)
  return {
    id,
    childPlaylistUrl,
    bandwidth,
    averageBandwidth,
    width,
    height,
    frameRate: attributes?.['FRAME-RATE'] ?? null,
    codecs: parseCodecs(attributes?.CODECS),
    audioGroup: attributes?.AUDIO ?? null,
    label: safeVariantLabel({ width, height, bandwidth, averageBandwidth }),
  }
}

function buildAudioTracks(groups: Record<string, Record<string, MediaRendition>>, manifestUrl: string): HlsAudioTrackMetadata[] {
  const tracks: HlsAudioTrackMetadata[] = []
  for (const [groupId, renditions] of Object.entries(groups)) {
    for (const [name, rendition] of Object.entries(renditions)) {
      const playlistUrl = rendition.uri ? new URL(rendition.uri, manifestUrl).href : null
      tracks.push({
        id: stableId(groupId, name, rendition.language),
        language: rendition.language ?? null,
        name: rendition.name ?? name,
        isDefault: Boolean(rendition.default),
        isAutoSelect: Boolean(rendition.autoselect),
        playlistUrl,
        groupId,
      })
    }
  }
  return tracks
}