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

// SPA players insert <video> after load — re-stash once it has real metadata
// (duration/resolution become available after loadedmetadata).
document.addEventListener('loadedmetadata', (e) => {
  if (e.target instanceof HTMLVideoElement || e.target instanceof HTMLAudioElement) {
    void stashPageMetadata()
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
