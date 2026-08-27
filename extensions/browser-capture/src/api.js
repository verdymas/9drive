/**
 * 9Drive backend API client for the extension. Device token is stored in
 * chrome.storage.local and sent as a Bearer header. The base URL is the
 * user-provided 9Drive backend origin (set during first-run pairing).
 */

const CFG_KEY = '9drive.config'

export async function getConfig() {
  const obj = await chrome.storage.local.get(CFG_KEY)
  return obj[CFG_KEY] ?? { baseUrl: null, apiBase: null, deviceToken: null, deviceName: null }
}

export async function setConfig(patch) {
  const cfg = { ...(await getConfig()), ...patch }
  await chrome.storage.local.set({ [CFG_KEY]: cfg })
  return cfg
}

export async function clearConnection() {
  await chrome.storage.local.set({ [CFG_KEY]: { baseUrl: null, apiBase: null, deviceToken: null, deviceName: null } })
}

/** The resolved API root (e.g. https://site.com/api or http://localhost:4000). */
function apiRoot(cfg) {
  return (cfg.apiBase || cfg.baseUrl || '').replace(/\/$/, '')
}

/**
 * Resolve the API root for a user-entered 9Drive URL. Accepts BOTH forms:
 *   - direct backend:  http://localhost:4000        (GET /health works)
 *   - site origin:     https://9drive.example.com   (only /api/* proxies)
 * Probes each candidate's /health and requires the real JSON answer
 * ({status:"ok"}) — nginx SPA fallbacks also return 200 for unknown paths,
 * so the body is what distinguishes the backend from the static handler.
 */
export async function resolveApiRoot(userUrl) {
  const base = userUrl.replace(/\/$/, '')
  const candidates = []
  if (/\/api$/.test(base)) candidates.push(base)
  else candidates.push(base, `${base}/api`)
  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/health`)
      if (!res.ok) continue
      const data = await res.json().catch(() => null)
      if (data && data.status === 'ok') return candidate
    } catch { /* try next */ }
  }
  throw Object.assign(new Error(`Could not reach a 9Drive backend at ${userUrl} (tried ${candidates.join(', ')})`), { code: 'HOST_UNREACHABLE' })
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const cfg = await getConfig()
  if (!cfg.baseUrl) throw Object.assign(new Error('Not connected'), { code: 'NOT_CONNECTED' })
  const headers = { 'content-type': 'application/json' }
  if (auth && cfg.deviceToken) headers.authorization = `Bearer ${cfg.deviceToken}`
  const res = await fetch(`${apiRoot(cfg)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = safeJson(text)
  if (!res.ok) {
    // A revoked/rotated device token invalidates the stored connection — clear
    // it so the popup's getState reports "Not connected" instead of pretending
    // the device is still paired. Never let a stale local token linger.
    if (res.status === 401 && data?.code === 'DEVICE_TOKEN_INVALID' && auth) {
      await clearConnection()
    }
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

export async function requestTo(baseUrl, path, init) {
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
