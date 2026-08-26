/**
 * Local capture store (chrome.storage.local). Each pending capture:
 *   { id, url, type, mime, pageUrl, pageTitle, filename, status, ts }
 * status: detected | submitted  (selected is transient UI state; expired/
 * consumed live server-side and are pruned on sync).
 */

const KEY = '9drive.captures'
const MAX_CAPTURES = 200

export async function allCaptures() {
  const obj = await chrome.storage.local.get(KEY)
  return obj[KEY] ?? []
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
