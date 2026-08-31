/**
 * Media Identity — pure scoring + identity object.
 *
 * Goal: make 9Drive behave closer to IDM/XDM by understanding WHAT the user is
 * downloading, not only the URL being requested. The current pipeline only
 * collects 4 metadata fields (title, ogTitle, twitterTitle, mediaTitle). This
 * module adds scoring for JSON-LD, player configs, DOM media elements, and API
 * metadata, and exposes a single MediaIdentity object the resolver consumes.
 *
 * No chrome.* API calls. Pure functions — testable in Node without a browser.
 */

// ── Source labels + scores ──────────────────────────────────────────────────
//
// Stable identifiers so tests + debug logs can match exactly. The numeric
// values are calibrated so a rich JSON-LD name always beats a generic
// document.title, and a generic URL basename is always last. Ties are broken
// by the order the candidates are listed in the input (deterministic).

export const IDENTITY_SOURCES = {
  JSONLD_VIDEOOBJECT_NAME: 'jsonld-videoobject-name',
  JSONLD_VIDEOOBJECT_HEADLINE: 'jsonld-videoobject-headline',
  JSONLD_VIDEOOBJECT_DESCRIPTION: 'jsonld-videoobject-description',
  PLAYER_CONFIG_TITLE: 'player-config-title',
  PLAYER_CONFIG_NAME: 'player-config-name',
  PLAYER_CONFIG_FILENAME: 'player-config-filename',
  API_METADATA_TITLE: 'api-metadata-title',
  API_METADATA_NAME: 'api-metadata-name',
  DOM_VIDEO_TITLE: 'dom-video-title',
  DOM_VIDEO_ARIA_LABEL: 'dom-video-aria-label',
  DOM_VIDEO_DATA_TITLE: 'dom-video-data-title',
  DOM_VIDEO_DATA_NAME: 'dom-video-data-name',
  DOM_TRACK_LABEL: 'dom-track-label',
  OG_TITLE: 'og-title',
  OG_VIDEO_TITLE: 'og-video-title',
  TWITTER_TITLE: 'twitter-title',
  META_ITEMPROP_NAME: 'meta-itemprop-name',
  MEDIA_TITLE: 'media-title',
  PAGE_TITLE: 'page-title',
  URL_BASENAME_NON_GENERIC: 'url-basename-non-generic',
  URL_BASENAME_GENERIC: 'url-basename-generic',
  FALLBACK: 'fallback',
}

export const IDENTITY_SCORES = {
  [IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_NAME]: 100,
  [IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_HEADLINE]: 95,
  [IDENTITY_SOURCES.PLAYER_CONFIG_TITLE]: 92,
  [IDENTITY_SOURCES.PLAYER_CONFIG_NAME]: 88,
  [IDENTITY_SOURCES.API_METADATA_TITLE]: 85,
  [IDENTITY_SOURCES.API_METADATA_NAME]: 82,
  [IDENTITY_SOURCES.DOM_VIDEO_TITLE]: 75,
  [IDENTITY_SOURCES.DOM_VIDEO_ARIA_LABEL]: 72,
  [IDENTITY_SOURCES.DOM_VIDEO_DATA_TITLE]: 70,
  [IDENTITY_SOURCES.DOM_VIDEO_DATA_NAME]: 70,
  [IDENTITY_SOURCES.OG_TITLE]: 65,
  [IDENTITY_SOURCES.OG_VIDEO_TITLE]: 65,
  [IDENTITY_SOURCES.TWITTER_TITLE]: 60,
  [IDENTITY_SOURCES.META_ITEMPROP_NAME]: 60,
  [IDENTITY_SOURCES.MEDIA_TITLE]: 60,
  [IDENTITY_SOURCES.DOM_TRACK_LABEL]: 55,
  [IDENTITY_SOURCES.PAGE_TITLE]: 45,
  [IDENTITY_SOURCES.URL_BASENAME_NON_GENERIC]: 25,
  [IDENTITY_SOURCES.URL_BASENAME_GENERIC]: 5,
  [IDENTITY_SOURCES.FALLBACK]: 0,
  // Unused score but kept for reference: a description is never used as the
  // primary title, only as a last-resort fallback when nothing else is present.
  [IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_DESCRIPTION]: 0,
  [IDENTITY_SOURCES.PLAYER_CONFIG_FILENAME]: 0,
}

// ── Generic-stem list (expanded vs. filename-resolver.js) ──────────────────
//
// A name is "generic" if its stem (extension + path stripped) is one of these
// tokens, OR if it is a short numeric ID that has no semantic value (e.g. the
// "3r8x" in /v/3r8x.m3u8). Generic URL basenames can never win against
// metadata, but they still count as a candidate so the debug log shows them.

const GENERIC_STEMS = new Set([
  // transport / packaging
  'index', 'playlist', 'master', 'manifest', 'stream', 'video', 'media',
  'file', 'download', 'chunk', 'segment', 'chunklist', 'variant',
  'prog_index', 'main', 'source', 'output', 'chunk', 'seg',
  // quality numbers as stems (1080.mp4 etc.)
  '1080', '720', '480', '360', '240', '144',
  '1080p', '720p', '480p', '360p', '240p', '144p', '4k', '2k', '8k',
  // common media-related stems that carry no real identity
  'movie', 'clip', 'sample', 'trailer', 'preview', 'teaser', 'intro',
  'outro', 'recap', 'feature', 'bonus', 'extra', 'deleted',
  'ep', 'episode', 'part', 'scene', 'cut', 'version', 'final',
  // short single-letter / two-letter stems (Vimeo / YouTube / archive paths)
  'v', 'm', 'a', 's', 'p', 'f', 'd', 't', 'x',
  // CDN-tree patterns
  'vod', 'live', 'dash', 'hls', 'cdn', 'edge', 'origin', 'static',
])

// Bare-numeric stems or patterns like v123, ep05, s01e03 → always generic.
const NUMERIC_STEM_RE = /^v\d+$/i
const SHORT_NUMERIC_RE = /^[a-z]?\d{1,4}$/i

/**
 * True for generic/technical names. Extension is stripped before the stem is
 * checked. The path tail is included so `…/master` matches without an
 * extension.
 */
export function isGenericName(name) {
  if (!name) return false
  const stem = String(name)
    .replace(/\.(m3u8?|mpd|mp4|webm|mkv|mov|ts|m4s|mp3|m4a|aac|oga|ogg|opus|wav|flac|pdf|zip|rar|7z)$/i, '')
    .replace(/^.*[\\/]/, '')
    .trim()
    .toLowerCase()
  if (!stem) return true
  if (GENERIC_STEMS.has(stem)) return true
  if (NUMERIC_STEM_RE.test(stem)) return true
  if (SHORT_NUMERIC_RE.test(stem)) return true
  return false
}

// ── String sanitization for candidate values ───────────────────────────────

const CONTROL_CHARS = /[\x00-\x1f\x7f]+/g
const NEWLINES = /[\r\n\t]+/g
const TRIM_QUOTES = /^["'`]+|["'`]+$/g

function clean(value, max = 512) {
  if (value == null) return null
  const s = String(value)
    .replace(CONTROL_CHARS, '')
    .replace(NEWLINES, ' ')
    .replace(TRIM_QUOTES, '')
    .trim()
  if (!s) return null
  return s.slice(0, max)
}

// ── ISO 8601 duration parser (PT1H30M5S → seconds) ─────────────────────────

function parseIso8601Duration(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  const s = String(value).trim()
  if (!s.startsWith('PT')) return null
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(s)
  if (!match) return null
  const h = Number(match[1] ?? 0)
  const m = Number(match[2] ?? 0)
  const sec = Number(match[3] ?? 0)
  const total = h * 3600 + m * 60 + sec
  return total > 0 ? Math.round(total) : null
}

// ── JSON-LD extraction ─────────────────────────────────────────────────────

/**
 * Walk a parsed JSON-LD object and return all VideoObject-shaped entries,
 * including ones nested inside `@graph` containers. Non-video objects are
 * ignored. Returns an array even if the top-level object IS a VideoObject.
 */
function videoObjectsFromJsonLd(node, out = [], seen = new WeakSet()) {
  if (!node || typeof node !== 'object') return out
  if (seen.has(node)) return out
  seen.add(node)

  // Array → walk each element.
  if (Array.isArray(node)) {
    for (const item of node) videoObjectsFromJsonLd(item, out, seen)
    return out
  }

  const type = node['@type']
  const types = Array.isArray(type) ? type : type ? [type] : []
  const isVideo = types.some((t) => {
    if (typeof t !== 'string') return false
    const lc = t.toLowerCase()
    return lc === 'videoobject' || lc === 'movie' || lc === 'tvclip' || lc === 'shortfilm'
  })
  if (isVideo) out.push(node)

  if (Array.isArray(node['@graph'])) {
    for (const item of node['@graph']) videoObjectsFromJsonLd(item, out, seen)
  }

  return out
}

/** Accept either a parsed object or a JSON string; return [] on bad input. */
export function parseJsonLdVideoObjects(value) {
  if (value == null) return []
  let parsed
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return [] }
  } else if (typeof value === 'object') {
    parsed = value
  } else {
    return []
  }
  return videoObjectsFromJsonLd(parsed)
}

// ── Helpers for thumbnail + duration normalization ─────────────────────────

function firstString(...candidates) {
  for (const c of candidates) {
    const v = clean(c)
    if (v) return v
  }
  return null
}

function firstThumbnail(value) {
  if (value == null) return null
  if (Array.isArray(value)) {
    for (const v of value) {
      const c = clean(v)
      if (c) return c
    }
    return null
  }
  return clean(value)
}

// ── Source-by-source candidate builders ────────────────────────────────────

function jsonLdCandidates(jsonLdVideos) {
  const out = []
  for (const v of jsonLdVideos) {
    const name = firstString(v.name, v.alternateName)
    if (name) out.push({ value: name, source: IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_NAME, reason: 'VideoObject.name' })
    const headline = firstString(v.headline)
    if (headline) out.push({ value: headline, source: IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_HEADLINE, reason: 'VideoObject.headline' })
    const desc = firstString(v.description)
    if (desc) out.push({ value: desc, source: IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_DESCRIPTION, reason: 'VideoObject.description' })
  }
  return out
}

function playerConfigCandidates(playerConfigs) {
  const out = []
  for (const c of playerConfigs ?? []) {
    const title = firstString(c.title)
    if (title) out.push({ value: title, source: IDENTITY_SOURCES.PLAYER_CONFIG_TITLE, reason: `${c.source}.title` })
    const name = firstString(c.name)
    if (name) out.push({ value: name, source: IDENTITY_SOURCES.PLAYER_CONFIG_NAME, reason: `${c.source}.name` })
    const filename = firstString(c.filename)
    if (filename) out.push({ value: filename, source: IDENTITY_SOURCES.PLAYER_CONFIG_FILENAME, reason: `${c.source}.filename` })
  }
  return out
}

function apiMetadataCandidates(apiMetadata) {
  const out = []
  for (const m of apiMetadata ?? []) {
    const title = firstString(m.title)
    if (title) out.push({ value: title, source: IDENTITY_SOURCES.API_METADATA_TITLE, reason: `api.${m.source}.title` })
    const name = firstString(m.name)
    if (name) out.push({ value: name, source: IDENTITY_SOURCES.API_METADATA_NAME, reason: `api.${m.source}.name` })
  }
  return out
}

function domMediaCandidates(videoElements) {
  const out = []
  for (const v of videoElements ?? []) {
    const title = firstString(v.title)
    if (title) out.push({ value: title, source: IDENTITY_SOURCES.DOM_VIDEO_TITLE, reason: 'video[title]' })
    const aria = firstString(v.ariaLabel)
    if (aria) out.push({ value: aria, source: IDENTITY_SOURCES.DOM_VIDEO_ARIA_LABEL, reason: 'video[aria-label]' })
    const dataTitle = firstString(v.dataTitle)
    if (dataTitle) out.push({ value: dataTitle, source: IDENTITY_SOURCES.DOM_VIDEO_DATA_TITLE, reason: 'video[data-title]' })
    const dataName = firstString(v.dataName)
    if (dataName) out.push({ value: dataName, source: IDENTITY_SOURCES.DOM_VIDEO_DATA_NAME, reason: 'video[data-name]' })
    for (const track of v.tracks ?? []) {
      const label = firstString(track?.label)
      if (label) out.push({ value: label, source: IDENTITY_SOURCES.DOM_TRACK_LABEL, reason: 'track[label]' })
    }
  }
  return out
}

function pageMetadataCandidates(pageMetadata) {
  if (!pageMetadata || typeof pageMetadata !== 'object') return []
  const out = []
  const og = firstString(pageMetadata.ogTitle)
  if (og) out.push({ value: og, source: IDENTITY_SOURCES.OG_TITLE, reason: 'og:title' })
  const ogVideo = firstString(pageMetadata.ogVideoTitle)
  if (ogVideo) out.push({ value: ogVideo, source: IDENTITY_SOURCES.OG_VIDEO_TITLE, reason: 'og:video:title' })
  const tw = firstString(pageMetadata.twitterTitle)
  if (tw) out.push({ value: tw, source: IDENTITY_SOURCES.TWITTER_TITLE, reason: 'twitter:title' })
  const media = firstString(pageMetadata.mediaTitle)
  if (media) out.push({ value: media, source: IDENTITY_SOURCES.MEDIA_TITLE, reason: '<video title>' })
  const itemprop = firstString(pageMetadata.itempropName)
  if (itemprop) out.push({ value: itemprop, source: IDENTITY_SOURCES.META_ITEMPROP_NAME, reason: 'meta[itemprop=name]' })
  const page = firstString(pageMetadata.title)
  if (page) out.push({ value: page, source: IDENTITY_SOURCES.PAGE_TITLE, reason: 'document.title' })
  return out
}

function urlBasenameCandidates(urls) {
  const out = []
  for (const u of urls ?? []) {
    const basename = filenameBasename(u)
    if (!basename) continue
    const source = isGenericName(basename)
      ? IDENTITY_SOURCES.URL_BASENAME_GENERIC
      : IDENTITY_SOURCES.URL_BASENAME_NON_GENERIC
    out.push({ value: basename, source, reason: `url basename (${source === IDENTITY_SOURCES.URL_BASENAME_GENERIC ? 'generic' : 'non-generic'})` })
  }
  return out
}

// ── URL basename (independent of filename-resolver.js for purity) ─────────

export function filenameBasename(url) {
  if (!url) return ''
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (!last) return ''
    let decoded = last
    try { decoded = decodeURIComponent(last) } catch { /* keep raw */ }
    return decoded.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 255)
  } catch {
    return ''
  }
}

// ── Score + select the best candidate ──────────────────────────────────────

function scoreCandidates(candidates) {
  return candidates
    .map((c) => ({ ...c, confidence: IDENTITY_SCORES[c.source] ?? 0 }))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      // Deterministic tie-break: keep the order from the input array (stable
      // sort). Sort is stable in V8 (Node 12+ and Chrome 70+).
      return 0
    })
}

function pickBest(scored) {
  if (scored.length === 0) {
    return { title: null, selectedSource: IDENTITY_SOURCES.FALLBACK, selectedConfidence: 0 }
  }
  return {
    title: scored[0].value,
    selectedSource: scored[0].source,
    selectedConfidence: scored[0].confidence,
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a MediaIdentity from collected metadata. The output is what the
 * filename resolver consumes, and what the popup / backend render.
 *
 * @param {object} input
 * @param {Array}  [input.jsonLd]        — output of parseJsonLdVideoObjects()
 * @param {Array}  [input.playerConfigs] — output of collectPlayerConfigs()
 * @param {Array}  [input.apiMetadata]   — output of collectApiMetadata()
 * @param {Array}  [input.videoElements] — output of collectDomMedia()
 * @param {object} [input.pageMetadata]  — { title, ogTitle, twitterTitle, mediaTitle, ... }
 * @param {string|null} [input.finalUrl]
 * @param {string|null} [input.requestUrl]
 * @param {string}      [input.type]     — 'hls' | 'dash' | 'video' | ...
 * @param {string|null} [input.quality]  — '1080p' etc.
 * @returns {object} MediaIdentity — see the plan.
 */
export function extractMediaIdentity(input = {}) {
  const jsonLd = input.jsonLd ?? []
  const playerConfigs = input.playerConfigs ?? []
  const apiMetadata = input.apiMetadata ?? []
  const videoElements = input.videoElements ?? []
  const pageMetadata = input.pageMetadata ?? null

  const candidates = [
    ...jsonLdCandidates(jsonLd),
    ...playerConfigCandidates(playerConfigs),
    ...apiMetadataCandidates(apiMetadata),
    ...domMediaCandidates(videoElements),
    ...pageMetadataCandidates(pageMetadata),
    ...urlBasenameCandidates([input.finalUrl, input.requestUrl]),
  ]

  const scored = scoreCandidates(candidates)
  const { title, selectedSource, selectedConfidence } = pickBest(scored)

  // Identity thumbnail cascade: JSON-LD → player → api → dom → pageMeta
  const jsonLdThumb = jsonLd.flatMap((v) => [v.thumbnailUrl, v.thumbnail, v.image]).find(Boolean) ?? null
  const thumbnail = firstThumbnail(
    Array.isArray(jsonLdThumb) ? jsonLdThumb[0] : jsonLdThumb,
    pageMetadata?.thumbnail,
    videoElements.find((v) => v.poster)?.poster ?? null,
  )

  // Identity duration cascade: JSON-LD (ISO 8601) → player → api → dom
  const jsonLdDuration = jsonLd.find((v) => v.duration)?.duration ?? null
  const apiDuration = apiMetadata.find((m) => m.durationSeconds)?.durationSeconds ?? null
  const domDuration = videoElements.find((v) => v.durationSeconds > 0)?.durationSeconds ?? null
  const duration = parseIso8601Duration(jsonLdDuration)
    ?? (Number.isFinite(apiDuration) ? Math.round(apiDuration) : null)
    ?? (Number.isFinite(domDuration) ? Math.round(domDuration) : null)
    ?? (Number.isFinite(pageMetadata?.duration) ? Math.round(pageMetadata.duration) : null)

  const resolution = firstString(pageMetadata?.resolution) ?? null
  const quality = firstString(input.quality, pageMetadata?.quality) ?? null

  return {
    title,
    sourceTitle: title,
    pageTitle: firstString(pageMetadata?.title) ?? null,
    mediaTitle: firstString(pageMetadata?.mediaTitle) ?? null,
    thumbnail: thumbnail ?? null,
    duration: duration ?? null,
    quality,
    resolution,
    type: input.type ?? null,
    identity: {
      title,
      headline: firstString(jsonLd.find((v) => v.headline)?.headline) ?? null,
      description: firstString(jsonLd.find((v) => v.description)?.description) ?? null,
      thumbnail: thumbnail ?? null,
      duration: duration ?? null,
      quality,
      resolution,
      type: input.type ?? null,
      candidates: scored,
      selectedSource,
      selectedConfidence,
    },
  }
}

/**
 * Convert a MediaIdentity into the legacy pageMetadata shape the existing
 * filename-resolver.js resolver still understands. The mediaTitle field is
 * set to the best identity title so the existing scoring chain (mediaTitle
 * → ogTitle → twitterTitle → pageTitle) keeps working unchanged.
 */
export function mediaIdentityToPageMetadata(identity) {
  if (!identity) return null
  return {
    title: identity.pageTitle ?? null,
    ogTitle: identity.identity?.candidates?.find((c) => c.source === IDENTITY_SOURCES.OG_TITLE)?.value ?? null,
    twitterTitle: identity.identity?.candidates?.find((c) => c.source === IDENTITY_SOURCES.TWITTER_TITLE)?.value ?? null,
    mediaTitle: identity.title ?? null,
    thumbnail: identity.thumbnail ?? null,
    duration: identity.duration ?? null,
    resolution: identity.resolution ?? null,
    quality: identity.quality ?? null,
  }
}

// ── Safe debug logger ──────────────────────────────────────────────────────
//
// Multi-line, opt-in via chrome.storage.local['9drive.debug'] === '1'. Never
// logs URLs with query strings, response bodies, request headers, cookies, or
// Authorization. The extension's background.js checks the flag and calls this.

export function formatDebugReport(identity, opts = {}) {
  const lines = []
  const id = identity?.identity ?? {}
  const tags = []
  if (opts.resourceType) tags.push(`resourceType=${opts.resourceType}`)
  if (opts.finalUrlHost) tags.push(`finalUrlHost=${opts.finalUrlHost}`)
  if (opts.quality) tags.push(`quality=${opts.quality}`)
  lines.push(`[media-identity-debug] ${tags.join(' ')}`)
  for (const c of id.candidates ?? []) {
    const padded = String(c.source).padEnd(30)
    const score = String(c.confidence).padStart(3)
    const value = c.value ? `"${c.value}"` : '<empty>'
    lines.push(`[media-identity-debug]   ${padded} score=${score}  value=${value}`)
  }
  if (id.selectedSource) {
    const filename = opts.filename ?? '<pending>'
    lines.push(`[media-identity-debug]   selected=${id.selectedSource} confidence=${id.selectedConfidence} filename="${filename}"`)
  }
  return lines.join('\n')
}
