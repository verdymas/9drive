/**
 * 9Drive Browser Capture — content script.
 *
 * The MV3 service worker has no DOM access, so page metadata that can improve
 * filename detection (document.title, og:title, twitter:title, media titles,
 * and `<a download>` filenames) is collected here and stashed in
 * chrome.storage.session (in-memory, shared with the service worker, no extra
 * permissions). The service worker looks the values up by page URL when it
 * detects a resource.
 *
 * Everything collected is public page data — never cookies, tokens, or bodies.
 */

const PAGE_KEY_PREFIX = 'pageMetadata:'
const DL_KEY_PREFIX = 'downloadAttr:'

function stripQuery(url) {
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    return u.href
  } catch {
    return url
  }
}

/** Human-readable quality label from a pixel height (mirrors quality-utils). */
function qualityFromHeight(height) {
  if (!(height > 0)) return null
  if (height >= 2160) return '4K'
  if (height >= 1440) return '1440p'
  if (height >= 1080) return '1080p'
  if (height >= 720) return '720p'
  if (height >= 480) return '480p'
  if (height >= 360) return '360p'
  if (height >= 240) return '240p'
  return `${height}p`
}

/** Absolute form of a possibly-relative image URL, or null. */
function absoluteImageUrl(value) {
  const raw = value?.trim()
  if (!raw || raw.startsWith('data:image/gif')) return null
  try {
    return new URL(raw, location.href).href
  } catch {
    return null
  }
}

function collectPageMetadata() {
  const meta = {
    title: null, ogTitle: null, twitterTitle: null, mediaTitle: null,
    thumbnail: null, duration: null, resolution: null, quality: null,
  }
  const titleEl = document.querySelector('title')
  if (titleEl?.textContent?.trim()) meta.title = titleEl.textContent.trim().slice(0, 512)

  const og = document.querySelector('meta[property="og:title"]')
  if (og?.content?.trim()) meta.ogTitle = og.content.trim().slice(0, 512)

  const tw = document.querySelector('meta[name="twitter:title"]')
  if (tw?.content?.trim()) meta.twitterTitle = tw.content.trim().slice(0, 512)

  // Media element with an explicit title attribute (player-provided).
  const titled = document.querySelector('video[title], audio[title]')
  if (titled?.title?.trim()) meta.mediaTitle = titled.title.trim().slice(0, 512)

  // ── Thumbnail cascade (og:image → twitter:image → video poster → img) ─────
  const ogImg = document.querySelector('meta[property="og:image"], meta[property="og:image:secure_url"]')
  const twImg = document.querySelector('meta[name="twitter:image"], meta[name="twitter:image:src"], meta[property="twitter:image"]')
  const posterVideo = document.querySelector('video[poster]')
  const posterImg = document.querySelector('img[class*="poster" i], img[class*="preview" i], img[class*="thumb" i], img[alt*="poster" i]')
  meta.thumbnail =
    absoluteImageUrl(ogImg?.content) ||
    absoluteImageUrl(twImg?.content) ||
    absoluteImageUrl(posterVideo?.getAttribute('poster')) ||
    absoluteImageUrl(posterImg instanceof HTMLImageElement ? (posterImg.currentSrc || posterImg.getAttribute('src') || posterImg.getAttribute('data-src')) : null)

  // ── Duration + resolution from the playing media element ──────────────────
  const video = document.querySelector('video')
  if (video) {
    if (Number.isFinite(video.duration) && video.duration > 0) meta.duration = Math.round(video.duration)
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw > 0 && vh > 0) {
      meta.resolution = `${vw}x${vh}`
      meta.quality = qualityFromHeight(vh)
    }
  }

  return meta
}

async function stashPageMetadata() {
  try {
    const key = PAGE_KEY_PREFIX + stripQuery(location.href)
    const meta = collectPageMetadata()
    await chrome.storage.session.set({ [key]: meta })
    // Push to the SW so a cold-started service worker that detected the
    // resource before the first storage write can re-resolve the filename
    // using the now-fresh metadata. Safe: never carries cookies/Authorization.
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_METADATA_PUSH', pageUrl: location.href, metadata: meta }, () => {
        void chrome.runtime.lastError
      })
    } catch {
      /* extension context invalidated — re-resolve on next popup open */
    }
  } catch {
    /* storage.session unavailable — metadata simply won't be used */
  }
}

function absoluteUrl(href) {
  try {
    return new URL(href, location.href).href
  } catch {
    return null
  }
}

// ── Media Identity (Phase 14) ──────────────────────────────────────────────
//
// Dynamic-imported so the content script can stay as a plain non-module script
// (matches the existing manifest.json). The install + first collection kick
// off as soon as the page is interactive; the result is pushed to the SW
// exactly like the existing PAGE_METADATA_PUSH.

let _identityModules = null
async function loadIdentityModules() {
  if (_identityModules) return _identityModules
  const [collectors, identity] = await Promise.all([
    import('./metadata-collectors.js'),
    import('./media-identity.js'),
  ])
  _identityModules = { ...collectors, ...identity }
  return _identityModules
}

let _apiCaptureInstalled = false
async function ensureApiCapture() {
  if (_apiCaptureInstalled) return
  const m = await loadIdentityModules()
  try { m.installApiCapture() } catch { /* never break the page */ }
  _apiCaptureInstalled = true
}

const IDENTITY_KEY_PREFIX = 'mediaIdentity:'

/**
 * Run all metadata collectors + identity scoring, stash the union into
 * chrome.storage.session under mediaIdentity:<pageUrl>, and push to the SW.
 * Called on initial load, on loadedmetadata, on the deferred timeouts, and
 * from the MutationObserver.
 */
async function stashMediaIdentity() {
  try {
    const m = await loadIdentityModules()
    await ensureApiCapture()
    const collected = m.collectAllMetadata()
    const baseMeta = collectPageMetadata()
    const ogVideoTitle = document.querySelector('meta[property="og:video:title"]')?.getAttribute('content') || null
    const itempropName = document.querySelector('meta[itemprop="name"]')?.getAttribute('content') || null
    const identity = m.extractMediaIdentity({
      jsonLd: collected.jsonLd,
      playerConfigs: collected.playerConfigs,
      apiMetadata: collected.apiMetadata,
      videoElements: collected.videoElements,
      pageMetadata: { ...baseMeta, ogVideoTitle, itempropName },
      finalUrl: location.href,
      requestUrl: location.href,
      type: null,
      quality: baseMeta?.quality ?? null,
    })
    const key = IDENTITY_KEY_PREFIX + stripQuery(location.href)
    const payload = {
      identity,
      baseMeta,
      ogVideoTitle,
      itempropName,
      collectedAt: Date.now(),
    }
    await chrome.storage.session.set({ [key]: payload })
    try {
      chrome.runtime.sendMessage({ type: 'MEDIA_IDENTITY_PUSH', pageUrl: location.href, payload }, () => {
        void chrome.runtime.lastError
      })
    } catch {
      /* extension context invalidated — re-resolve on next popup open */
    }
    // Also refresh the legacy pageMetadata stash so the existing SW flow
    // (which still uses the pageMetadata shape) gets the richer mediaTitle.
    const enrichedLegacy = m.mediaIdentityToPageMetadata(identity)
    if (enrichedLegacy) {
      const pageKey = PAGE_KEY_PREFIX + stripQuery(location.href)
      try {
        await chrome.storage.session.set({ [pageKey]: enrichedLegacy })
      } catch { /* ignore */ }
    }
  } catch {
    /* metadata identity is best-effort; never block the legacy path */
  }
}

function scheduleMediaIdentityCollection(delayMs = 0) {
  if (delayMs <= 0) { void stashMediaIdentity(); return }
  setTimeout(() => { void stashMediaIdentity() }, delayMs)
}

/** Stash every `<a download>` filename, keyed by its absolute URL. */
async function stashDownloadAttrs() {
  try {
    const writes = {}
    for (const a of document.querySelectorAll('a[download]')) {
      const href = absoluteUrl(a.href || a.getAttribute('href'))
      const name = (a.getAttribute('download') || '').trim()
      if (href && name) writes[DL_KEY_PREFIX + href] = name
    }
    if (Object.keys(writes).length > 0) await chrome.storage.session.set(writes)
  } catch {
    /* ignore */
  }
}

stashPageMetadata()
stashDownloadAttrs()

// Phase 14: kick the richer identity collection on the same triggers, plus a
// few new ones (window load, 2s + 5s timeouts for SPAs that hydrate after
// first paint, head/body mutation observer for late JSON-LD + <video>).
scheduleMediaIdentityCollection(0)
if (document.readyState !== 'complete') {
  window.addEventListener('load', () => scheduleMediaIdentityCollection(0), { once: true })
}
scheduleMediaIdentityCollection(2000)
scheduleMediaIdentityCollection(5000)

try {
  const debouncedIdentity = (() => {
    let t = null
    return () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => { t = null; scheduleMediaIdentityCollection(0) }, 250)
    }
  })()
  const headObserver = new MutationObserver(debouncedIdentity)
  if (document.head) headObserver.observe(document.head, { childList: true, subtree: true })
  const bodyObserver = new MutationObserver(debouncedIdentity)
  if (document.body) bodyObserver.observe(document.body, { childList: true, subtree: true })
} catch {
  /* MutationObserver unavailable on this page */
}

// SPA players insert <video> after load — re-stash once it has real metadata
// (duration/resolution become available after loadedmetadata).
document.addEventListener('loadedmetadata', (e) => {
  if (e.target instanceof HTMLVideoElement || e.target instanceof HTMLAudioElement) {
    void stashPageMetadata()
    scheduleMediaIdentityCollection(0)
  }
}, true)

// Catch dynamically-created download links on click.
document.addEventListener(
  'click',
  (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[download]') : null
    if (!a) return
    const href = absoluteUrl(a.href || a.getAttribute('href'))
    const name = (a.getAttribute('download') || '').trim()
    if (href && name) {
      try {
        void chrome.storage.session.set({ [DL_KEY_PREFIX + href]: name })
      } catch {
        /* ignore */
      }
    }
  },
  true,
)
