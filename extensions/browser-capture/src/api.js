/**
 * 9Drive backend API client for the extension. Device token is stored in
 * chrome.storage.local and sent as a Bearer header. The base URL is the
 * user-provided 9Drive backend origin (set during first-run pairing).
 */

const CFG_KEY = '9drive.config'

export async function getConfig() {
  const obj = await chrome.storage.local.get(CFG_KEY)
  return obj[CFG_KEY] ?? { baseUrl: null, deviceToken: null, deviceName: null }
}

export async function setConfig(patch) {
  const cfg = { ...(await getConfig()), ...patch }
  await chrome.storage.local.set({ [CFG_KEY]: cfg })
  return cfg
}

export async function clearConnection() {
  await chrome.storage.local.set({ [CFG_KEY]: { baseUrl: null, deviceToken: null, deviceName: null } })
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const cfg = await getConfig()
  if (!cfg.baseUrl) throw Object.assign(new Error('Not connected'), { code: 'NOT_CONNECTED' })
  const headers = { 'content-type': 'application/json' }
  if (auth && cfg.deviceToken) headers.authorization = `Bearer ${cfg.deviceToken}`
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text).catch?.(() => ({})) ?? safeJson(text) : null
  if (!res.ok) {
    const err = new Error(data?.message || res.statusText || `HTTP ${res.status}`)
    err.code = data?.code || `HTTP_${res.status}`
    err.status = res.status
    throw err
  }
  return data
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return {} }
}

// ── Pairing / device lifecycle ──────────────────────────────────────────────

/** Exchange a dashboard pairing code for a persistent device token. */
export function registerDevice(baseUrl, pairingCode, meta) {
  return requestTo(baseUrl, '/browser-capture/devices/register', {
    method: 'POST',
    body: {
      pairingCode,
      name: meta.name,
      browser: meta.browser,
      platform: meta.platform,
      extensionVersion: meta.extensionVersion,
    },
    auth: false,
  })
}

export function heartbeat(extensionVersion) {
  return request('/browser-capture/heartbeat', { method: 'POST', body: { extensionVersion } })
}

// ── Captured resources ──────────────────────────────────────────────────────

export function submitResource(entry) {
  return request('/browser-capture/resources', {
    method: 'POST',
    body: {
      url: entry.url,
      type: entry.type === 'dash' ? 'dash' : entry.type,
      mimeType: entry.mime ?? null,
      filename: entry.filename ?? null,
      pageUrl: entry.pageUrl ?? null,
      pageTitle: entry.pageTitle ?? null,
      // Safe context only — the backend's strict schema rejects cookie/keys.
      requestContext: entry.requestContext ?? null,
    },
  })
}

export function listServerResources() {
  return request('/browser-capture/resources')
}

export function deleteServerResource(id) {
  return request(`/browser-capture/resources/${id}`, { method: 'DELETE' })
}

/** Import dialog inputs: folders, storage accounts, workers. */
export function importOptions() {
  return request('/browser-capture/import-options')
}

/** Create a Remote Import from a captured resource id (server loads the URL). */
export function importResource(resourceId, opts) {
  return request(`/browser-capture/resources/${resourceId}/import`, { method: 'POST', body: opts })
}

async function requestTo(baseUrl, path, init) {
  const headers = { 'content-type': 'application/json' }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  const data = safeJson(text)
  if (!res.ok) {
    const err = new Error(data?.message || res.statusText || `HTTP ${res.status}`)
    err.code = data?.code || `HTTP_${res.status}`
    err.status = res.status
    throw err
  }
  return data
}
