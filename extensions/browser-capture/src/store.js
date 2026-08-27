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

export async function addCapture(entry) {
  const list = await allCaptures()
  if (list.some((c) => c.url === entry.url && c.status !== 'expired')) return null
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
  const pending = new Set(pendingUrls)
  const list = await allCaptures()
  const kept = list.filter(
    (c) => c.status !== 'submitted' || pending.has(c.url),
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
