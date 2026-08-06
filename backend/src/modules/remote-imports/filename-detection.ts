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
import { appendExtension, sanitizeFileName } from './filename-sanitize.js'

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
}): DetectedFileName {
  if (opts.contentDisposition) {
    const fromHeader = parseContentDispositionFileName(opts.contentDisposition)
    if (fromHeader) {
      const sanitized = sanitizeFileName(fromHeader)
      if (sanitized && sanitized !== 'file') {
        const isStar = /filename\*=/i.test(opts.contentDisposition)
        return {
          fileName: sanitized,
          fileNameSource: isStar ? 'content-disposition-filename-star' : 'content-disposition-filename',
        }
      }
    }
  }

  const finalSegment = lastUsablePathSegment(opts.finalUrl)
  if (finalSegment) {
    return { fileName: sanitizeFileName(finalSegment), fileNameSource: 'final-url-path' }
  }

  const originalSegment = lastUsablePathSegment(opts.originalUrl)
  if (originalSegment) {
    return { fileName: sanitizeFileName(originalSegment), fileNameSource: 'original-url-path' }
  }

  const fallback = generatedFallback(opts.fallbackShortId, opts.extension)
  return { fileName: sanitizeFileName(fallback), fileNameSource: 'generated-fallback' }
}
