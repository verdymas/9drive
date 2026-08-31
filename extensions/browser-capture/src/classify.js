/**
 * Resource classification for Browser Capture (pure functions — testable in
 * Node without a browser). Shared by the service worker and the popup.
 *
 * Design rules (spec Phase 01):
 *  - For HLS/DASH, prefer the MANIFEST: segment/variant URLs are suppressed so
 *    storage never floods with media chunks.
 *  - Never derive filenames from query strings (signed params).
 */

import { parseContentDispositionFilename as parseCdFilename, sanitizeFilename } from './filename-resolver.js'

const VIDEO_EXT = /\.(m3u8|mpd|mp4|webm|m4v|mkv|mov)(?:$|[?#])/i
const AUDIO_EXT = /\.(mp3|m4a|aac|oga|ogg|opus|wav|flac|aiff?|wma)(?:$|[?#])/i
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|epub)(?:$|[?#])/i
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso|tar\.gz|tar\.bz2|tar\.xz|tar\.zst)(?:$|[?#])/i
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|heic|bmp|tiff?|svg)(?:$|[?#])/i

/** MIME → capture type. null = not capturable. */
export function classifyMime(mime) {
  if (!mime) return null
  const m = mime.toLowerCase()
  if (m === 'application/vnd.apple.mpegurl' || m === 'application/x-mpegurl') return 'hls'
  if (m === 'application/dash+xml') return 'dash'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf' || m.startsWith('application/msword') ||
      m.includes('officedocument') || m.startsWith('application/epub')) return 'document'
  if (m === 'application/zip' || m === 'application/gzip' || m === 'application/x-7z-compressed' ||
      m === 'application/x-rar-compressed' || m.includes('x-tar') || m === 'application/x-bzip2' ||
      m === 'application/x-xz' || m.includes('application/zstd')) return 'archive'
  if (m.startsWith('image/')) return 'image'
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
  const extAudio = AUDIO_EXT.test(u.pathname)
  const extDoc = DOC_EXT.test(u.pathname)
  const extArchive = ARCHIVE_EXT.test(u.pathname)
  const extImage = IMAGE_EXT.test(u.pathname)
  if (byMime === 'video' || extVideo) return { type: 'video', sub: null }
  if (byMime === 'audio' || extAudio) return { type: 'audio', sub: null }
  if (byMime === 'archive' || extArchive) return { type: 'archive', sub: null }
  if (byMime === 'image' || extImage) return { type: 'image', sub: null }
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
 * Extract the filename from a Content-Disposition header, honoring `filename*`
 * (RFC 5987, UTF-8) with `filename` fallback. Delegates to the shared
 * filename-resolver parser (port of the backend's content-disposition-parser).
 * Returns null when absent/unparseable.
 */
export function parseContentDispositionFilename(header) {
  return parseCdFilename(header)
}

/**
 * Filename priority chain: Content-Disposition > URL path > page title >
 * fallback. Signed query strings are never used. Generic HLS manifest names
 * (master/playlist/index) are skipped when a better name exists.
 *
 * @deprecated Use resolveFilename() from filename-resolver.js (candidate
 * scoring + metadata + HLS container handling). Kept for the popup's
 * qualityLabel/grouping logic and backward compatibility.
 */
export function detectFilename({ url, pageTitle, contentDisposition, fallback }) {
  const fromHeader = parseContentDispositionFilename(contentDisposition)
  if (fromHeader) return sanitizeFilename(fromHeader)
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
  return /^(master|playlist|index|variant|media|chunklist|manifest|stream|file|download|chunk|segment|prog_index|main|source|output|\d{3,4})\.(m3u8?|mpd|mp4|webm|mkv|mov|ts)$/i.test(name)
}

/** User-facing display type; never raw MIME as the main label. */
export function displayTypeFor(type, mime) {
  if (type === 'hls') return 'HLS Stream'
  if (type === 'dash') return 'MPEG-DASH'
  if (type === 'video') return 'Video'
  if (type === 'audio') return 'Audio'
  if (type === 'image') return 'Image'
  if (type === 'archive') return 'Archive'
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
 *  - HLS/DASH manifests that belong to ONE logical stream: one group with a
 *    primary + variants. Two manifests belong together when they come from the
 *    same page and live in the same provider URL tree (same origin, and the
 *    path minus quality/rendition directories matches — a master at
 *    /videos/master.m3u8 groups with /videos/1080/index.m3u8 and
 *    /videos/audio/index.m3u8). The primary is the manifest closest to the
 *    tree root that is not itself a pure quality/rendition name (the master).
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

  // Group HLS by page origin+path (ignoring query strings) + provider tree.
  const byPage = new Map()
  for (const c of hls) {
    const key = hlsGroupKey(c)
    if (!byPage.has(key)) byPage.set(key, [])
    byPage.get(key).push(c)
  }

  const groups = [...singles]
  for (const [, members] of byPage) {
    if (members.length === 1) {
      groups.push({ ...members[0], type: 'single' })
    } else {
      // Primary = the master (shallowest, non-quality name, else first seen).
      const primary = pickPrimary(members)
      const rest = members.filter((m) => m.id !== primary.id)
      // Variants sorted by quality hint (ascending — best is last).
      const variants = [primary, ...rest.sort((a, b) => qualityRank(a.filename) - qualityRank(b.filename))]
      groups.push({ type: 'hls-group', primary, variants })
    }
  }

  // Sort: groups first, then by most recent detection.
  return groups.sort((a, b) => {
    const ta = (a.type === 'hls-group' ? a.primary : a).ts ?? 0
    const tb = (b.type === 'hls-group' ? b.primary : b).ts ?? 0
    return tb - ta
  })
}

/** Directory segments that mark a quality/rendition folder (not identity). */
const VARIANT_DIR_RE = /^(?:[0-9]{3,4}p?|4k|uhd|fhd|hd|sd|audio|video|subtitle|subs|captions|aac|eng|spa|esp|deu|fra|jpn|kor|por|ita|pol|rus|tur|zho|chi|ara)$/i

/** Pure quality/rendition basename stems (never a logical primary). */
const VARIANT_STEM_RE = /^(?:[0-9]{3,4}p?|4k|uhd|fhd|hd|sd|audio|video|index|playlist|chunklist|variant|prog_index|media|stream)$/i

function hlsGroupKey(capture) {
  // Group by type (hls vs dash never mix) + page URL origin/path (query
  // carries signed tokens) plus the provider URL tree with quality/rendition
  // directories stripped.
  try {
    const page = new URL(capture.pageUrl || capture.url)
    const u = new URL(capture.url)
    const segments = u.pathname.split('/').filter(Boolean)
    segments.pop() // manifest basename
    while (segments.length > 0 && VARIANT_DIR_RE.test(segments[segments.length - 1])) segments.pop()
    const tree = segments.length > 0 ? `/${segments.join('/')}` : ''
    return `${capture.type}|${page.origin}${page.pathname}|${u.origin}${tree}`
  } catch {
    return capture.pageUrl || capture.url || capture.id
  }
}

function pickPrimary(members) {
  return [...members].sort((a, b) => {
    const da = urlDirDepth(a.url)
    const db = urlDirDepth(b.url)
    if (da !== db) return da - db
    const ga = qualityOnlyBasename(a.url) ? 1 : 0
    const gb = qualityOnlyBasename(b.url) ? 1 : 0
    if (ga !== gb) return ga - gb
    return (a.ts ?? 0) - (b.ts ?? 0)
  })[0]
}

function urlDirDepth(url) {
  try {
    return Math.max(0, new URL(url).pathname.split('/').filter(Boolean).length - 1)
  } catch {
    return 0
  }
}

function qualityOnlyBasename(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    const stem = String(last).replace(/\.(m3u8?|mpd)$/i, '')
    return VARIANT_STEM_RE.test(stem)
  } catch {
    return false
  }
}

/**
 * Quality label derived from the URL itself (quality dir or basename), e.g.
 * /videos/1080/index.m3u8 → "1080p". Falls back to the quality field, then
 * null — used by the popup to name variants precisely.
 */
export function urlQualityLabel(url) {
  if (!url) return null
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    // Prefer a quality directory segment (1080/index.m3u8 → 1080).
    for (let i = segments.length - 2; i >= 0; i -= 1) {
      const seg = segments[i]
      const stem = seg.toLowerCase()
      if (/^[0-9]{3,4}$/.test(stem)) return `${stem}p`
      if (stem === '4k' || stem === 'uhd') return '4K'
      if (stem === 'fhd') return '1080p'
      if (stem === 'hd') return '720p'
      if (stem === 'sd') return '480p'
    }
    // Then a quality basename (1080.m3u8 → 1080p).
    return extractQuality(segments[segments.length - 1] ?? '')
  } catch {
    return null
  }
}

/** Rough quality rank from filename: higher number = higher quality. */
function qualityRank(filename) {
  if (!filename) return 0
  const m = filename.match(/(\d{3,4})p?/i)
  return m ? parseInt(m[1], 10) : 0
}
