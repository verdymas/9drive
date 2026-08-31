/**
 * Central filename resolution for Browser Capture.
 *
 * Collects every available filename candidate (Content-Disposition `filename*`
 * / `filename`, HTML download attribute, final/request URL basename, page
 * metadata, media title), scores each by source, penalizes generic
 * HLS/DASH manifest names, and picks the best — applying the HLS/DASH output
 * container extension last.
 *
 * An explicit user custom filename is always final (score 1000) and is never
 * overwritten by any detected candidate.
 *
 * This is the ONLY place filename heuristics live in the extension. The rules
 * mirror the backend's Remote Import chain (content-disposition-parser.ts,
 * filename-sanitize.ts, filename-detection.ts, hls/output.ts) so extension and
 * backend stay consistent: the backend re-probes the URL at import time and
 * its own chain still wins for the final stored name.
 *
 * Pure functions — testable in Node without a browser.
 */

// ── Candidate sources + scores ─────────────────────────────────────────────

export const SOURCES = {
  CUSTOM_FILENAME: 'custom-filename',
  // ── New identity-driven sources (Phase 14: Media Identity) ─────────────
  JSONLD_VIDEOOBJECT_NAME: 'jsonld-videoobject-name',
  JSONLD_VIDEOOBJECT_HEADLINE: 'jsonld-videoobject-headline',
  PLAYER_CONFIG_TITLE: 'player-config-title',
  PLAYER_CONFIG_NAME: 'player-config-name',
  API_METADATA_TITLE: 'api-metadata-title',
  API_METADATA_NAME: 'api-metadata-name',
  DOM_VIDEO_TITLE: 'dom-video-title',
  DOM_VIDEO_ARIA_LABEL: 'dom-video-aria-label',
  DOM_VIDEO_DATA_TITLE: 'dom-video-data-title',
  DOM_VIDEO_DATA_NAME: 'dom-video-data-name',
  OG_VIDEO_TITLE: 'og-video-title',
  META_ITEMPROP_NAME: 'meta-itemprop-name',
  URL_BASENAME_NON_GENERIC: 'url-basename-non-generic',
  // ── Existing sources (preserved for legacy callers + tests) ──────────
  CD_FILENAME_STAR: 'cd-filename-star',
  CD_FILENAME: 'cd-filename',
  DOWNLOAD_ATTR: 'download-attr',
  FINAL_URL: 'final-url',
  REQUEST_URL: 'request-url',
  MEDIA_TITLE: 'media-title',
  OG_TITLE: 'og-title',
  TWITTER_TITLE: 'twitter-title',
  PAGE_TITLE: 'page-title',
  GENERIC_PLAYLIST: 'generic-playlist',
  FALLBACK: 'fallback',
}

export const SOURCE_SCORES = {
  [SOURCES.CUSTOM_FILENAME]: 1000,
  // ── New identity-driven sources (Phase 14) ─────────────────────────────
  [SOURCES.JSONLD_VIDEOOBJECT_NAME]: 100,
  [SOURCES.JSONLD_VIDEOOBJECT_HEADLINE]: 95,
  [SOURCES.PLAYER_CONFIG_TITLE]: 92,
  [SOURCES.PLAYER_CONFIG_NAME]: 88,
  [SOURCES.API_METADATA_TITLE]: 85,
  [SOURCES.API_METADATA_NAME]: 82,
  [SOURCES.DOM_VIDEO_TITLE]: 75,
  [SOURCES.DOM_VIDEO_ARIA_LABEL]: 72,
  [SOURCES.DOM_VIDEO_DATA_TITLE]: 70,
  [SOURCES.DOM_VIDEO_DATA_NAME]: 70,
  [SOURCES.OG_VIDEO_TITLE]: 65,
  [SOURCES.META_ITEMPROP_NAME]: 60,
  [SOURCES.URL_BASENAME_NON_GENERIC]: 25,
  // ── Existing sources (preserved for legacy callers + tests) ──────────
  [SOURCES.CD_FILENAME_STAR]: 100,
  [SOURCES.CD_FILENAME]: 95,
  [SOURCES.DOWNLOAD_ATTR]: 90,
  [SOURCES.FINAL_URL]: 80,
  [SOURCES.REQUEST_URL]: 70,
  [SOURCES.MEDIA_TITLE]: 65,
  [SOURCES.OG_TITLE]: 65,
  [SOURCES.TWITTER_TITLE]: 60,
  [SOURCES.PAGE_TITLE]: 45,
  [SOURCES.GENERIC_PLAYLIST]: 10,
  [SOURCES.FALLBACK]: 0,
}

/** A candidate filename with its provenance and score. */
export const FilenameCandidate = (value, source, score) => ({ value, source, score })

// ── Generic (technical) names that carry no real identity ──────────────────

const GENERIC_NAMES = new Set([
  'index', 'playlist', 'master', 'manifest', 'stream', 'video', 'media',
  'file', 'download', 'chunk', 'segment', 'chunklist', 'variant',
  'prog_index', 'main', 'source', 'output', '1080', '720', '480', '360',
])

const GENERIC_EXT_RE = /\.(m3u8?|mpd|mp4|webm|mkv|mov|ts|m4s)$/i

/**
 * True for generic/technical names (e.g. `master.m3u8`, `1080.mp4`). The
 * extension is stripped before the stem is checked. Used to de-prioritize
 * candidates that describe the transport rather than the content.
 */
export function isGenericName(name) {
  if (!name) return false
  const stem = String(name).replace(GENERIC_EXT_RE, '').replace(/^.*[/\\]/, '').trim().toLowerCase()
  if (!stem) return true
  return GENERIC_NAMES.has(stem)
}

// ── Content-Disposition parsing (RFC 5987 + 6266) ──────────────────────────
// Ported from backend/src/modules/remote-imports/content-disposition-parser.ts

function isTokenChar(ch) {
  if (ch.length !== 1) return false
  const code = ch.charCodeAt(0)
  if (code > 126) return false
  if (code <= 32) return false
  return '()<>@,;:\\"/[]?={} \t'.indexOf(ch) === -1
}

function getDispositionParameter(header, name) {
  const lower = name.toLowerCase()
  let i = 0
  const n = header.length
  while (i < n) {
    while (i < n && (header[i] === ' ' || header[i] === '\t' || header[i] === ';')) i += 1
    if (i >= n) return null

    const start = i
    while (i < n && isTokenChar(header[i])) i += 1
    if (i < n && header[i] === '*') i += 1
    if (start === i) {
      i += 1
      continue
    }
    const key = header.slice(start, i)

    while (i < n && (header[i] === ' ' || header[i] === '\t')) i += 1
    if (i >= n || header[i] !== '=') continue
    i += 1
    while (i < n && (header[i] === ' ' || header[i] === '\t')) i += 1
    if (i >= n) return null

    if (key.toLowerCase() !== lower) {
      if (header[i] === '"') {
        i += 1
        while (i < n) {
          if (header[i] === '\\') { i += 2; continue }
          if (header[i] === '"') break
          i += 1
        }
        if (i < n) i += 1
      } else {
        while (i < n && isTokenChar(header[i])) i += 1
      }
      continue
    }

    if (header[i] === '"') {
      i += 1
      let out = ''
      while (i < n) {
        const ch = header[i]
        if (ch === '\\') {
          if (i + 1 < n) { out += header[i + 1]; i += 2; continue }
          break
        }
        if (ch === '"') { i += 1; return out }
        out += ch
        i += 1
      }
      return null
    }

    const valueStart = i
    while (i < n && isTokenChar(header[i])) i += 1
    if (valueStart === i) return null
    return header.slice(valueStart, i)
  }
  return null
}

function percentDecodeStrict(input) {
  try {
    return { ok: true, value: decodeURIComponent(input) }
  } catch {
    return { ok: false, value: input }
  }
}

function isExtValue(value) {
  return /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e%]*$/.test(value)
}

function hasControlChar(value) {
  return /[\x00-\x1f\x7f]/.test(value)
}

function decodeExtValue(value) {
  const match = /^([^']*)'([^']*)'(.*)$/.exec(value)
  if (!match) return { ok: false, value }
  const charset = match[1].toLowerCase()
  const ext = match[3]
  if (charset !== 'utf-8') return { ok: false, value }
  if (!isExtValue(ext)) return { ok: false, value }
  const decoded = percentDecodeStrict(ext)
  if (!decoded.ok || hasControlChar(decoded.value)) return { ok: false, value }
  return { ok: true, value: decoded.value }
}

/**
 * Parse a Content-Disposition header value and return the effective filename,
 * or null when no usable filename is present. `filename*` (RFC 5987, UTF-8)
 * wins over `filename`; a broken `filename*` falls back to `filename`
 * (RFC 6266 precedence). Sanitize the result before trusting it.
 */
export function parseContentDispositionFilename(header) {
  if (!header) return null
  const ext = getDispositionParameter(header, 'filename*')
  if (ext !== null) {
    const decoded = decodeExtValue(ext)
    if (decoded.ok && decoded.value.length > 0) return decoded.value
  }
  const plain = getDispositionParameter(header, 'filename')
  if (plain !== null && plain.length > 0) return plain
  return null
}

// ── Sanitizer ───────────────────────────────────────────────────────────────
// Ported from backend/src/modules/remote-imports/filename-sanitize.ts

const CONTROL_CHARS = /[\x00-\x1f\x7f]+/g
const ILLEGAL_CHARS = /[<>:"|?*]+/g
const PATH_SEPARATORS = /[\\/]+/g
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const RESERVED_WITH_EXT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.(.*)$/i
const TRAILING_DOTS_SPACES = /[. ]+$/

export const MAX_NAME_LENGTH = 255

function splitExtension(name) {
  const multi = /\.(tar\.gz|tar\.bz2|tar\.xz|tar\.zst)$/i.exec(name)
  if (multi) return [name.slice(0, multi.index), name.slice(multi.index + 1)]
  const dot = name.lastIndexOf('.')
  if (dot > 0) return [name.slice(0, dot), name.slice(dot + 1)]
  return [name, '']
}

function replaceReserved(name) {
  if (RESERVED_WINDOWS.test(name)) {
    const m = RESERVED_WITH_EXT.exec(name)
    return m ? `file.${m[2]}` : 'file'
  }
  return null
}

/**
 * Sanitize a candidate filename. `raw` may be anything the remote or the user
 * supplied; the result is always a safe, non-empty, path-free name.
 */
export function sanitizeFilename(raw) {
  const fallback = 'file'
  let name = String(raw ?? '')
    .normalize('NFC')
    .replace(PATH_SEPARATORS, '-')
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_CHARS, '')
    .trim()
  if (!name) return fallback
  if (name === '.' || name === '..') return fallback
  const replaced = replaceReserved(name)
  if (replaced) return replaced
  if (name.length > MAX_NAME_LENGTH) {
    const [stem, ext] = splitExtension(name)
    const room = MAX_NAME_LENGTH - (ext ? ext.length + 1 : 0)
    name = stem.slice(0, Math.max(room, 1)) + (ext ? `.${ext}` : '')
  }
  if (TRAILING_DOTS_SPACES.test(name)) name = name.replace(TRAILING_DOTS_SPACES, '')
  return name || fallback
}

// ── URL basename ───────────────────────────────────────────────────────────

/**
 * Last usable pathname segment of a URL, percent-decoded, with illegal
 * filename chars replaced by `-`. Never reads query strings (signed params).
 * Returns '' when the URL has no usable basename.
 */
export function filenameFromUrl(url) {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (!last) return ''
    return decodeURIComponent(last).replace(/[\\/:*?"<>|]+/g, '-').slice(0, MAX_NAME_LENGTH)
  } catch {
    return ''
  }
}

// ── Site-suffix cleanup for page titles ────────────────────────────────────

/** Known site-name suffixes; matched as `\s*(?:-|–|•|\|)?\s*<suffix>$`. */
const SITE_SUFFIXES = [
  'YouTube', 'Facebook', 'Reddit', 'Wikipedia', 'IMDb', 'Netflix', 'Twitch',
  'Vimeo', 'Dailymotion', 'Bilibili', 'Twitter', 'Instagram', 'TikTok',
  'Apple TV', 'Disney+', 'Prime Video', 'Hulu', 'Tubi', 'Plex', 'Jellyfin',
  'archive.org', 'VK', 'OK.ru',
]

/**
 * Conservatively remove a trailing site-name suffix from a page title. Only
 * known suffixes are stripped — never everything after a dash.
 */
export function removeSiteSuffix(title) {
  if (!title) return ''
  let clean = String(title).replace(/[\r\n\t]+/g, ' ').trim()
  for (const suffix of SITE_SUFFIXES) {
    const re = new RegExp(`\\s*(?:-|–|•|\\|)\\s*${suffix.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
    if (re.test(clean)) {
      clean = clean.replace(re, '').trim()
      break
    }
  }
  return clean
}

// ── HLS/DASH output container ──────────────────────────────────────────────
// Matches backend hls/output.ts: `auto` → MKV by default (REMOTE_IMPORT_HLS_DEFAULT_CONTAINER).

/** The extension's display extension for HLS/DASH imports (MKV by default). */
export const HLS_OUTPUT_EXTENSION = 'mkv'
// ponytail: read the backend's HLS output container from the import-options
// payload if it ever exposes it; the backend re-derives the real extension at
// import time anyway (hlsFinalFileName), so this only affects the UI hint.

const MANIFEST_EXT_RE = /\.(m3u8?|mpd)$/i

/**
 * Convert a candidate to the HLS/DASH output container name: drop the
 * playlist suffix (`.m3u8`/`.mpd`) and any OTHER media extension (e.g. a
 * Content-Disposition `Movie.mp4`) so the name matches the container the
 * backend will remux to — a mismatched extension would be rejected at import
 * time (hlsFinalFileName → FILE_NAME_EXTENSION_MISMATCH). Names that already
 * carry the output extension are kept as-is.
 */
function withOutputExtension(name) {
  if (name.toLowerCase().endsWith(`.${HLS_OUTPUT_EXTENSION}`)) return name
  const clean = String(name)
    .replace(MANIFEST_EXT_RE, '')
    .replace(/\.(mp4|webm|mov|m4v|ts|mkv|avi)$/i, '')
    .replace(/\.+$/, '')
    .trim()
  return `${clean || 'video'}.${HLS_OUTPUT_EXTENSION}`
}

// ── Main resolver ──────────────────────────────────────────────────────────

function isHlsLike(type) {
  return type === 'hls' || type === 'dash'
}

// Title-source set: any candidate whose source is in this set is treated as
// a "real" identity (vs. a URL basename or transport header) and gets the
// HLS quality-label append on the container swap.
const TITLE_SOURCES = new Set([
  // Legacy
  SOURCES.MEDIA_TITLE, SOURCES.OG_TITLE, SOURCES.TWITTER_TITLE, SOURCES.PAGE_TITLE,
  // Phase 14 — Media Identity
  SOURCES.JSONLD_VIDEOOBJECT_NAME, SOURCES.JSONLD_VIDEOOBJECT_HEADLINE,
  SOURCES.PLAYER_CONFIG_TITLE, SOURCES.PLAYER_CONFIG_NAME,
  SOURCES.API_METADATA_TITLE, SOURCES.API_METADATA_NAME,
  SOURCES.DOM_VIDEO_TITLE, SOURCES.DOM_VIDEO_ARIA_LABEL,
  SOURCES.DOM_VIDEO_DATA_TITLE, SOURCES.DOM_VIDEO_DATA_NAME,
  SOURCES.OG_VIDEO_TITLE, SOURCES.META_ITEMPROP_NAME,
])

/**
 * Score candidates, penalize generic names, sort, and finalize the filename
 * (HLS container swap, sanitize). Used by both the legacy and the new
 * identity-driven entry points.
 */
function scoreAndFinalize(candidates, { type, quality }) {
  // Penalize generic/technical names (master.m3u8, 1080.mp4, ...) — they must
  // never dominate a better metadata- or header-derived name.
  const scored = candidates.map((c) =>
    isGenericName(c.value) && c.source !== SOURCES.CUSTOM_FILENAME
      ? FilenameCandidate(c.value, c.source, Math.min(c.score, SOURCE_SCORES[SOURCES.GENERIC_PLAYLIST]))
      : c,
  )

  // Sort by score descending (stable: first-collected wins ties).
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]

  // HLS/DASH: the output is remuxed server-side, so the stored/display name
  // must carry the output container extension, never a playlist suffix.
  let filename = best.value
  if (isHlsLike(type) && best.source !== SOURCES.CUSTOM_FILENAME) {
    if (TITLE_SOURCES.has(best.source)) {
      // Title-derived (page/metadata title, site suffix already stripped by
      // titleCandidates) → append the quality label if available.
      filename = withOutputExtension(best.value + (quality ? ` ${quality}` : ''))
    } else {
      // URL / Content-Disposition / download-attr derived → just swap the
      // playlist or media extension for the output container.
      filename = withOutputExtension(best.value)
    }
  }

  const safe = sanitizeFilename(filename)

  // Safe dev-only diagnostics (never URLs, cookies, tokens, or secrets).
  console.debug(`[filename-resolver] selectedSource=${best.source} score=${best.score} resourceType=${type ?? ''} quality=${quality ?? ''} result=${safe}`)

  return { filename: safe, source: best.source, candidates: scored }
}

/**
 * Resolve the best filename for a captured resource.
 *
 * @param {object} opts
 * @param {string|null} opts.customFilename  explicit user override (never overwritten)
 * @param {string|null} opts.contentDisposition  raw Content-Disposition header
 * @param {string|null} opts.downloadAttr  HTML `download` attribute value
 * @param {string|null} opts.requestUrl  original request URL
 * @param {string|null} opts.finalUrl  final URL after redirects
 * @param {object|null} opts.pageMetadata  { title, ogTitle, twitterTitle, mediaTitle, ogVideoTitle, itempropName, thumbnail, duration, resolution, quality }
 * @param {string} opts.type  'hls' | 'dash' | 'video' | 'document' | ...
 * @param {string|null} opts.quality  extracted quality label (e.g. '1080p')
 * @returns {{ filename: string, source: string, candidates: Array }}
 */
export function resolveFilename({ customFilename, contentDisposition, downloadAttr, requestUrl, finalUrl, pageMetadata, type, quality }) {
  const candidates = []

  // 1. Explicit user override — absolute priority.
  if (customFilename && String(customFilename).trim()) {
    candidates.push(FilenameCandidate(String(customFilename).trim(), SOURCES.CUSTOM_FILENAME, SOURCE_SCORES[SOURCES.CUSTOM_FILENAME]))
  }

  // 2. Content-Disposition (filename* first, then filename).
  const cd = parseContentDispositionFilename(contentDisposition ?? null)
  if (cd) {
    const isStar = /filename\*=/i.test(contentDisposition)
    candidates.push(FilenameCandidate(cd, isStar ? SOURCES.CD_FILENAME_STAR : SOURCES.CD_FILENAME, isStar ? SOURCE_SCORES[SOURCES.CD_FILENAME_STAR] : SOURCE_SCORES[SOURCES.CD_FILENAME]))
  }

  // 3. HTML download attribute.
  if (downloadAttr && String(downloadAttr).trim()) {
    candidates.push(FilenameCandidate(String(downloadAttr).trim(), SOURCES.DOWNLOAD_ATTR, SOURCE_SCORES[SOURCES.DOWNLOAD_ATTR]))
  }

  // 4. Final URL basename (after redirects — more likely to carry a real name).
  const finalName = finalUrl ? filenameFromUrl(finalUrl) : ''
  if (finalName) candidates.push(FilenameCandidate(finalName, SOURCES.FINAL_URL, SOURCE_SCORES[SOURCES.FINAL_URL]))

  // 5. Original request URL basename.
  const requestName = requestUrl ? filenameFromUrl(requestUrl) : ''
  if (requestName) candidates.push(FilenameCandidate(requestName, SOURCES.REQUEST_URL, SOURCE_SCORES[SOURCES.REQUEST_URL]))

  // 6. Page metadata titles (legacy + Phase 14 extended fields).
  candidates.push(...extendedPageMetadataCandidates(pageMetadata))

  // 7. Fallback — never empty.
  if (candidates.length === 0) {
    candidates.push(FilenameCandidate('captured-file', SOURCES.FALLBACK, SOURCE_SCORES[SOURCES.FALLBACK]))
  }

  return scoreAndFinalize(candidates, { type, quality })
}

/**
 * Extended page-metadata title candidates. Includes the legacy 4 fields
 * (mediaTitle / ogTitle / twitterTitle / title) and the new Phase 14 fields
 * (ogVideoTitle, itempropName) that the content script can stash into
 * pageMetadata directly. The richer identity sources (JSON-LD, player
 * config, API, DOM video) flow through the new resolveFromMediaIdentity()
 * path and are NOT inlined here.
 */
function extendedPageMetadataCandidates(metadata) {
  if (!metadata || typeof metadata !== 'object') return []
  const out = []
  const pairs = [
    [SOURCES.MEDIA_TITLE, 'mediaTitle'],
    [SOURCES.OG_TITLE, 'ogTitle'],
    [SOURCES.OG_VIDEO_TITLE, 'ogVideoTitle'],
    [SOURCES.TWITTER_TITLE, 'twitterTitle'],
    [SOURCES.META_ITEMPROP_NAME, 'itempropName'],
    [SOURCES.PAGE_TITLE, 'title'],
  ]
  for (const [source, key] of pairs) {
    const raw = metadata[key]
    if (raw && typeof raw === 'string') {
      const cleaned = removeSiteSuffix(raw)
      if (cleaned) out.push(FilenameCandidate(cleaned, source, SOURCE_SCORES[source]))
    }
  }
  return out
}

/**
 * Resolve a filename from a full MediaIdentity object. The identity already
 * contains all scored candidates from JSON-LD / player / API / DOM / page
 * metadata; the resolver applies generic-name demotion, HLS container swap,
 * and the custom-filename lock.
 *
 * @param {object} identity  Output of extractMediaIdentity()
 * @param {object} [opts]
 * @param {string|null} [opts.customFilename]  explicit user override
 * @param {string|null} [opts.contentDisposition]
 * @param {string|null} [opts.downloadAttr]
 * @param {string|null} [opts.requestUrl]
 * @param {string|null} [opts.finalUrl]
 * @param {string}      [opts.type]   — resource type
 * @param {string|null} [opts.quality]
 * @returns {{ filename: string, source: string, confidence: number, candidates: Array }}
 */
export function resolveFromMediaIdentity(identity, opts = {}) {
  const type = opts.type ?? identity?.type ?? null
  const quality = opts.quality ?? identity?.quality ?? null
  const candidates = []

  // 1. Explicit user override — absolute priority.
  const custom = opts.customFilename ?? null
  if (custom && String(custom).trim()) {
    candidates.push(FilenameCandidate(String(custom).trim(), SOURCES.CUSTOM_FILENAME, SOURCE_SCORES[SOURCES.CUSTOM_FILENAME]))
  }

  // 2. Content-Disposition.
  const cd = parseContentDispositionFilename(opts.contentDisposition ?? null)
  if (cd) {
    const isStar = /filename\*=/i.test(opts.contentDisposition)
    candidates.push(FilenameCandidate(cd, isStar ? SOURCES.CD_FILENAME_STAR : SOURCES.CD_FILENAME, isStar ? SOURCE_SCORES[SOURCES.CD_FILENAME_STAR] : SOURCE_SCORES[SOURCES.CD_FILENAME]))
  }

  // 3. HTML download attribute.
  if (opts.downloadAttr && String(opts.downloadAttr).trim()) {
    candidates.push(FilenameCandidate(String(opts.downloadAttr).trim(), SOURCES.DOWNLOAD_ATTR, SOURCE_SCORES[SOURCES.DOWNLOAD_ATTR]))
  }

  // 4-5. URL basenames — both final and request, generic-aware.
  const finalName = opts.finalUrl ? filenameFromUrl(opts.finalUrl) : ''
  if (finalName) {
    const src = isGenericName(finalName) ? SOURCES.FINAL_URL : SOURCES.URL_BASENAME_NON_GENERIC
    candidates.push(FilenameCandidate(finalName, src, SOURCE_SCORES[src] ?? SOURCE_SCORES[SOURCES.FINAL_URL]))
  }
  const requestName = opts.requestUrl ? filenameFromUrl(opts.requestUrl) : ''
  if (requestName) {
    const src = isGenericName(requestName) ? SOURCES.REQUEST_URL : SOURCES.URL_BASENAME_NON_GENERIC
    candidates.push(FilenameCandidate(requestName, src, SOURCE_SCORES[src] ?? SOURCE_SCORES[SOURCES.REQUEST_URL]))
  }

  // 6. Identity candidates — already scored by extractMediaIdentity.
  if (identity && Array.isArray(identity.identity?.candidates)) {
    for (const c of identity.identity.candidates) {
      if (!c.value) continue
      const source = c.source
      if (!Object.values(SOURCES).includes(source)) continue
      // Skip fallback source 0-score candidates — they only exist to keep the
      // list non-empty for debug; the final result is never them.
      if (source === SOURCES.FALLBACK) continue
      const score = SOURCE_SCORES[source] ?? c.confidence ?? 0
      candidates.push(FilenameCandidate(c.value, source, score))
    }
  }

  // 7. Fallback — never empty.
  if (candidates.length === 0) {
    candidates.push(FilenameCandidate('captured-file', SOURCES.FALLBACK, SOURCE_SCORES[SOURCES.FALLBACK]))
  }

  const result = scoreAndFinalize(candidates, { type, quality })
  return {
    ...result,
    confidence: identity?.identity?.selectedConfidence ?? 0,
    selectedSource: result.source,
  }
}
