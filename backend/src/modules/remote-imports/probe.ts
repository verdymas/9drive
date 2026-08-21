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
  fetchManifestForProbe,
  HLS_MANIFEST_PROFILE_HEADERS,
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
import { hopHeaderResolver, type RemoteImportRequestContext } from './request-context.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './hls/errors.js'
import { createSecureFetcherForWorkerId, type SecureRemoteFetcher } from './secure-fetcher.js'

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
  /**
   * Internal ONLY: the final post-redirect URL including any signed query
   * parameters. Never serialized to the frontend; the only URL the HLS
   * manifest fetch is allowed to use (a redacted display URL must never be
   * fetched).
   */
  sourceUrlForFetch: string
}

/** Strip the internal-only fetch URL before the result crosses the API. */
export function probeResultForWire(result: ProbeResult): Omit<ProbeResult, 'sourceUrlForFetch'> {
  const { sourceUrlForFetch: _omit, ...rest } = result
  return rest
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
 * Probable-HLS detection for the probe: a source is treated as HLS when the
 * final content-type is an HLS MIME type, the final URL (or the original URL)
 * looks like `.m3u8`, or the sampled body prefix opens like an HLS manifest.
 */
function hlsHint(base: Pick<ProbeResult, 'mimeType' | 'finalUrl' | 'originalUrl'>, sampledPrefix: string | null): boolean {
  return (
    isHlsContentType(base.mimeType) ||
    looksLikeM3u8Url(new URL(base.finalUrl)) ||
    looksLikeM3u8Url(new URL(base.originalUrl)) ||
    (sampledPrefix ? m3u8PrefixIsHls(sampledPrefix) : false)
  )
}

/**
 * Request profile for probing HLS-looking sources (manifest GET) and for the
 * direct-file probe (HEAD / ranged GET). 9Drive never sends browser cookies,
 * Authorization, Origin or Referer unless the user explicitly supplied a
 * request context — a source that requires them is answered with a clear
 * unsupported/authentication error instead of guessing.
 */
const PROBE_MANIFEST_HEADERS: Record<string, string> = {
  ...HLS_MANIFEST_PROFILE_HEADERS,
  'User-Agent': '9Drive-Remote-Import/1.0',
}

/** Route identity for probe logs: `route=direct` | `route=worker workerId driver relayHost`. */
function probeRouteParts(fetcher: SecureRemoteFetcher): string {
  const r = fetcher.routeInfo()
  if (r.route !== 'worker') return 'route=direct'
  return `route=worker workerId=${r.workerId ?? ''} driver=${r.driver ?? ''} relayHost=${r.relayHost ?? ''}`
}

/**
 * Probe a remote URL without downloading the file. Returns the detected
 * filename (always sanitized), its source, response metadata, and an HLS
 * classification. `requestContext` (user-supplied referer/origin/user-agent/
 * cookie) is applied to every probe request through the centralized policy.
 * Throws `AppError` for validation / SSRF / network failures.
 *
 * Transport is resolved generically: workerId null → Direct, else via registry.
 * The selected transport is used for HEAD, ranged GET and HLS manifest — never
 * raw `followRemoteUrl` when a fetcher is available.
 */
export async function probeRemoteUrl(
  rawUrl: string,
  correlationId: string,
  requestContext?: RemoteImportRequestContext,
  opts: { workerId?: string | null; fetcher?: SecureRemoteFetcher } = {},
): Promise<ProbeResult> {
  const log = (message: string, extra: Record<string, string | number | boolean> = {}) => {
    console.log(
      `[remote-import:probe] ${correlationId} ${message} ${Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`.trim(),
    )
  }
  // Route identity for logs: route=direct | route=worker workerId driver relayHost
  const routeParts = probeRouteParts

  const workerSelected = Boolean(opts.workerId)

  // Resolve the worker transport FIRST: validation errors for the selected
  // worker (missing / disabled / unsupported / unusable) surface before any
  // URL or DNS work and with no source request having happened (§28). The
  // factory reuses the SAME generic registry the download path uses — probe
  // and download can never diverge on the selected route.
  let fetcher: SecureRemoteFetcher | null = opts.fetcher ?? null
  if (!fetcher && workerSelected) {
    fetcher = await createSecureFetcherForWorkerId(opts.workerId!, { requestContext, sourceUrl: rawUrl })
  }

  // URL validation: syntax/policy checks always; backend DNS ONLY in Direct
  // mode. In relay mode the backend must not resolve hostnames it never
  // connects to — a strict-firewall host may be unresolvable from the backend
  // even though the relay can reach it. The relay edge (Cloudflare Workers
  // fetch) enforces host → IP-space safety for the relayed request.
  const originalUrl = await validateRemoteUrl(rawUrl, { resolveDns: !workerSelected })
  const originalUrlHref = originalUrl.href

  // Direct mode (or when a custom fetcher was not supplied): resolve the
  // always-available direct transport.
  if (!fetcher) {
    fetcher = await createSecureFetcherForWorkerId(null, { requestContext, sourceUrl: originalUrlHref })
  }

  // ── Phase 1: HEAD (cheap; most servers answer it). ──────────────────────
  // Only a 2xx response counts as a successful metadata probe; 403/405/501
  // fall back to GET instead of failing the entire Remote Import.
  let headStatus = 0
  let headRedirects = 0
  let headResult: ProbeResult | null = null
  try {
    log(`${routeParts(fetcher)} method=HEAD targetHost=${hostOf(originalUrlHref)}`)
    const headRes = await fetcher.fetch({ method: 'HEAD', url: originalUrlHref, requestContext: requestContext as any } as any)
    headStatus = headRes.status
    headRedirects = (headRes as any).redirectCount ?? 0
    const finalUrl = (headRes as any).finalUrl ?? originalUrlHref
    log(`response ${routeParts(fetcher)} status=${headStatus}`)
    // HEAD has no body; headers are already lowercased
    headResult = buildProbeResult(originalUrlHref, finalUrl, { statusCode: headStatus, headers: headRes.headers }, null)
  } catch (headError) {
    // Fallback: if fetcher fails due to not implemented or network, try direct followRemoteUrl for compatibility with tests that mock ssrf
    // But we already have a fetcher that should handle direct, so this catch is for error logging
    log('head_failed', { code: headError instanceof AppError ? headError.code : 'network' })
    headResult = null
  }

  if (headResult && headStatus >= 200 && headStatus < 300) {
    log('head_success', { status: headStatus, redirects: headRedirects, host: hostOf(headResult.finalUrl) })
    const headHasCdFilename =
      headResult.fileNameSource === 'content-disposition-filename' ||
      headResult.fileNameSource === 'content-disposition-filename-star'
    // A successful HEAD with a server-supplied filename and no HLS hint is a
    // complete probe — no body fetch is needed.
    if (headHasCdFilename && !hlsHint(headResult, null)) {
      return finalizeProbe(headResult, null, log, requestContext, fetcher)
    }
  } else {
    log('head_rejected', { status: headStatus, redirects: headRedirects, host: headResult ? hostOf(headResult.finalUrl) : '' })
  }

  // ── Phase 2: probable HLS? → one bounded manifest GET; else ranged GET. ──
  if (headResult && hlsHint(headResult, null)) {
    return finalizeProbe(headResult, null, log, requestContext, fetcher)
  }
  return getProbe(originalUrlHref, log, requestContext, fetcher)
}

/** Hostname of a (redacted) URL — the only URL data ever logged. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

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
 * Phase 2 of the probe (non-HLS hinted HEAD, or no usable HEAD): a ranged GET
 * samples a small prefix (≤ 8 KiB) so the body can reveal HLS even when the
 * URL/content-type carry no hint. Servers that ignore the Range and stream a
 * 200 are aborted after the first chunk — the full file is never downloaded.
 */
async function getProbe(
  originalUrlHref: string,
  log: (message: string, extra?: Record<string, string | number | boolean>) => void,
  requestContext?: RemoteImportRequestContext,
  fetcher?: SecureRemoteFetcher | null,
): Promise<ProbeResult> {
  let sampledPrefix = ''
  try {
    let rangedResult: ProbeResult
    let redirectCount = 0
    let finalUrlForResult = originalUrlHref
    if (fetcher) {
      log(`${probeRouteParts(fetcher)} method=GET range=bytes=0-0 targetHost=${hostOf(originalUrlHref)}`)
      const res = await fetcher.fetch({ method: 'GET', url: originalUrlHref, range: 'bytes=0-0', headers: { Range: 'bytes=0-0' }, requestContext: requestContext as any } as any)
      log(`response ${probeRouteParts(fetcher)} status=${res.status}`)
      const finalUrl = (res as any).finalUrl ?? originalUrlHref
      redirectCount = (res as any).redirectCount ?? 0
      finalUrlForResult = finalUrl
      // Sample first chunk
      const body = res.body as AsyncIterable<Uint8Array> | string
      if (typeof body === 'string') {
        sampledPrefix = body.slice(0, 8192)
      } else {
        const reader = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        const first = await reader.next().catch(() => undefined)
        if (first && !first.done && first.value) {
          sampledPrefix = Buffer.from(first.value).toString('utf8').slice(0, 8192)
        }
        await (reader as any).return?.().catch(() => undefined)
      }
      rangedResult = buildProbeResult(originalUrlHref, finalUrl, { statusCode: res.status, headers: res.headers }, sampledPrefix)
    } else {
      const ranged = await followRemoteUrl(originalUrlHref, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        getHopHeaders: hopHeaderResolver(originalUrlHref, requestContext),
        onResponse: async (res, finalUrl) => {
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
          return buildProbeResult(originalUrlHref, finalUrl, res, sampledPrefix)
        },
      })
      rangedResult = ranged.result
      redirectCount = ranged.redirectCount
      finalUrlForResult = ranged.finalUrl
    }
    log('ranged GET ok', { redirects: redirectCount })
    return await finalizeProbe(rangedResult, sampledPrefix, log, requestContext, fetcher)
  } catch (getError) {
    log('ranged GET rejected', { code: getError instanceof AppError ? getError.code : 'network' })
    if (getError instanceof AppError) throw getError
    throw new AppError('PROBE_FAILED', 'The remote URL could not be inspected.', 502)
  }
}

/** Build the base probe fields (filename, mime, length, range support). */
function buildProbeResult(
  startUrl: string,
  finalUrl: string,
  res: { statusCode: number; headers: Record<string, string> },
  sampledPrefix: string | null,
): ProbeResult {
  const original = new URL(startUrl)
  const final = new URL(finalUrl)
  const cd = res.headers['content-disposition'] ?? null
  const detected = detectFileName({
    contentDisposition: cd,
    originalUrl: original,
    finalUrl: final,
    fallbackShortId: shortId(),
    // Supplies a safe extension only when the remote gave no name at all
    // (extensionless URL path, generated fallback) — never overwrites a name.
    mimeType: res.headers['content-type'] ?? null,
  })

  const rawLength = res.headers['content-length']
  const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null
  const supportsRange = res.headers['accept-ranges'] === 'bytes' || res.statusCode === 206
  const sample = sampledPrefix && sampledPrefix.length > 0 ? sampledPrefix : null

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
    // The ONLY URL the HLS manifest fetch may use: the final post-redirect
    // URL with the full signed query string intact (never redacted).
    sourceUrlForFetch: final.href,
  }
}

/**
 * Add the HLS classification to a probe result. When ANY hint (MIME type,
 * `.m3u8`-looking URL, or sampled body prefix) suggests HLS, exactly ONE
 * bounded manifest GET runs (on the FINAL post-redirect URL — signed query
 * params intact — never on a redacted URL) and its body is parsed. A manifest
 * fetch failure or an invalid body is a STRUCTURED ERROR, never a silent
 * downgrade to `direct_file`: `hls: null` on success now means "really a
 * direct file", not "the manifest failed to load".
 */
async function finalizeProbe(
  base: ProbeResult,
  sampledPrefix: string | null,
  log: (message: string, extra?: Record<string, string | number | boolean>) => void,
  requestContext?: RemoteImportRequestContext,
  fetcher?: SecureRemoteFetcher | null,
): Promise<ProbeResult> {
  const hint = hlsHint(base, sampledPrefix)
  if (!hint) return base

  // One bounded manifest fetch: bare `.m3u8` links, signed URLs and
  // extension-less HLS endpoints alike reach a full parse here — but never a
  // full binary body. Errors propagate as typed AppError (HLS_MANIFEST_*),
  // so the probe route returns the normal structured error envelope.
  let fetch: { body: string; finalUrl: string }
  try {
    if (fetcher) {
      log(`${probeRouteParts(fetcher)} method=GET role=manifest targetHost=${hostOf(base.sourceUrlForFetch)}`)
      const res = await fetcher.boundedGet(base.sourceUrlForFetch, { requestContext, maxBytes: 1024 * 1024, sourceUrl: base.sourceUrlForFetch })
      log(`response ${probeRouteParts(fetcher)} status=${res.status} role=manifest`)
      if (res.status >= 400) {
        // Map status to typed error (mirrors fetchManifestForProbe logic)
        const hasCtx = Boolean(requestContext)
        if (hasCtx && (res.status === 401 || res.status === 403)) {
          throw new AppError(HLS_ERROR_CODES.REMOTE_SOURCE_ACCESS_EXPIRED, HLS_ERROR_MESSAGES.REMOTE_SOURCE_ACCESS_EXPIRED, res.status)
        }
        if (res.status === 401) throw new AppError(HLS_ERROR_CODES.REMOTE_SOURCE_AUTHENTICATION_REQUIRED, HLS_ERROR_MESSAGES.REMOTE_SOURCE_AUTHENTICATION_REQUIRED, 401)
        if (res.status === 403) throw new AppError(HLS_ERROR_CODES.HLS_MANIFEST_FORBIDDEN, HLS_ERROR_MESSAGES.HLS_MANIFEST_FORBIDDEN, 403)
        if (res.status === 404) throw new AppError(HLS_ERROR_CODES.HLS_MANIFEST_NOT_FOUND, HLS_ERROR_MESSAGES.HLS_MANIFEST_NOT_FOUND, 404)
        throw new AppError(HLS_ERROR_CODES.HLS_MANIFEST_FETCH_FAILED, HLS_ERROR_MESSAGES.HLS_MANIFEST_FETCH_FAILED, 502)
      }
      fetch = { body: res.body, finalUrl: res.finalUrl }
    } else {
      fetch = await fetchManifestForProbe(base.sourceUrlForFetch, { requestContext })
    }
  } catch (manifestError) {
    if (isManifestTimeoutError(manifestError)) {
      log('manifest GET rejected', { code: HLS_ERROR_CODES.HLS_MANIFEST_TIMEOUT, host: hostOf(base.finalUrl) })
      throw new AppError(HLS_ERROR_CODES.HLS_MANIFEST_TIMEOUT, HLS_ERROR_MESSAGES.HLS_MANIFEST_TIMEOUT, 504)
    }
    if (manifestError instanceof AppError) {
      log('manifest GET rejected', { code: manifestError.code, host: hostOf(base.finalUrl) })
      throw manifestError
    }
    // Only a non-SSRF/non-HTTP error (e.g. idle timeout) survives here.
    log('manifest GET rejected', { code: 'network', host: hostOf(base.finalUrl) })
    throw new AppError(HLS_ERROR_CODES.HLS_MANIFEST_FETCH_FAILED, HLS_ERROR_MESSAGES.HLS_MANIFEST_FETCH_FAILED, 502)
  }

  // Strict content validation BEFORE parse — a server that answers `.m3u8`
  // with HTML or a JSON error must not be reported as a direct file.
  if (!m3u8PrefixIsHls(fetch.body.slice(0, 4096))) {
    log('manifest body rejected', { code: HLS_ERROR_CODES.HLS_INVALID_MANIFEST, host: hostOf(base.finalUrl) })
    throw new AppError(HLS_ERROR_CODES.HLS_INVALID_MANIFEST, HLS_ERROR_MESSAGES.HLS_INVALID_MANIFEST, 400)
  }

  let hls: HlsManifestInfo
  try {
    hls = parseManifest(fetch.body, fetch.finalUrl)
  } catch (parseError) {
    const code = parseError instanceof AppError ? parseError.code : HLS_ERROR_CODES.HLS_INVALID_MANIFEST
    log('HLS parse rejected', { code, host: hostOf(base.finalUrl) })
    if (parseError instanceof AppError) throw parseError
    throw new AppError(HLS_ERROR_CODES.HLS_INVALID_MANIFEST, HLS_ERROR_MESSAGES.HLS_INVALID_MANIFEST, 400)
  }

  log('HLS parsed', { type: hls.sourceType, playlistType: hls.playlistType, variants: hls.variants.length, host: hostOf(base.finalUrl) })
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
}