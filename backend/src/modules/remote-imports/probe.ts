/**
 * Backend-owned URL probe for Remote Import.
 *
 * `probeRemoteUrl` performs the minimal network interaction needed to answer
 * "what is this URL, and what filename should it have?":
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
 *   5. return the detected filename + source + metadata, with sensitive query
 *      parameters redacted from every returned URL.
 *
 * The probe goes through the exact same SSRF-safe downloader the worker uses
 * (no second network implementation), so blocked addresses, DNS rebinding,
 * redirect limits and idle timeouts all behave identically.
 *
 * Logging is deliberately minimal and secret-safe: a correlation id, method,
 * status, redirect count and filename source are recorded — never full URLs,
 * query strings, Authorization, cookies, Content-Disposition values or tokens.
 */
import { AppError } from '../../utils/app-error.js'
import { validateRemoteUrl } from './ssrf.js'
import { followRemoteUrl } from './url-downloader.js'
import { detectFileName, type FileNameSource } from './filename-detection.js'

export type ProbeResult = {
  originalUrl: string
  finalUrl: string
  fileName: string
  fileNameSource: FileNameSource
  mimeType: string | null
  contentLength: number | null
  supportsRange: boolean
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
  // Only [a-z0-9] so it survives every sanitizer; collision risk is
  // negligible for a per-probe fallback (10^10 combinations).
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Probe a remote URL without downloading the file. Returns the detected
 * filename (always sanitized), its source, and response metadata. Throws
 * `AppError` for validation / SSRF / network failures (callers map to HTTP).
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
  try {
    const head = await followRemoteUrl(originalUrlHref, {
      method: 'HEAD',
      onResponse: async (res, finalUrl) => {
        headStatus = res.statusCode
        return buildProbeResult(originalUrlHref, finalUrl, res)
      },
    })
    log('HEAD ok', { status: headStatus, redirects: head.redirectCount, source: head.result.fileNameSource })
    // Per §3: a HEAD that was REJECTED (non-2xx, e.g. 405) or whose headers
    // yielded no Content-Disposition filename is insufficient — many servers
    // only set Content-Disposition on GET. One ranged GET (aborted after the
    // first chunk) is then attempted; we never download the whole file.
    const headRejected = headStatus < 200 || headStatus >= 300
    const headHasCdFilename =
      head.result.fileNameSource === 'content-disposition-filename' ||
      head.result.fileNameSource === 'content-disposition-filename-star'
    if (headRejected || !headHasCdFilename) {
      return await rangedGetFallback(originalUrlHref, log)
    }
    return head.result
  } catch (headError) {
    log('HEAD rejected', { code: headError instanceof AppError ? headError.code : 'network' })
    // ── Phase 2: ranged GET fallback. ──────────────────────────────────────
    return await rangedGetFallback(originalUrlHref, log)
  }
}

async function rangedGetFallback(
  originalUrlHref: string,
  log: (message: string, extra?: Record<string, string | number | boolean>) => void,
): Promise<ProbeResult> {
  try {
    const ranged = await followRemoteUrl(originalUrlHref, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      onResponse: async (res, finalUrl) => {
        // Servers that ignore the Range and stream a 200 with the whole
        // body are aborted after the first chunk — we only need headers.
        const bodyError = res.body as { on?: unknown }
        if (typeof bodyError.on === 'function') {
          (bodyError as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
        }
        const reader = res.body[Symbol.asyncIterator]()
        await reader.next().catch(() => undefined)
        await reader.return?.().catch(() => undefined)
        return buildProbeResult(originalUrlHref, finalUrl, res)
      },
    })
    log('ranged GET ok', { redirects: ranged.redirectCount, source: ranged.result.fileNameSource })
    return ranged.result
  } catch (getError) {
    log('ranged GET rejected', { code: getError instanceof AppError ? getError.code : 'network' })
    if (getError instanceof AppError) throw getError
    throw new AppError('PROBE_FAILED', 'The remote URL could not be inspected.', 502)
  }
}

function buildProbeResult(
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
    extension: null, // the generated fallback is deterministic; no extension
  })

  const rawLength = res.headers['content-length']
  const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null
  const supportsRange = res.headers['accept-ranges'] === 'bytes' || res.statusCode === 206

  return {
    originalUrl: redactUrl(original.href),
    finalUrl: redactUrl(final.href),
    // detectFileName already sanitizes every candidate (header, path segment,
    // generated fallback) before classifying it — the fallback's generated
    // name would otherwise be double-prefixed.
    fileName: detected.fileName,
    fileNameSource: detected.fileNameSource,
    mimeType: res.headers['content-type'] ?? null,
    contentLength,
    supportsRange,
  }
}
