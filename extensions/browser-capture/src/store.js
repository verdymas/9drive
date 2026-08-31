/**
 * Local capture store (chrome.storage.local). Each pending capture:
 *   { id, url, type, mime, pageUrl, pageTitle, filename, status, ts }
 *
 * Status taxonomy:
 *   detected  — local capture, not yet synced to server   → counted by badge
 *   pending   — synced to server, awaiting import         → counted by badge
 *   submitted — import was created                        → not counted
 *   imported  — import completed                          → not counted
 *   removed   — user deleted                              → not counted
 *   expired   — TTL exceeded                              → not counted
 *
 * Badge and popup MUST both derive their count from `countPending()` —
 * the single source of truth for "how many resources are actionable."
 */

const KEY = '9drive.captures'
const MAX_CAPTURES = 200

/** Logical identity of a capture URL: query/hash stripped (signed params). */
export function displayUrlOf(url) {
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    return u.href
  } catch {
    return url
  }
}

/**
 * True when an incoming candidate is strictly weaker than what is already on
 * the card and must NOT replace it. "Weaker" means: null/undefined/empty, or a
 * generic/technical basename (master/index/1080/...) when the existing name
 * is meaningful. This protects the merge from regressing to a manifest
 * basename on a cold-SW detection.
 */
function isWeakerFilename(incoming, existing) {
  if (incoming == null || incoming === '') return true
  if (existing == null || existing === '') return false
  if (incoming === existing) return false
  return isGenericStem(stemOf(incoming).toLowerCase())
    && !isGenericStem(stemOf(existing).toLowerCase())
}

function stemOf(name) {
  return String(name).replace(/\.[^.]+$/, '').split('/').pop() ?? ''
}

const GENERIC_FILENAMES = new Set([
  // Original transport stems
  'index', 'playlist', 'master', 'manifest', 'stream', 'video', 'media',
  'file', 'download', 'chunk', 'segment', 'chunklist', 'variant',
  'prog_index', 'main', 'source', 'output', '1080', '720', '480', '360',
  // Quality stems with the p suffix
  '1080p', '720p', '480p', '360p', '240p', '144p', '4k', '2k', '8k',
  // Phase 14: media-related stems that carry no real identity
  'movie', 'clip', 'sample', 'trailer', 'preview', 'teaser', 'intro',
  'outro', 'recap', 'feature', 'bonus', 'extra', 'deleted',
  'ep', 'episode', 'part', 'scene', 'cut', 'version', 'final',
  // Short single/two-letter stems (Vimeo/YouTube/archive paths)
  'v', 'm', 'a', 's', 'p', 'f', 'd', 't', 'x',
  // CDN-tree patterns
  'vod', 'live', 'dash', 'hls', 'cdn', 'edge', 'origin', 'static',
])

/** Bare-numeric / short alphanumeric stems (Vimeo-style IDs). */
const GENERIC_STEM_PATTERN = /^(?:v\d+|[a-z]?\d{1,4})$/i

function isGenericStem(stem) {
  if (!stem) return true
  if (GENERIC_FILENAMES.has(stem)) return true
  if (GENERIC_STEM_PATTERN.test(stem)) return true
  return false
}

export async function allCaptures() {
  const obj = await chrome.storage.local.get(KEY)
  const list = obj[KEY] ?? []
  console.debug(`[store] allCaptures: ${list.length} total, statuses=[${[...new Set(list.map((c) => c.status))].join(',')}]`)
  return list
}

export async function saveCaptures(list) {
  // FIFO bound so a long session cannot grow unbounded.
  await chrome.storage.local.set({ [KEY]: list.slice(-MAX_CAPTURES) })
}

/**
 * Add a detected resource. Dedupe key = display URL (query/hash stripped) +
 * type, so re-detections with rotated signed query strings refresh the SAME
 * card instead of piling up duplicates.
 *
 *  - existing detected/pending row  → refreshed in place (new signed URL,
 *    fresher metadata); user custom filename and remoteId are preserved.
 *  - existing submitted/imported row → skipped. A consumed capture must not
 *    silently reappear just because the page still references the resource
 *    (even with a rotated signed URL).
 *  - existing removed/expired row   → a new card is created (fresh event).
 */
export async function addCapture(entry) {
  const list = await allCaptures()
  entry.displayUrl = entry.displayUrl || displayUrlOf(entry.url)
  const existing = list.find((c) => c.displayUrl === entry.displayUrl && c.type === entry.type)
  if (existing) {
    if (existing.status === 'detected' || existing.status === 'pending') {
      // A user-edited customFilename is permanent: it blocks ALL automatic
      // updates (suggested filename, filenameSource, page metadata, even the
      // url — only the literal signed URL is refreshed). Everything else
      // follows the same rule: a re-detection that brings a fresher filename
      // upgrades filename+filenameSource together; a re-detection with a
      // null/weaker filename (typical when the SW is cold-started before
      // page metadata) NEVER erases a better value already on the card.
      const customLocked = existing.customFilename != null
      const filenameUpgraded = !isWeakerFilename(entry.filename, existing.filename)
      Object.assign(existing, {
        url: entry.url,
        displayUrl: entry.displayUrl,
        type: entry.type,
        mime: entry.mime ?? existing.mime,
        filename: customLocked
          ? existing.filename
          : (filenameUpgraded ? (entry.filename ?? existing.filename) : existing.filename),
        filenameSource: customLocked
          ? existing.filenameSource
          : (filenameUpgraded
              ? (entry.filenameSource ?? existing.filenameSource)
              : existing.filenameSource),
        pageUrl: entry.pageUrl ?? existing.pageUrl,
        pageMetadata: customLocked
          ? existing.pageMetadata
          : (entry.pageMetadata ?? existing.pageMetadata),
        estimatedSize: entry.estimatedSize ?? existing.estimatedSize,
        sizeSource: entry.sizeSource ?? existing.sizeSource,
        quality: customLocked
          ? existing.quality
          : (entry.quality ?? existing.quality),
        thumbnail: customLocked
          ? existing.thumbnail
          : (entry.thumbnail ?? existing.thumbnail),
        duration: customLocked
          ? existing.duration
          : (entry.duration ?? existing.duration),
        ts: Date.now(),
      })
      await saveCaptures(list)
      return existing
    }
    if (existing.status === 'submitted' || existing.status === 'imported') return null
  }
  entry.id = crypto.randomUUID()
  entry.status = 'detected'
  entry.ts = Date.now()
  list.push(entry)
  await saveCaptures(list)
  return entry
}

export async function removeCapture(id) {
  const list = (await allCaptures()).filter((c) => c.id !== id)
  await saveCaptures(list)
}

/** Remove every local capture (including submitted/consumed/expired). */
export async function clearAllCaptures() {
  await chrome.storage.local.set({ [KEY]: [] })
}

export async function updateCapture(id, patch) {
  const list = await allCaptures()
  const row = list.find((c) => c.id === id)
  if (row) Object.assign(row, patch)
  await saveCaptures(list)
  return row
}

/** Drop captures the server no longer reports as pending (consumed/expired/deleted). */
export async function pruneAgainstServer(pendingUrls) {
  const pending = new Set((pendingUrls ?? []).map((u) => displayUrlOf(u)))
  const list = await allCaptures()
  const kept = list.filter(
    (c) => c.status !== 'submitted' || pending.has(c.displayUrl || displayUrlOf(c.url)),
  )
  await saveCaptures(kept)
  return kept
}

/**
 * Canonical pending count — used by both badge and popup.
 * Returns the number of captures with actionable status.
 */
export async function countPending() {
  const list = await allCaptures()
  return list.filter((c) => c.status === 'detected' || c.status === 'pending').length
}
