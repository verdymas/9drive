/**
 * Resource classification for Browser Capture (pure functions — testable in
 * Node without a browser). Shared by the service worker and the popup.
 *
 * Design rules (spec Phase 01):
 *  - For HLS/DASH, prefer the MANIFEST: segment/variant URLs are suppressed so
 *    storage never floods with media chunks.
 *  - Never derive filenames from query strings (signed params).
 */

const VIDEO_EXT = /\.(m3u8|mpd|mp4|webm|m4v|mkv|mov)(?:$|[?#])/i
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|epub)(?:$|[?#])/i

/** MIME → capture type. null = not capturable. */
export function classifyMime(mime) {
  if (!mime) return null
  const m = mime.toLowerCase()
  if (m === 'application/vnd.apple.mpegurl' || m === 'application/x-mpegurl') return 'hls'
  if (m === 'application/dash+xml') return 'dash'
  if (m.startsWith('video/')) return 'video'
  if (m === 'application/pdf' || m.startsWith('application/msword') ||
      m.includes('officedocument') || m.startsWith('application/epub')) return 'document'
  return null
}

/**
 * Classify by URL + optional MIME. Returns {type, sub} or null.
 *  - sub: 'segment' | 'variant' — HLS/DASH internals that must NOT be captured.
 */
export function classifyResource(url, mime) {
  let u
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  const byMime = classifyMime(mime)

  // Manifest detection first (extension or path based).
  if (/\.m3u8(?:$|\?)/i.test(u.pathname + u.search) || byMime === 'hls') {
    return { type: 'hls', sub: isSegmentPath(u.pathname, 'm3u8') ? 'segment' : 'manifest' }
  }
  if (/\.mpd(?:$|\?)/i.test(u.pathname + u.search) || byMime === 'dash') {
    return { type: 'dash', sub: isSegmentPath(u.pathname, 'mpd') ? 'segment' : 'manifest' }
  }

  // HLS/DASH segments and subtitles are never captures.
  if (/\.(ts|m4s|mp4s|aac|key|vtt|srt)(?:$|\?)/i.test(u.pathname)) return null
  // Common CDN segment-path patterns (byterange/init/chunk naming).
  if (/(\/seg-|\/chunk-|\/segments\/|_init_|\/hls\/)/i.test(u.pathname)) {
    // Only suppress when the extension also looks like media; plain page paths
    // under an /hls/ directory stay eligible.
    if (/\.(ts|m4s|mp4)(?:$|\?)/i.test(u.pathname)) return null
  }

  const extVideo = VIDEO_EXT.test(u.pathname)
  const extDoc = DOC_EXT.test(u.pathname)
  if (byMime === 'video' || extVideo) return { type: 'video', sub: null }
  if (byMime === 'document' || extDoc) return { type: 'document', sub: null }
  return null
}

function isSegmentPath(pathname, manifestExt) {
  // A .m3u8/.mpd that ALSO looks like a per-window chunk (e.g. chunklist-b5.w3u8)
  // is still a manifest — only true segments carry media extensions. Kept for
  // future refinement; manifests always classify as 'manifest' today.
  void pathname
  void manifestExt
  return false
}

/**
 * Filename from a URL: last path segment, percent-decoded. NEVER the query.
 * Returns '' when the path has no usable final segment.
 */
export function filenameFromUrl(url) {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (!last) return ''
    return decodeURIComponent(last).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 255)
  } catch {
    return ''
  }
}

/**
 * Extract the `filename=` value from a Content-Disposition header. Handles
 * quoted and unquoted values; RFC 5987 `filename*` (UTF-8 encoded) is skipped —
 * the backend's Remote Import probe re-encodes the name at import time.
 * Returns null when absent/unparseable.
 */
export function parseContentDispositionFilename(header) {
  if (!header) return null
  const m = /filename\s*=\s*(?:"([^"]+)"|([^;]+))(?:\s*;|$)/i.exec(header)
  const name = m ? (m[1] ?? m[2])?.trim() : null
  return name && name.length > 0 ? name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 255) : null
}

/**
 * Filename priority chain: Content-Disposition > URL path > page title >
 * fallback. Signed query strings are never used. Generic HLS manifest names
 * (master/playlist/index) are skipped when a better name exists.
 */
export function detectFilename({ url, pageTitle, contentDisposition, fallback }) {
  const fromHeader = parseContentDispositionFilename(contentDisposition)
  if (fromHeader) return fromHeader
  const fromUrl = filenameFromUrl(url)
  if (fromUrl && !isGenericManifestName(fromUrl)) return fromUrl
  if (pageTitle) {
    const clean = String(pageTitle).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100)
    if (clean) return clean
  }
  return fromUrl || fallback || 'captured-file'
}

/** True for generic HLS/DASH manifest names that carry no real identity. */
function isGenericManifestName(name) {
  return /^(master|playlist|index|variant|media|chunklist)\.(m3u8?|mpd)$/i.test(name)
}

/** User-facing display type; never raw MIME as the main label. */
export function displayTypeFor(type, mime) {
  if (type === 'hls') return 'HLS Stream'
  if (type === 'dash') return 'MPEG-DASH'
  if (type === 'video') return 'Video'
  if (type === 'audio') return 'Audio'
  if (type === 'document') {
    const m = (mime || '').toLowerCase()
    return m === 'application/pdf' ? 'PDF Document' : 'Document'
  }
  return 'Unknown'
}

/** Extract a quality label (e.g. "1080p") from a filename, or null. */
export function extractQuality(filename) {
  if (!filename) return null
  const m = filename.match(/(?:^|[._\s-])(\d{3,4})p?(?:[._\s-]|$)/i)
  return m ? `${m[1]}p` : null
}

/**
 * Estimate size in bytes from a Content-Length value, or for HLS from
 * (targetDuration × EXTINF sum × bandwidth / 8). Returns null when unknown.
 */
export function estimateSize({ type, contentLength, hls }) {
  if (type !== 'hls') {
    if (contentLength == null || !/^\d+$/.test(String(contentLength))) return null
    return Number(contentLength)
  }
  // HLS: durationSeconds (from EXTINF/EXT-X-TARGETDURATION) × bitrate / 8.
  const duration = Number(hls?.durationSeconds ?? 0)
  const bandwidth = Number(hls?.bandwidth ?? 0)
  if (!(duration > 0) || !(bandwidth > 0)) return null
  return Math.round((duration * bandwidth) / 8)
}

// ── Capture grouping (for the popup) ────────────────────────────────────────

/**
 * Group captures for display:
 *  - Non-HLS: each stays its own group.
 *  - HLS variants from the same page: one group with a primary + variants.
 *    "Same page" is defined by matching `pageUrl` origin+path (ignoring query).
 *    The primary is the first detected; variants are the rest.
 *
 * Returns an array of group objects:
 *  { type: 'single', ...capture }           — a non-HLS or lone HLS capture
 *  { type: 'hls-group', primary: capture, variants: capture[] }  — grouped HLS
 */
export function groupCaptures(captures) {
  const pending = captures.filter((c) => c.status !== 'expired' && c.status !== 'consumed')

  const hls = []
  const singles = []

  for (const c of pending) {
    if (c.type === 'hls' || c.type === 'dash') hls.push(c)
    else singles.push({ ...c, type: 'single' })
  }

  // Group HLS by page origin+path (ignoring query strings).
  const byPage = new Map()
  for (const c of hls) {
    const key = hlsGroupKey(c)
    if (!byPage.has(key)) byPage.set(key, [])
    byPage.get(key).push(c)
  }

  const groups = [...singles]
  for (const [, variants] of byPage) {
    if (variants.length === 1) {
      groups.push({ ...variants[0], type: 'single' })
    } else {
      // Primary = first detected; variants = rest sorted by quality hint.
      const primary = variants[0]
      const rest = variants.slice(1).sort((a, b) => qualityRank(a.filename) - qualityRank(b.filename))
      groups.push({ type: 'hls-group', primary, variants: [primary, ...rest] })
    }
  }

  // Sort: groups first, then by most recent detection.
  return groups.sort((a, b) => {
    const ta = (a.type === 'hls-group' ? a.primary : a).ts ?? 0
    const tb = (b.type === 'hls-group' ? b.primary : b).ts ?? 0
    return tb - ta
  })
}

function hlsGroupKey(capture) {
  // Group by page URL origin + path (ignore query, which carries signed tokens).
  try {
    const u = new URL(capture.pageUrl || capture.url)
    return `${u.origin}${u.pathname}`
  } catch {
    return capture.pageUrl || capture.url || capture.id
  }
}

/** Rough quality rank from filename: higher number = higher quality. */
function qualityRank(filename) {
  if (!filename) return 0
  const m = filename.match(/(\d{3,4})p?/i)
  return m ? parseInt(m[1], 10) : 0
}
