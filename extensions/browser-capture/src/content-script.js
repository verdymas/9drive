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

function collectPageMetadata() {
  const meta = { title: null, ogTitle: null, twitterTitle: null, mediaTitle: null }
  const titleEl = document.querySelector('title')
  if (titleEl?.textContent?.trim()) meta.title = titleEl.textContent.trim().slice(0, 512)

  const og = document.querySelector('meta[property="og:title"]')
  if (og?.content?.trim()) meta.ogTitle = og.content.trim().slice(0, 512)

  const tw = document.querySelector('meta[name="twitter:title"]')
  if (tw?.content?.trim()) meta.twitterTitle = tw.content.trim().slice(0, 512)

  // Media element with an explicit title attribute (player-provided).
  const video = document.querySelector('video[title], audio[title]')
  if (video?.title?.trim()) meta.mediaTitle = video.title.trim().slice(0, 512)

  return meta
}

async function stashPageMetadata() {
  try {
    const key = PAGE_KEY_PREFIX + stripQuery(location.href)
    await chrome.storage.session.set({ [key]: collectPageMetadata() })
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
