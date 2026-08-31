/**
 * 9Drive Browser Capture — MV3 service worker.
 *
 * Detects media/document resources via chrome.webRequest (observational only —
 * it never reads bodies or cookies), classifies them with classify.js, keeps a
 * local pending list + badge, and syncs detections to the 9Drive backend.
 * The extension NEVER downloads file bytes; import goes through the backend's
 * Remote Import pipeline.
 */
import { classifyResource, displayTypeFor, extractQuality, filenameFromUrl } from './classify.js'
import { resolveFilename, parseContentDispositionFilename } from './filename-resolver.js'
import { addCapture, allCaptures, clearAllCaptures, countPending, displayUrlOf, pruneAgainstServer, removeCapture, saveCaptures, updateCapture } from './store.js'
import { getConfig, heartbeat, submitResource, deleteServerResource, setConfig, resolveApiRoot, requestTo } from './api.js'

const EXT_VERSION = chrome.runtime.getManifest().version

// ── Redirect tracking ────────────────────────────────────────────────────────
// Map requestId → original URL (before redirects). onHeadersReceived fires with
// the FINAL URL after redirects, so the original is captured here to derive a
// better filename. In-memory: cleared on service-worker restart (acceptable —
// details.url remains the primary source).

const requestOrigins = new Map()

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== 'media' && details.type !== 'xmlhttprequest' && details.type !== 'object' && details.type !== 'other') return
    requestOrigins.set(details.requestId, { originalUrl: details.url, ts: Date.now() })
    if (requestOrigins.size > 500) {
      const cutoff = Date.now() - 60_000
      for (const [id, e] of requestOrigins) { if (e.ts < cutoff) requestOrigins.delete(id) }
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
)

// ── Context menu (Phase 06) ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: '9drive-root', title: '9Drive', contexts: ['link'] })
  chrome.contextMenus.create({
    id: '9drive-import-link',
    parentId: '9drive-root',
    title: 'Import this link',
    contexts: ['link'],
  })
  chrome.contextMenus.create({
    id: '9drive-open-popup',
    parentId: '9drive-root',
    title: 'Open 9Drive Capture',
    contexts: ['page'],
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === '9drive-import-link' && info.linkUrl) {
    const cls = classifyResource(info.linkUrl, null)
    if (!cls || cls.sub === 'segment') return // unsupported link — ignore silently
    const cfg = await getConfig()
    const result = resolveFilename({ requestUrl: info.linkUrl, finalUrl: info.linkUrl })
    const detectedName = result.filename
    const entry = {
      url: info.linkUrl,
      type: cls.type,
      displayType: displayTypeFor(cls.type, null),
      mime: null,
      pageUrl: info.pageUrl ?? tab?.url ?? null,
      filename: detectedName,
      filenameSource: result.source,
      estimatedSize: null,
      sizeSource: null,
      quality: extractQuality(detectedName),
      customFilename: null,
      status: 'detected',
      ts: Date.now(),
    }
    await addCapture(entry)
    await updateBadge()
    if (cfg.baseUrl && cfg.deviceToken) void syncCapture(entry, {})
  }
  // '9drive-open-popup' cannot programmatically open the popup; it opens the
  // dashboard's Remote Imports page instead.
  if (info.menuItemId === '9drive-open-popup') {
    const cfg = await getConfig()
    if (cfg.baseUrl) chrome.tabs.create({ url: `${cfg.baseUrl.replace(/\/$/, '')}/remote-imports` })
  }
})

// ── Detection ───────────────────────────────────────────────────────────────

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.type !== 'media' && details.type !== 'xmlhttprequest' && details.type !== 'object' && details.type !== 'other') return
    const headers = new Map((details.responseHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value]))
    const mimeHeader = headers.get('content-type')
    const cls = classifyResource(details.url, mimeHeader)
    // Segments/variants are suppressed: manifests represent the whole asset.
    if (!cls || cls.sub === 'segment') return

    const cfg = await getConfig()
    if (!cfg.baseUrl || !cfg.deviceToken) return // not connected → skip silently

    const pageUrl = details.originUrl ?? details.initiator ?? null
    // Safe request context only (spec Phase 04): the referrer page as Referer
    // and its origin. Cookie/Authorization are NEVER read — webRequest only
    // exposes them with the (undeclared here) extra permission, and the
    // backend's strict schema would reject them anyway.
    const safeContext = {}
    if (pageUrl) {
      try {
        const p = new URL(pageUrl)
        if (p.protocol === 'http:' || p.protocol === 'https:') {
          safeContext.referer = p.href
          safeContext.origin = `${p.protocol}//${p.host}`
        }
      } catch { /* non-http initiator */ }
    }
    const contentLength = headers.get('content-length')
    const size = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null
    const finalUrl = details.url

    // Page metadata + download attribute collected by the content script.
    let pageMetadata = null
    let downloadAttr = null
    if (pageUrl) {
      try {
        const p = new URL(pageUrl)
        if (p.protocol === 'http:' || p.protocol === 'https:') {
          const metaKey = `pageMetadata:${p.origin}${p.pathname}`
          const sessionData = await chrome.storage.session.get(metaKey)
          pageMetadata = sessionData[metaKey] ?? null
        }
      } catch { /* non-http initiator */ }
    }
    if (pageMetadata) {
      try {
        const dlKey = `downloadAttr:${finalUrl}`
        const dlData = await chrome.storage.session.get(dlKey)
        downloadAttr = dlData[dlKey] ?? null
      } catch { /* ignore */ }
    }

    const originEntry = requestOrigins.get(details.requestId)
    const originalUrl = originEntry?.originalUrl || finalUrl

    // Quality hint: the media element's real resolution (content script) beats
    // a number scraped from the URL basename.
    const quality = pageMetadata?.quality || extractQuality(filenameFromUrl(finalUrl))

    const result = resolveFilename({
      requestUrl: originalUrl,
      finalUrl,
      contentDisposition: headers.get('content-disposition'),
      downloadAttr,
      pageMetadata,
      type: cls.type,
      quality,
    })

    // Forensic-acceptance debug summary: which metadata source won, with safe
    // fields only (no URLs, cookies, Authorization, signed query values, or
    // tokens). One line per detected resource, easy to grep.
    const cdHeader = headers.get('content-disposition')
    const cdValue = parseContentDispositionFilename(cdHeader ?? null)
    console.debug(
      `[capture:filename-debug]`
        + ` resourceType=${cls.type}`
        + ` requestBasename=${filenameFromUrl(originalUrl) || '<none>'}`
        + ` finalBasename=${filenameFromUrl(finalUrl) || '<none>'}`
        + ` contentDispositionFilename=${cdValue || 'null'}`
        + ` downloadAttribute=${downloadAttr ? 'set' : 'null'}`
        + ` mediaTitle="${pageMetadata?.mediaTitle ?? ''}"`
        + ` ogTitle="${pageMetadata?.ogTitle ?? ''}"`
        + ` twitterTitle="${pageMetadata?.twitterTitle ?? ''}"`
        + ` pageTitle="${pageMetadata?.title ?? ''}"`
        + ` quality=${quality ?? ''}`
        + ` selectedSource=${result.source}`
        + ` selectedFilename=${result.filename}`,
    )

    const entry = {
      url: finalUrl,
      originalUrl,
      finalUrl,
      type: cls.type,
      displayType: displayTypeFor(cls.type, mimeHeader),
      mime: mimeHeader ?? null,
      pageUrl,
      filename: result.filename,
      filenameSource: result.source,
      pageMetadata,
      estimatedSize: size,
      sizeSource: size != null ? 'content-length' : null,
      quality,
      thumbnail: pageMetadata?.thumbnail ?? null,
      duration: pageMetadata?.duration ?? null,
      customFilename: null,
      status: 'detected',
      ts: Date.now(),
    }
    const added = await addCapture(entry)
    if (added) {
      console.debug(`[capture] resource_saved id=${added.id} type=${added.type} status=${added.status}`)
      await updateBadge()
    }
    void syncCapture(entry, safeContext)
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders'],
)

// ── Late metadata merge (root-cause fix for the timing race) ────────────────
// A cold-started service worker on an autoplay page can fire onHeadersReceived
// before the content script's storage.session stash is written. MediaGrabber
// avoids this by *pushing* PAGE_METADATA messages and merging into already-
// detected media; 9Drive re-runs the resolver when a page publishes a fresh
// metadata stash (e.g. from `loadedmetadata`, SPA navigation, or a
// `PAGE_METADATA` push). `customFilename` is permanent — automatic refreshes
// never overwrite it. Existing meaningful values are preserved; a later event
// that fills in a previously-null field upgrades the suggested filename in
// place, then the badge is updated so the popup reflects it immediately.
async function recheckPendingCaptures(pageUrl) {
  let p
  try { p = new URL(pageUrl); if (p.protocol !== 'http:' && p.protocol !== 'https:') return } catch { return }
  const metaKey = `pageMetadata:${p.origin}${p.pathname}`
  const session = await chrome.storage.session.get([metaKey]).catch(() => ({}))
  const meta = session[metaKey]
  if (!meta) return

  const list = await allCaptures()
  let changed = false
  for (const row of list) {
    if (row.status !== 'detected' && row.status !== 'pending') continue
    if (!row.pageUrl) continue
    let rowOrigin
    try { rowOrigin = new URL(row.pageUrl) } catch { continue }
    if (rowOrigin.origin !== p.origin || rowOrigin.pathname !== p.pathname) continue

    // Skip rows the user has already edited — `customFilename` is permanent.
    if (row.customFilename) continue

    // Merge: existing meaningful value wins over null/undefined/empty.
    const mergedMeta = mergeMetadata(row.pageMetadata, meta)
    const better = isRicherMetadata(mergedMeta, row.pageMetadata)
    if (!better) continue

    const result = resolveFilename({
      requestUrl: row.originalUrl ?? row.url,
      finalUrl: row.finalUrl ?? row.url,
      contentDisposition: row.contentDisposition ?? null,
      downloadAttr: row.downloadAttr ?? null,
      pageMetadata: mergedMeta,
      type: row.type,
      quality: mergedMeta.quality ?? extractQuality(filenameFromUrl(row.url)),
    })
    if (result.filename === row.filename) {
      row.pageMetadata = mergedMeta
      row.thumbnail = mergedMeta.thumbnail ?? row.thumbnail
      row.duration = mergedMeta.duration ?? row.duration
      row.quality = mergedMeta.quality ?? row.quality
      changed = true
      continue
    }
    Object.assign(row, {
      filename: result.filename,
      filenameSource: result.source,
      pageMetadata: mergedMeta,
      thumbnail: mergedMeta.thumbnail ?? row.thumbnail,
      duration: mergedMeta.duration ?? row.duration,
      quality: mergedMeta.quality ?? row.quality,
      ts: Date.now(),
    })
    changed = true
  }
  if (changed) {
    await saveCaptures(list)
    await updateBadge()
  }
}

/** Field-by-field merge that keeps the existing value when it's already meaningful. */
function mergeMetadata(prev, next) {
  if (!next) return prev ?? null
  if (!prev) return next
  const out = { ...prev }
  for (const k of ['title', 'ogTitle', 'twitterTitle', 'mediaTitle', 'thumbnail', 'duration', 'resolution', 'quality']) {
    const incoming = next[k]
    if (incoming == null || incoming === '') continue
    if (out[k] == null || out[k] === '' || isGenericString(out[k])) out[k] = incoming
  }
  return out
}

function isGenericString(value) {
  if (typeof value !== 'string') return false
  return /^(index|playlist|master|manifest|stream|video|media|chunklist|variant|chunk|segment|file|download)\b/i.test(value.trim())
}

/** True when `next` brings at least one field of higher signal than `prev`. */
function isRicherMetadata(next, prev) {
  if (!next) return false
  if (!prev) return true
  for (const k of ['title', 'ogTitle', 'twitterTitle', 'mediaTitle', 'thumbnail', 'duration', 'resolution', 'quality']) {
    const before = prev[k]
    const after = next[k]
    if (after == null || after === '') continue
    if (before == null || before === '' || isGenericString(before)) return true
  }
  return false
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Content-script push of PAGE_METADATA — runs the late re-resolution so the
  // popup filename reflects the best available title even when the SW was
  // cold-started before the content script's first storage.session write.
  if (msg?.type === 'PAGE_METADATA_PUSH' && typeof msg.pageUrl === 'string') {
    void recheckPendingCaptures(msg.pageUrl)
    sendResponse?.({ ok: true })
    return false
  }
})

async function syncCapture(entry, safeContext = {}) {
  try {
    const serverRow = await submitResource({
      url: entry.url,
      type: entry.type,
      mimeType: entry.mime,
      filename: entry.filename,
      pageUrl: entry.pageUrl,
      pageTitle: entry.pageMetadata?.title ?? null,
      requestContext: safeContext,
    })
    if (serverRow?.id) await updateCaptureByRemoteId(entry, { remoteId: serverRow.id })
  } catch {
    // Offline / backend down: keep locally; the periodic sweep retries.
  }
}

async function updateCaptureByRemoteId(entry, patch) {
  const list = await allCaptures()
  const want = displayUrlOf(entry.url)
  const row = list.find((c) => displayUrlOf(c.url) === want)
  if (row) await updateCapture(row.id, patch)
}

// ── Badge + periodic sync ───────────────────────────────────────────────────

async function updateBadge() {
  const pending = await countPending()
  await chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' })
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' })
  console.debug(`[badge] pending_count=${pending}`)
}

chrome.alarms.create('sync', { periodInMinutes: 5 })
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'sync') return
  const cfg = await getConfig()
  if (!cfg.baseUrl || !cfg.deviceToken) return
  try {
    await heartbeat(EXT_VERSION)
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/browser-capture/resources`, {
      headers: { authorization: `Bearer ${cfg.deviceToken}` },
    })
    if (!res.ok) return
    const data = await res.json()
    await pruneAgainstServer((data.items ?? []).map((r) => r.url))
    await updateBadge()
  } catch {
    // offline — retry next tick
  }
})

// ── Message API (popup) ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  ;(async () => {
    switch (msg?.type) {
      case 'getState': {
        // Re-resolve filenames against the freshest session metadata before
        // handing the list to the popup. Captures detected by a cold-started
        // SW before the content script's first storage write are upgraded in
        // place here; `customFilename` is permanent and never touched.
        const list = await allCaptures()
        const pageUrlCandidates = list.filter(
          (c) => (c.status === 'detected' || c.status === 'pending') && c.pageUrl,
        )
        const uniquePageUrls = Array.from(new Set(pageUrlCandidates.map((c) => c.pageUrl)))
        for (const u of uniquePageUrls) {
          try { await recheckPendingCaptures(u) } catch { /* ignore */ }
        }
        const [cfg, captures] = await Promise.all([getConfig(), allCaptures()])
        // Verify the device token still works — a revoked/rotated device must
        // surface as "Not connected" immediately, not after the next 5-min sweep.
        // heartbeat() clears the stored token on DEVICE_TOKEN_INVALID.
        let connected = Boolean(cfg.baseUrl && cfg.deviceToken)
        if (connected) {
          try {
            await heartbeat(EXT_VERSION)
          } catch {
            const fresh = await getConfig()
            connected = Boolean(fresh.baseUrl && fresh.deviceToken)
          }
        }
        const pending = captures.filter((c) => c.status === 'detected' || c.status === 'pending')
        console.debug(`[popup] loaded_resources=${pending.length} (raw=${captures.length})`)
        sendResponse({
          connected,
          baseUrl: cfg.baseUrl,
          deviceName: cfg.deviceName,
          captures: pending,
        })
        return
      }
      case 'pair': {
        try {
          const result = await pairDevice(msg.baseUrl, msg.pairingCode)
          sendResponse(result)
        } catch (e) {
          sendResponse({ error: e.message, code: e.code })
        }
        return
      }
      case 'removeCapture': {
        const captures = await allCaptures()
        const row = captures.find((c) => c.id === msg.id)
        if (row?.remoteId) void deleteServerResource(row.remoteId).catch(() => undefined)
        await removeCapture(msg.id)
        await updateBadge()
        sendResponse({ ok: true })
        return
      }
      case 'markConsumed': {
        const captures = await allCaptures()
        const want = msg.url ? displayUrlOf(msg.url) : null
        const row = want ? captures.find((c) => displayUrlOf(c.url) === want) : captures.find((c) => c.id === msg.id)
        await updateCapture(row?.id ?? msg.id, { status: 'submitted' })
        await updateBadge()
        sendResponse({ ok: true })
        return
      }
      case 'updateBadge':
        await updateBadge()
        sendResponse({ ok: true })
        return
      case 'clearAll': {
        await clearAllCaptures()
        await updateBadge()
        sendResponse({ ok: true })
        return
      }
      case 'updateCapture': {
        await updateCapture(msg.id, msg.patch)
        await updateBadge()
        sendResponse({ ok: true })
        return
      }
    }
  })()
  return true // async response
})

// ── Debug: dump storage state (call from service worker console) ─────────────
// Type `dumpState()` in the service worker console to see exactly what's in
// chrome.storage.local and why badge/popup might mismatch.
globalThis.dumpState = async () => {
  const all = await chrome.storage.local.get(null)
  const captures = all['9drive.captures'] ?? []
  const config = all['9drive.config'] ?? {}
  console.table(captures.map((c) => ({ id: c.id?.slice(0, 8), status: c.status, type: c.type, url: (c.url ?? '').slice(0, 50) })))
  console.log('config:', { connected: Boolean(config.baseUrl && config.deviceToken), baseUrl: config.baseUrl })
  console.log(`total=${captures.length} pending=${captures.filter((c) => c.status === 'detected' || c.status === 'pending').length}`)
}

// ── Pairing handshake ───────────────────────────────────────────────────────

async function pairDevice(userUrl, pairingCode) {
  // Resolve the real API root (direct backend vs site origin behind nginx)
  // BEFORE registering — the register POST must hit Express, not the SPA.
  const apiBase = await resolveApiRoot(userUrl)
  const ua = navigator.userAgent
  const browser = ua.includes('Edg/') ? 'edge' : ua.includes('Chrome') ? 'chrome' : 'chromium'
  const platform = navigator.platform || 'unknown'
  const reg = await requestTo(apiBase, '/browser-capture/devices/register', {
    method: 'POST',
    body: {
      pairingCode,
      name: `${browser} on ${platform}`,
      browser,
      platform,
      extensionVersion: EXT_VERSION,
    },
  })
  await setConfig({ baseUrl: userUrl, apiBase, deviceToken: reg.deviceToken, deviceName: reg.device?.name })
  return { ok: true, device: reg.device }
}
