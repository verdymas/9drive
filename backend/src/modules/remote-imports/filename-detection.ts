/**
 * Backend-owned filename detection for Remote Import.
 *
 * The frontend never talks to the remote URL (CORS would hide headers anyway,
 * and browser requests would bypass the SSRF gate). Every network interaction
 * happens server-side; the probe endpoint returns a detected filename plus the
 * source it came from, and the frontend only renders what we say.
 *
 * Detection order (exact):
 *   1. Content-Disposition `filename*` (RFC 5987/8187, UTF-8)
 *   2. Content-Disposition `filename` (quoted or token)
 *   3. last usable pathname segment of the FINAL redirected URL
 *   4. last usable pathname segment of the ORIGINAL URL
 *   5. generated fallback `remote-file-{shortId}` — the extension is appended
 *      only when it cannot duplicate what is already there.
 *
 * The URL-path steps only accept segments that look like a real filename
 * (they must not be empty, `.`, `..`, a directory-looking trailing segment,
 * or something that sanitizes away entirely) — a path like
 * `/download?id=1` contributes nothing, and traversal components like
 * `../movie.mkv` are rejected before sanitization.
 *
 * Everything the remote can influence (headers, URL segments) goes through
 * `sanitizeFileName` — the sanitizer is always applied, even when the probe
 * already sanitized, and the worker's temp paths are keyed by import id, never
 * by this name.
 */
import { parseContentDispositionFileName } from './content-disposition-parser.js'
import { appendExtension, extensionFromMime, isOpaqueFileName, normalizeExtensionFromMime, sanitizeFileName } from './filename-sanitize.js'

export type FileNameSource =
  | 'content-disposition-filename-star'
  | 'content-disposition-filename'
  | 'final-url-path'
  | 'original-url-path'
  | 'generated-fallback'

export type DetectedFileName = {
  fileName: string
  fileNameSource: FileNameSource
}

/** `false` for empty / dot / dotdot / directory-looking or sanitize-to-empty candidates. */
function isUsablePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  // A trailing slash means the last segment is a directory, not a file.
  if (segment.endsWith('/')) return false
  const sanitized = sanitizeFileName(segment)
  return sanitized.length > 0 && sanitized !== 'file'
}

/** Last pathname segment that is usable as a filename (percent-decoded). */
function lastUsablePathSegment(url: URL): string | null {
  const parts = url.pathname.split('/')
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const raw = parts[i]
    if (!isUsablePathSegment(raw)) continue
    try {
      const decoded = decodeURIComponent(raw)
      if (decoded && isUsablePathSegment(decoded)) return decoded
    } catch {
      // Malformed percent-encoding — try the raw segment.
      if (isUsablePathSegment(raw)) return raw
    }
  }
  return null
}

/** Generate a stable fallback name; `extension` is only appended when safe. */
function generatedFallback(shortId: string, extension: string | null | undefined): string {
  const base = sanitizeFileName(`remote-file-${shortId}`)
  return appendExtension(base, extension)
}

/**
 * Detect a filename from the final response's Content-Disposition header and
 * the URLs seen during the probe. The final response's header always wins —
 * an intermediate redirect's `Content-Disposition` is irrelevant, since the
 * header we read comes from the last hop in the chain.
 */
export function detectFileName(opts: {
  contentDisposition: string | null
  originalUrl: URL
  finalUrl: URL
  fallbackShortId: string
  /** Optional extension to append to the generated fallback (safe only). */
  extension?: string | null
  /** Response Content-Type: supplies a safe extension when the remote gave
   *  the file no name at all (extensionless URL path / generated fallback). */
  mimeType?: string | null
}): DetectedFileName {
  if (opts.contentDisposition) {
    const fromHeader = parseContentDispositionFileName(opts.contentDisposition)
    if (fromHeader) {
      const sanitized = sanitizeFileName(fromHeader)
      if (sanitized && sanitized !== 'file') {
        // A CD name WITHOUT an extension (bare `filename="movie"`) gets one
        // from the KNOWN response Content-Type; an explicit extension is never
        // overwritten.
        const fileName = normalizeExtensionFromMime(sanitized, opts.mimeType)
        const isStar = /filename\*=/i.test(opts.contentDisposition)
        return {
          fileName,
          fileNameSource: isStar ? 'content-disposition-filename-star' : 'content-disposition-filename',
        }
      }
    }
  }

  const finalSegment = lastUsablePathSegment(opts.finalUrl)
  if (finalSegment) {
    // A URL path contributes no extension when the server sends none — give it
    // one from a KNOWN response Content-Type (never guessed, never overwritten).
    const fileName = normalizeExtensionFromMime(sanitizeFileName(finalSegment), opts.mimeType)
    return { fileName, fileNameSource: 'final-url-path' }
  }

  const originalSegment = lastUsablePathSegment(opts.originalUrl)
  if (originalSegment) {
    const fileName = normalizeExtensionFromMime(sanitizeFileName(originalSegment), opts.mimeType)
    return { fileName, fileNameSource: 'original-url-path' }
  }

  const fallback = generatedFallback(opts.fallbackShortId, extensionFromMime(opts.mimeType) ?? opts.extension)
  return { fileName: sanitizeFileName(fallback), fileNameSource: 'generated-fallback' }
}

/**
 * Resolve the suggested name carried by a Browser Capture row. The capture
 * filename is a suggestion, not a user override: semantic capture metadata
 * and a probed Content-Disposition name can replace an opaque URL/object id.
 */
export function resolveCapturedFileName(opts: {
  suggestedFileName?: string | null
  mediaIdentityTitle?: string | null
  pageTitle?: string | null
  probed?: (DetectedFileName & { mimeType?: string | null }) | null
  mimeType?: string | null
  resourceType?: string | null
}): string {
  const effectiveMimeType = opts.mimeType ?? opts.probed?.mimeType ?? null
  const normalize = (value: string) => normalizeExtensionFromMime(sanitizeFileName(value), effectiveMimeType)
  const mediaIdentityTitle = typeof opts.mediaIdentityTitle === 'string' ? opts.mediaIdentityTitle.trim() : ''
  const pageTitle = typeof opts.pageTitle === 'string' ? opts.pageTitle.trim() : ''
  const semantic = mediaIdentityTitle && !isOpaqueFileName(mediaIdentityTitle, opts) ? mediaIdentityTitle : ''
  const suggested = typeof opts.suggestedFileName === 'string' ? opts.suggestedFileName.trim() : ''
  const probed = opts.probed?.fileName?.trim() ?? ''
  const probedIsHeader = opts.probed?.fileNameSource === 'content-disposition-filename'
    || opts.probed?.fileNameSource === 'content-disposition-filename-star'

  if (probedIsHeader && probed) return normalize(probed)
  if (semantic) return normalize(semantic)
  if (suggested && !isOpaqueFileName(suggested, opts)) return normalize(suggested)
  if (probed && !isOpaqueFileName(probed, opts)) return normalize(probed)
  if (pageTitle && !isOpaqueFileName(pageTitle, opts)) return normalize(pageTitle)
  if (suggested) return normalize(suggested)
  if (probed) return normalize(probed)
  return normalize('captured-file')
}
