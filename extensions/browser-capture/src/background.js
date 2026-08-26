/**
 * 9Drive Browser Capture — MV3 service worker.
 *
 * Detects media/document resources via chrome.webRequest (observational only —
 * it never reads bodies or cookies), classifies them with classify.js, keeps a
 * local pending list + badge, and syncs detections to the 9Drive backend.
 * The extension NEVER downloads file bytes; import goes through the backend's
 * Remote Import pipeline.
 */
import { classifyResource, detectFilename } from './classify.js'
import { addCapture, allCaptures, pruneAgainstServer, removeCapture, updateCapture } from './store.js'
import { getConfig, heartbeat, submitResource, deleteServerResource, setConfig } from './api.js'

const EXT_VERSION = chrome.runtime.getManifest().version

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
    const entry = {
      url: info.linkUrl,
      type: cls.type,
      mime: null,
      pageUrl: info.pageUrl ?? tab?.url ?? null,
      filename: detectFilename({ url: info.linkUrl, fallback: '' }),
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
    const entry = {
      url: details.url,
      type: cls.type,
      mime: mimeHeader ?? null,
      pageUrl,
      filename: detectFilename({ url: details.url, fallback: '' }),
      status: 'detected',
      ts: Date.now(),
    }
    await addCapture(entry)
    await updateBadge()
    void syncCapture(entry, safeContext)
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders'],
)

async function syncCapture(entry, safeContext = {}) {
  try {
    const serverRow = await submitResource({
      ...entry,
      pageTitle: null,
      requestContext: safeContext,
    })
    if (serverRow?.id) await updateCaptureByRemoteId(entry.url, { remoteId: serverRow.id })
  } catch {
    // Offline / backend down: keep locally; the periodic sweep retries.
  }
}

async function updateCaptureByRemoteId(url, patch) {
  const list = await allCaptures()
  const row = list.find((c) => c.url === url)
  if (row) await updateCapture(row.id, patch)
}

// ── Badge + periodic sync ───────────────────────────────────────────────────

async function updateBadge() {
  const list = await allCaptures()
  const pending = list.filter((c) => c.status === 'detected').length
  await chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' })
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' })
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
        const [cfg, captures] = await Promise.all([getConfig(), allCaptures()])
        sendResponse({
          connected: Boolean(cfg.baseUrl && cfg.deviceToken),
          baseUrl: cfg.baseUrl,
          deviceName: cfg.deviceName,
          captures: captures.filter((c) => c.status !== 'expired'),
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
        await updateCapture(msg.url ? (await allCaptures()).find((c) => c.url === msg.url)?.id : msg.id, {
          status: 'submitted',
        })
        await updateBadge()
        sendResponse({ ok: true })
        return
      }
      case 'updateBadge':
        await updateBadge()
        sendResponse({ ok: true })
        return
    }
  })()
  return true // async response
})

// ── Pairing handshake ───────────────────────────────────────────────────────

async function pairDevice(baseUrl, pairingCode) {
  const ua = navigator.userAgent
  const browser = ua.includes('Edg/') ? 'edge' : ua.includes('Chrome') ? 'chrome' : 'chromium'
  const platform = navigator.platform || 'unknown'
  const reg = await import('./api.js').then((m) =>
    m.registerDevice(baseUrl, pairingCode, { name: `${browser}-${platform}`, browser, platform, extensionVersion: EXT_VERSION }),
  )
  await setConfig({ baseUrl, deviceToken: reg.deviceToken, deviceName: reg.device?.name })
  return { ok: true, device: reg.device }
}
