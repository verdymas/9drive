/**
 * Backend-owned URL probe for Remote Import.
 *
 * `probeRemoteUrl` performs the minimal network interaction needed to answer
 * "what is this URL, what filename should it have, and is it HLS?":
 *
 *   1. validate the URL (scheme, credentials, SSRF DNS gate),
 *   2. HEAD (via `followRemoteUrl`) with per-hop SSRF re-validation and the
 *      same redirect / timeout / size caps as the real downloader,
 *   3. if HEAD is rejected (405/network) or its headers lack a filename, one
 *      ranged GET (`Range: bytes=0-0`) — a server that ignores the range and
 *      answers 200 is aborted after the first chunk, so the FULL FILE IS NEVER
 *      DOWNLOADED,
 *   4. inspect the FINAL response's headers only (an intermediate redirect's
 *      Content-Disposition is not used),
 *   5. HLS detection (source classification): a source is classified as HLS
 *      (master or media) when the final content-type is an HLS MIME type, the
 *      final URL looks like `.m3u8`, or the response body opens like an HLS
 *      manifest (`#EXTM3U` + an HLS-specific tag). When any hint fires, the
 *      probe performs ONE bounded body fetch (≤ the HLS manifest cap) and
 *      parses it — even for URLs with NO `.m3u8` extension. Non-HLS sources
 *      never pay for a full body (only the first chunk is sampled).
 *   6. return the detected filename + source + metadata, with sensitive query
 *      parameters redacted from every returned URL.
 *
 * The probe goes through the exact same SSRF-safe downloader the worker uses,
 * so blocked addresses, DNS rebinding, redirect limits and idle timeouts all
 * behave identically.
 *
 * Logging is deliberately minimal and secret-safe: a correlation id, method,
 * status, redirect count and filename source are recorded — never full URLs,
 * query strings, Authorization, cookies, Content-Disposition values or tokens.
 */
import { AppError } from '../../utils/app-error.js'
import { detectFileName, type FileNameSource } from './filename-detection.js'
import {
  fetchManifest,
  isHlsContentType,
  looksLikeM3u8Url,
  m3u8PrefixIsHls,
  parseManifest,
  type HlsAudioTrackMetadata,
  type HlsManifestInfo,
  type HlsPlaylistKind,
  type HlsVariantMetadata,
} from './hls/manifest.js'
import { validateRemoteUrl } from './ssrf.js'
import { followRemoteUrl } from './url-downloader.js'

export type HlsProbeSummary = {
  sourceType: 'hls_master' | 'hls_media'
  playlistType: HlsPlaylistKind
  isFinite: boolean
  variants: Omit<HlsVariantMetadata, 'childPlaylistUrl'>[]
  audioTracks: HlsAudioTrackMetadata[]
  durationSeconds: number | null
  detectedInBody: boolean
}

export type ProbeResult = {
  originalUrl: string
  finalUrl: string
  fileName: string
  fileNameSource: FileNameSource
  mimeType: string | null
  contentLength: number | null
  supportsRange: boolean
  /** Source classification: HLS master / HLS media / ordinary direct file. */
  sourceType: 'direct_file' | 'hls_master' | 'hls_media'
  /** HLS details (null for direct files) — child URLs never serialized. */
  hls: HlsProbeSummary | null
}

const QUERY_REDACTED = '<redacted>'
const SEARCH_PARAM_KEYS = new Set([
  'token', 'signature', 'sig', 'expires', 'x-amz-signature', 'x-amz-credential',
  'x-amz-security-token', 'GoogleAccessId', 'AccessKeyId', 'Policy', 'Key-Pair-Id',
])

/** Redact known sensitive query parameters from a URL for display/storage. */
export function redactUrl(raw: string): string {
  const url = new URL(raw)
  for (const key of [...url.searchParams.keys()]) {
    if (SEARCH_PARAM_KEYS.has(key)) url.searchParams.set(key, QUERY_REDACTED)
  }
  return url.toString()
}

/** Redact the fragment too (may carry signed tokens). */
export function redactUrlFull(raw: string): string {
  const url = new URL(raw)
  url.hash = ''
  return redactUrl(url.toString())
}

/** Short unique id for the generated-fallback filename (`remote-file-{id}`). */
function shortId(): string {
  // Only [a-z0-9] so it survives every sanitizer.
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Probe a remote URL without downloading the file. Returns the detected
 * filename (always sanitized), its source, response metadata, and an HLS
 * classification. Throws `AppError` for validation / SSRF / network failures.
 */
export async function probeRemoteUrl(rawUrl: string, correlationId: string): Promise<ProbeResult> {
  const originalUrl = await validateRemoteUrl(rawUrl)
  const originalUrlHref = originalUrl.href
  const log = (message: string, extra: Record<string, string | number | boolean> = {}) => {
    console.log(
      `[remote-import:probe] ${correlationId} ${message} ${Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`.trim(),
    )
  }

  // ── Phase 1: HEAD (cheap; most servers answer it). ──────────────────────
  let headStatus = 0
  let headResult: ProbeResult | null = null
  try {
    const head = await followRemoteUrl(originalUrlHref, {
      method: 'HEAD',
      onResponse: async (res, finalUrl) => {
        headStatus = res.statusCode
        const base = buildBaseResult(originalUrlHref, finalUrl, res)
        return base
      },
    })
    log('HEAD ok', { status: headStatus, redirects: head.redirectCount })
    headResult = head.result
    const headRejected = headStatus < 200 || headStatus >= 300
    const headHasCdFilename =
      head.result.fileNameSource === 'content-disposition-filename' ||
      head.result.fileNameSource === 'content-disposition-filename-star'
    if (headRejected || !headHasCdFilename) {
      // Fall back to a ranged GET (may yield a body that reveals HLS).
      return await rangedGetProbe(originalUrlHref, log, headResult ?? null)
    }
    return await finalizeProbe(originalUrlHref, headResult, null, log)
  } catch (headError) {
    log('HEAD rejected', { code: headError instanceof AppError ? headError.code : 'network' })
    return await rangedGetProbe(originalUrlHref, log, null)
  }
}

/**
 * Ranged GET fallback. In addition to filename detection, a small prefix of the
 * body is sampled (up to 8 KiB) so HLS detection can see whether the source
 * body opens like an M3U playlist — even when the URL has no `.m3u8` extension.
 */
async function rangedGetProbe(
  originalUrlHref: string,
  log: (message: string, extra?: Record<string, string | number | boolean>) => void,
  headResult: ProbeResult | null,
): Promise<ProbeResult> {
  let sampledPrefix = ''
  try {
    const ranged = await followRemoteUrl(originalUrlHref, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      onResponse: async (res, finalUrl) => {
        // Servers that ignore the Range and stream a 200 with the whole body
        // are aborted once we have a small prefix — we only need headers.
        const bodyError = res.body as { on?: unknown }
        if (typeof bodyError.on === 'function') {
          (bodyError as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
        }
        const reader = res.body[Symbol.asyncIterator]()
        const first = await reader.next().catch(() => undefined)
        if (first && !first.done && first.value) {
          sampledPrefix = Buffer.from(first.value).toString('utf8').slice(0, 8192)
        }
        await reader.return?.().catch(() => undefined)
        return buildBaseResult(originalUrlHref, finalUrl, res)
      },
    })
    log('ranged GET ok', { redirects: ranged.redirectCount })
    return await finalizeProbe(originalUrlHref, ranged.result, sampledPrefix, log)
  } catch (getError) {
    log('ranged GET rejected', { code: getError instanceof AppError ? getError.code : 'network' })
    // If we have no body sampling but a HEAD result exists, use it as-is.
    if (headResult) return finalizeProbe(originalUrlHref, headResult, null, log)
    if (getError instanceof AppError) throw getError
    throw new AppError('PROBE_FAILED', 'The remote URL could not be inspected.', 502)
  }
}

/** Build the base probe fields (filename, mime, length, range support). */
function buildBaseResult(
  startUrl: string,
  finalUrl: string,
  res: { statusCode: number; headers: Record<string, string> },
): ProbeResult {
  const original = new URL(startUrl)
  const final = new URL(finalUrl)
  const cd = res.headers['content-disposition'] ?? null
  const detected = detectFileName({
    contentDisposition: cd,
    originalUrl: original,
    finalUrl: final,
    fallbackShortId: shortId(),
  })

  const rawLength = res.headers['content-length']
  const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null
  const supportsRange = res.headers['accept-ranges'] === 'bytes' || res.statusCode === 206

  return {
    originalUrl: redactUrl(original.href),
    finalUrl: redactUrl(final.href),
    fileName: detected.fileName,
    fileNameSource: detected.fileNameSource,
    mimeType: res.headers['content-type'] ?? null,
    contentLength,
    supportsRange,
    sourceType: 'direct_file',
    hls: null,
  }
}

/**
 * Add the HLS classification to a base probe result. When any hint (MIME type,
 * `.m3u8`-look URL, or body prefix) suggests HLS, a single bounded body fetch
 * is performed and the manifest parsed. A failure to detect = direct file.
 */
async function finalizeProbe(
  originalUrlHref: string,
  base: ProbeResult,
  sampledPrefix: string | null,
  log: (message: string, extra?: Record<string, string | number | boolean>) => void,
): Promise<ProbeResult> {
  const hint =
    isHlsContentType(base.mimeType) ||
    looksLikeM3u8Url(new URL(base.finalUrl)) ||
    looksLikeM3u8Url(new URL(base.originalUrl)) ||
    (sampledPrefix ? m3u8PrefixIsHls(sampledPrefix) : false)

  if (!hint) return base

  // One bounded manifest fetch: bare `.m3u8` links, signed URLs and extension-less
  // HLS endpoints alike reach a full parse here — but never a full binary body.
  try {
    const { body, finalUrl } = await fetchManifest(originalUrlHref)
    let hls: HlsManifestInfo
    try {
      hls = parseManifest(body, finalUrl)
    } catch (parseError) {
      log('HLS parse rejected', { code: parseError instanceof AppError ? parseError.code : 'unknown' })
      return base
    }
    log('HLS detected', { sourceType: hls.sourceType, playlistType: hls.playlistType })
    return {
      ...base,
      sourceType: hls.sourceType === 'master' ? 'hls_master' : 'hls_media',
      hls: {
        sourceType: hls.sourceType === 'master' ? 'hls_master' : 'hls_media',
        playlistType: hls.playlistType,
        isFinite: hls.isFinite,
        variants: hls.variants.map(({ childPlaylistUrl: _c, ...rest }) => rest),
        audioTracks: hls.audioTracks,
        durationSeconds: hls.durationSeconds,
        detectedInBody: Boolean(sampledPrefix && m3u8PrefixIsHls(sampledPrefix)),
      },
    }
  } catch (error) {
    log('HLS fetch rejected', { code: error instanceof AppError ? error.code : 'network' })
    return base
  }
}