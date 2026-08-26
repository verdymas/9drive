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
 * Filename priority chain (spec Phase 06 subset): Content-Disposition-style
 * name > URL path > page title > fallback. Signed query strings are never used.
 */
export function detectFilename({ url, pageTitle, fallback }) {
  const fromUrl = filenameFromUrl(url)
  if (fromUrl) return fromUrl
  if (pageTitle) {
    const clean = String(pageTitle).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100)
    if (clean) return clean
  }
  return fallback || 'captured-file'
}
