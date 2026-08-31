/**
 * Metadata collectors — page-side DOM capture.
 *
 * Pure DOM work that runs in the content script. Collects:
 *   - JSON-LD (VideoObject) — from <script type="application/ld+json">
 *   - DOM media — <video>/<audio>/<source>/<track> title/aria/data-* attributes
 *   - Player configs — limited allowlist of window.* property names (shallow read)
 *   - API metadata — captured via wrapped window.fetch / XHR (allowlisted
 *     content-types, no header access, 8KB body cap, 50-entry FIFO)
 *
 * No chrome.* API calls in this file. The caller wires the results into
 * chrome.storage.session and chrome.runtime.sendMessage.
 *
 * SAFETY: the player-config + API allowlist is the only thing standing
 * between the extension and a hostile page. We never read cookie/auth/keys,
 * never serialize arbitrary objects, and never log full URLs.
 */

// ── JSON-LD collection ─────────────────────────────────────────────────────

const JSON_LD_SCRIPT_SELECTOR = 'script[type="application/ld+json"]'

/**
 * Returns an array of parsed JSON-LD objects, with malformed scripts silently
 * skipped. The caller (media-identity.js) walks each object for VideoObject
 * entries, including ones nested in `@graph` containers.
 */
export function collectJsonLdScripts() {
  const out = []
  const scripts = document.querySelectorAll(JSON_LD_SCRIPT_SELECTOR)
  for (const s of scripts) {
    const text = s.textContent
    if (!text) continue
    try {
      out.push(JSON.parse(text))
    } catch {
      // Malformed JSON-LD is common; skip silently.
    }
  }
  return out
}

// ── DOM media collection ───────────────────────────────────────────────────

/**
 * Walk every <video>/<audio>/<source>/<track> in the document. Returns a
 * per-element snapshot of identity-bearing attributes. The resolver only
 * needs the title-bearing fields, but width/height/duration flow through to
 * the thumbnail + quality cascade.
 */
export function collectDomMedia() {
  const out = []
  const mediaEls = document.querySelectorAll('video, audio')
  for (const el of mediaEls) {
    const tracks = []
    for (const t of el.querySelectorAll('track[label]')) {
      tracks.push({ label: t.getAttribute('label') })
    }
    out.push({
      title: el.getAttribute('title'),
      poster: el.getAttribute('poster'),
      src: el.getAttribute('src'),
      currentSrc: el.currentSrc || null,
      ariaLabel: el.getAttribute('aria-label'),
      dataTitle: el.getAttribute('data-title'),
      dataName: el.getAttribute('data-name'),
      width: el.videoWidth || 0,
      height: el.videoHeight || 0,
      durationSeconds: Number.isFinite(el.duration) ? el.duration : 0,
      tracks,
    })
  }
  return out
}

// ── Player config collection ───────────────────────────────────────────────
//
// Player configs live on the page's window object. We read a small allowlist
// of property names, and within each value we only extract the title/name/
// filename/streams URLs. We never read cookie/auth/keys, never serialize
// arbitrary objects, and never walk more than 4 levels deep.

const PLAYER_CONFIG_KEYS = [
  'playerConfig', 'videoConfig', 'mediaConfig', 'playbackConfig', 'VIDEO_CONFIG',
  'videoData', 'initialState', '__INITIAL_STATE__',
  '__NEXT_DATA__', '__NUXT__', 'nuxt',
  'shakaConfig', 'shakaPlayerConfig', 'dashjsConfig', 'hlsConfig',
  'videoJsConfig', 'videojs', 'videojsConfig',
  'jwConfig', 'jwplayerConfig', 'flowplayerConfig',
  'Plyr', 'plyrConfig',
]

const TITLE_KEYS = ['title', 'name', 'filename', 'mediaTitle', 'videoTitle', 'label', 'videoName', 'displayName']
const STREAM_TOP_KEYS = ['sources', 'streams', 'playlists', 'tracks', 'renditions', 'files', 'variants']
const STREAM_ITEM_KEYS = ['file', 'src', 'url', 'stream', 'file_path', 'path', 'hls_url', 'dash_url']

const MAX_STRING = 512
const MAX_DEPTH = 4

function safeString(value) {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const s = value
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (!s) return null
  return s.slice(0, MAX_STRING)
}

function walkShallow(value, depth = 0, into) {
  if (depth > MAX_DEPTH) return
  if (value == null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) {
      if (into.firstUrlFound) return
      walkShallow(item, depth + 1, into)
    }
    return
  }

  // Title/name keys at this level.
  for (const k of Object.keys(value)) {
    if (TITLE_KEYS.includes(k) && into.title == null) {
      const t = safeString(value[k])
      if (t) {
        into.title = t
        into.name = k
        break
      }
    }
  }

  // Stream keys at this level — record only the first URL to keep the payload
  // small. The URL itself is NEVER logged; we just record its presence + host.
  if (!into.firstUrlFound) {
    for (const sk of STREAM_TOP_KEYS) {
      const arr = value[sk]
      if (Array.isArray(arr) && arr.length > 0) {
        const first = arr[0]
        if (first && typeof first === 'object') {
          for (const ik of STREAM_ITEM_KEYS) {
            const u = first[ik]
            if (typeof u === 'string' && u.length > 0) {
              try {
                into.firstUrlHost = new URL(u, location.href).hostname
              } catch { /* ignore */ }
              into.firstUrlFound = true
              break
            }
          }
        }
        if (into.firstUrlFound) break
      }
    }
  }
}

/**
 * Read each allowlisted property off window. Returns an array of
 * { source, title, name, firstUrlHost } — one per property that exists and
 * yielded a title. Properties that don't expose a title are skipped.
 */
export function collectPlayerConfigs() {
  if (typeof window === 'undefined') return []
  const out = []
  for (const key of PLAYER_CONFIG_KEYS) {
    let value
    try { value = window[key] } catch { continue }
    if (value == null) continue

    const into = { title: null, name: null, firstUrlHost: null, firstUrlFound: false }
    walkShallow(value, 0, into)
    if (into.title) {
      out.push({ source: key, title: into.title, name: into.name, streamHost: into.firstUrlHost })
    }
  }
  return out
}

// ── API metadata capture (window.fetch / XMLHttpRequest) ───────────────────
//
// A wrapped fetch + XHR captures responses for a small allowlist of
// content-types, parses JSON bodies through the same allowlist as the player
// config walker, and stores at most 8KB of the body per URL in a 50-entry
// FIFO. The caller (e.g. the content script) drains the cache on a timer
// via collectApiMetadata().
//
// The wrapper is installed once via installApiCapture() and survives SPA
// navigation. The wrapper NEVER reads request headers (no cookie/auth), never
// calls response.clone() in a way that drains the body, and never logs
// bodies or full URLs.

const API_FETCH_LIMIT_BYTES = 8 * 1024
const API_CACHE_MAX = 50
const API_CONTENT_TYPE_ALLOWLIST = new Set([
  'application/json',
  'application/vnd.api+json',
  'application/ld+json',
  'application/vnd.apple.mpegurl',     // HLS — stream URL extraction only
  'application/dash+xml',              // DASH — stream URL extraction only
])

const TITLE_KEYS_API = ['title', 'name', 'filename', 'mediaTitle', 'videoTitle', 'label', 'videoName', 'displayName']
const STREAM_TOP_KEYS_API = ['sources', 'streams', 'playlists', 'tracks', 'renditions', 'files', 'variants', 'data', 'result', 'payload']
const STREAM_ITEM_KEYS_API = ['file', 'src', 'url', 'stream', 'file_path', 'path', 'hls_url', 'dash_url', 'manifest']

// In-memory caches, reset on install. We use a FIFO Map so the oldest entry
// is evicted when we exceed the cap.
const jsonCache = new Map()      // url → { title, name, streamHost, ct }
const pendingAdds = []            // ordered list of urls for FIFO eviction

function recordApiEntry(url, entry) {
  if (jsonCache.has(url)) {
    jsonCache.delete(url)
    const idx = pendingAdds.indexOf(url)
    if (idx >= 0) pendingAdds.splice(idx, 1)
  }
  jsonCache.set(url, entry)
  pendingAdds.push(url)
  while (pendingAdds.length > API_CACHE_MAX) {
    const evicted = pendingAdds.shift()
    jsonCache.delete(evicted)
  }
}

function readApiTitleFromJson(json) {
  if (json == null || typeof json !== 'object') return null
  for (const k of Object.keys(json)) {
    if (TITLE_KEYS_API.includes(k)) {
      const t = safeString(json[k])
      if (t) return { title: t, name: k }
    }
  }
  return null
}

function readApiStreamFromJson(json) {
  if (json == null || typeof json !== 'object') return null
  for (const sk of STREAM_TOP_KEYS_API) {
    const arr = json[sk]
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0]
      if (first && typeof first === 'object') {
        for (const ik of STREAM_ITEM_KEYS_API) {
          const u = first[ik]
          if (typeof u === 'string' && u.length > 0) {
            try { return { host: new URL(u, location.href).hostname } } catch { /* ignore */ }
          }
        }
      }
    }
  }
  return null
}

/**
 * Read up to `limit` bytes of `response`, decode as UTF-8, return the string.
 * Never throws. Returns '' on read error.
 */
async function readBoundedText(response, limit) {
  try {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let received = 0
    const chunks = []
    while (received < limit) {
      const { done, value } = await reader.read()
      if (done) break
      const slice = value.length > limit - received ? value.slice(0, limit - received) : value
      chunks.push(decoder.decode(slice, { stream: true }))
      received += slice.length
      if (received >= limit) {
        try { await reader.cancel() } catch { /* ignore */ }
        break
      }
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } catch {
    return ''
  }
}

function installFetchWrapper() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
  if (window.fetch.__nineDriveCapturePatched) return
  const originalFetch = window.fetch.bind(window)
  const wrapped = async function patchedFetch(input, init) {
    const response = await originalFetch(input, init)
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (!url || !/^https?:/i.test(url)) return response
      const ct = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim()
      if (!API_CONTENT_TYPE_ALLOWLIST.has(ct)) return response
      // For m3u8/mpd we just record the host (no body parse).
      if (ct === 'application/vnd.apple.mpegurl' || ct === 'application/dash+xml') {
        try {
          const host = new URL(url, location.href).hostname
          recordApiEntry(url, { source: 'fetch', contentType: ct, streamHost: host })
        } catch { /* ignore */ }
        return response
      }
      const text = await readBoundedText(response.clone(), API_FETCH_LIMIT_BYTES)
      try {
        const json = JSON.parse(text)
        const titleHit = readApiTitleFromJson(json)
        const streamHit = readApiStreamFromJson(json)
        if (titleHit || streamHit) {
          recordApiEntry(url, {
            source: 'fetch',
            contentType: ct,
            title: titleHit?.title ?? null,
            name: titleHit?.name ?? null,
            streamHost: streamHit?.host ?? null,
          })
        }
      } catch {
        // Not JSON or malformed — ignore.
      }
    } catch {
      // Never let the wrapper break the page's fetch.
    }
    return response
  }
  wrapped.__nineDriveCapturePatched = true
  window.fetch = wrapped
}

function installXhrWrapper() {
  if (typeof window === 'undefined' || typeof window.XMLHttpRequest !== 'function') return
  if (window.XMLHttpRequest.prototype.__nineDriveCapturePatched) return
  const proto = window.XMLHttpRequest.prototype
  const originalOpen = proto.open
  const originalSend = proto.send

  proto.open = function patchedOpen(method, url, ...rest) {
    this.__nineDriveUrl = typeof url === 'string' ? url : ''
    return originalOpen.call(this, method, url, ...rest)
  }
  proto.send = function patchedSend(...args) {
    this.addEventListener('readystatechange', function () {
      if (this.readyState !== 4) return
      try {
        const url = this.__nineDriveUrl
        if (!url || !/^https?:/i.test(url)) return
        const ct = (this.getResponseHeader('content-type') || '').toLowerCase().split(';')[0].trim()
        if (!API_CONTENT_TYPE_ALLOWLIST.has(ct)) return
        if (ct === 'application/vnd.apple.mpegurl' || ct === 'application/dash+xml') {
          try {
            const host = new URL(url, location.href).hostname
            recordApiEntry(url, { source: 'xhr', contentType: ct, streamHost: host })
          } catch { /* ignore */ }
          return
        }
        const text = String(this.responseText ?? '').slice(0, API_FETCH_LIMIT_BYTES)
        try {
          const json = JSON.parse(text)
          const titleHit = readApiTitleFromJson(json)
          const streamHit = readApiStreamFromJson(json)
          if (titleHit || streamHit) {
            recordApiEntry(url, {
              source: 'xhr',
              contentType: ct,
              title: titleHit?.title ?? null,
              name: titleHit?.name ?? null,
              streamHost: streamHit?.host ?? null,
            })
          }
        } catch { /* ignore */ }
      } catch { /* never break the page's XHR */ }
    })
    return originalSend.apply(this, args)
  }
  proto.__nineDriveCapturePatched = true
}

/** Install both wrappers. Idempotent. Call once on content-script load. */
export function installApiCapture() {
  installFetchWrapper()
  installXhrWrapper()
}

/**
 * Drain the cache and return an array of { source, url, title, name,
 * streamHost, contentType }. The caller can use the URL host (never the path
 * or query string) to correlate with the page that triggered the request.
 * The cache is cleared on read.
 */
export function collectApiMetadata() {
  const out = []
  for (const [url, entry] of jsonCache) {
    let host = ''
    try { host = new URL(url, location.href).hostname } catch { /* ignore */ }
    out.push({
      source: entry.source,
      urlHost: host,
      title: entry.title ?? null,
      name: entry.name ?? null,
      streamHost: entry.streamHost ?? null,
      contentType: entry.contentType ?? null,
    })
  }
  jsonCache.clear()
  pendingAdds.length = 0
  return out
}

// ── Convenience collector used by the content script ──────────────────────

/**
 * Run all collectors in a single pass. The content script calls this on
 * page load, on loadedmetadata, and after the debounced MutationObserver.
 */
export function collectAllMetadata() {
  return {
    jsonLd: collectJsonLdScripts(),
    videoElements: collectDomMedia(),
    playerConfigs: collectPlayerConfigs(),
    apiMetadata: collectApiMetadata(),
  }
}
