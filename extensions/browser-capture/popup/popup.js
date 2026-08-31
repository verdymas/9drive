/**
 * 9Drive Capture popup — page-style layout with inline import form.
 *
 * Architecture: single `state` object + `render()` function.
 * No framework; chrome popups are tiny — imperative DOM is fastest and clearest.
 */
import { groupCaptures, displayTypeFor, urlQualityLabel } from '../src/classify.js'
import { getConfig, setCaptureFilters } from '../src/api.js'

const $ = (sel) => document.querySelector(sel)

const state = {
  connected: false,
  captures: [],
  selectedId: null,        // capture id being imported
  importStatus: 'idle',    // idle | submitting | success | error
  importMsg: '',
  options: null,           // { folders, storageAccounts, workers }
  debug: false,            // Phase 14: 9drive.debug storage flag
}

// ── Message API ─────────────────────────────────────────────────────────────

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[popup] sendMessage error:', chrome.runtime.lastError.message)
          resolve(null)
        } else {
          resolve(response)
        }
      })
    } catch (e) {
      console.warn('[popup] sendMessage threw:', e.message)
      resolve(null)
    }
  })
}

/** Direct storage read fallback — bypasses background if messages fail. */
async function directStorageRead() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('9drive.captures', (obj) => {
        resolve(obj['9drive.captures'] ?? [])
      })
    } catch {
      resolve([])
    }
  })
}

async function refreshState() {
  // Ensure badge is fresh before reading captures (handles captures saved
  // between the last updateBadge and this popup open).
  await send({ type: 'updateBadge' })
  const s = await send({ type: 'getState' })
  if (s) {
    state.connected = Boolean(s.connected)
    state.captures = s.captures ?? []
  } else {
    // Background service worker may have been terminated — fall back to
    // reading storage directly (bypasses the background message channel).
    console.warn('[popup] getState failed, falling back to direct storage read')
    const all = await directStorageRead()
    state.captures = all.filter((c) => c.status === 'detected' || c.status === 'pending')
    state.connected = false // can't determine without background
  }
  console.debug(`[popup] refresh: connected=${state.connected} captures=${state.captures.length}`)
  console.debug(`[popup] raw response:`, JSON.stringify(s).slice(0, 500))
  render()
}

async function loadOptions() {
  if (state.options) return state.options
  try {
    const cfg = await chrome.storage.local.get('9drive.config')
    const token = cfg['9drive.config']?.deviceToken
    const apiBase = (cfg['9drive.config']?.apiBase || cfg['9drive.config']?.baseUrl || '').replace(/\/$/, '')
    if (!apiBase || !token) { state.options = { folders: [], storageAccounts: [], workers: [] }; return state.options }
    const res = await fetch(`${apiBase}/browser-capture/import-options`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    })
    state.options = res.ok ? await res.json() : { folders: [], storageAccounts: [], workers: [] }
  } catch {
    state.options = { folders: [], storageAccounts: [], workers: [] }
  }
  return state.options
}

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
  // Header badge
  const conn = $('#conn')
  conn.textContent = state.connected ? 'Connected' : 'Not connected'
  conn.className = `badge ${state.connected ? 'on' : 'off'}`

  // Clear All — only when there are captures to clear
  $('#clearAll').hidden = state.captures.length === 0

  // Pair form
  $('#pairForm').hidden = state.connected

  // Capture list
  renderList()

  // Import form
  const form = $('#importForm')
  const footer = $('#importFooter')
  const hasSelection = state.selectedId !== null
  form.hidden = !hasSelection
  footer.hidden = !hasSelection
  if (hasSelection) renderForm()
}

function renderList() {
  const list = $('#captureList')
  list.innerHTML = ''

  if (!state.connected && state.captures.length === 0) {
    list.innerHTML = '<div class="empty">Connect to your 9Drive to start capturing.</div>'
    return
  }

  // groupCaptures already excludes expired/consumed; `getState` only returns
  // detected/pending. Filtering by status here is WRONG for hls-group entries
  // (they carry no top-level `status` — the primary capture does). All groups
  // that reach this point are actionable; no extra filter needed.
  const groups = groupCaptures(state.captures)
  const pending = groups.filter((g) => (g.type === 'hls-group' ? g.primary : g).status === 'detected')

  if (pending.length === 0) {
    list.innerHTML = '<div class="empty">No captured media yet.<br>Play or open a video/PDF to detect it.</div>'
    return
  }

  for (const group of pending) {
    if (group.type === 'hls-group') {
      list.appendChild(renderHlsGroup(group))
    } else {
      list.appendChild(renderCaptureCard(group))
    }
  }
}

function renderCaptureCard(capture) {
  const div = document.createElement('div')
  div.className = 'card'

  const icon = { video: '🎬', hls: '🎬', dash: '🎬', audio: '🎵', image: '🖼️', archive: '🗜️', document: '📄' }[capture.type] ?? '📦'
  const domain = safeDomain(capture.url || capture.pageUrl)
  const dt = displayTypeFor(capture.type, capture.mime)
  const name = capture.customFilename || capture.filename || '(unnamed)'
  const thumb = capture.thumbnail
    ? `<img class="thumb" src="${escAttr(capture.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : ''
  const sourceChip = sourceChipHtml(capture)

  div.innerHTML = `
    <div class="card-header">
      ${thumb}
      <div>
        <div class="card-name">${icon} ${esc(name)}${sourceChip}</div>
        <div class="card-meta">
          <span>${esc(dt)}</span>
          ${capture.quality ? `<span>Quality: ${esc(capture.quality)}</span>` : ''}
          ${capture.duration ? `<span>Duration: ${formatDuration(capture.duration)}</span>` : ''}
          <span>Estimated size: ${formatSize(capture.estimatedSize)}</span>
          ${domain ? `<span class="domain">Source: ${esc(domain)}</span>` : ''}
        </div>
      </div>
      <span class="type-badge">${esc(dt)}</span>
    </div>
    <div class="card-actions">
      <button class="primary" data-act="import">Import</button>
      ${capture.pageUrl ? '<button data-act="source">Source</button>' : ''}
      <button class="danger" data-act="remove">Remove</button>
    </div>`

  div.querySelector('[data-act="import"]').onclick = () => openImport(capture)
  div.querySelector('[data-act="remove"]').onclick = () => removeCapture(capture.id)
  const srcBtn = div.querySelector('[data-act="source"]')
  if (srcBtn) srcBtn.onclick = () => chrome.tabs.create({ url: capture.pageUrl })
  return div
}

/** Human-friendly source label for the card chip. */
const SOURCE_LABELS = {
  'jsonld-videoobject-name': 'JSON-LD',
  'jsonld-videoobject-headline': 'JSON-LD',
  'player-config-title': 'player',
  'player-config-name': 'player',
  'api-metadata-title': 'API',
  'api-metadata-name': 'API',
  'dom-video-title': 'page',
  'dom-video-aria-label': 'page',
  'dom-video-data-title': 'page',
  'dom-video-data-name': 'page',
  'og-title': 'og:title',
  'og-video-title': 'og:video:title',
  'twitter-title': 'twitter:title',
  'meta-itemprop-name': 'page',
  'media-title': '<video title>',
  'page-title': 'document.title',
  'cd-filename-star': 'Content-Disposition',
  'cd-filename': 'Content-Disposition',
  'download-attr': 'download attr',
  'final-url': 'URL',
  'request-url': 'URL',
  'custom-filename': 'custom',
  'url-basename-non-generic': 'URL',
  'url-basename-generic': 'URL',
  'fallback': 'fallback',
  'generic-playlist': 'URL',
}

function sourceChipHtml(capture) {
  // Only show a chip for "real identity" sources, not URL basenames.
  const candidates = capture?.mediaIdentity?.identity?.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return ''
  const top = candidates[0]
  if (!top || !top.source) return ''
  const label = SOURCE_LABELS[top.source]
  if (!label) return ''
  if (['final-url', 'request-url', 'url-basename-non-generic', 'url-basename-generic', 'fallback', 'generic-playlist'].includes(top.source)) {
    return ''
  }
  const conf = Number.isFinite(top.confidence) ? ` · ${top.confidence}` : ''
  return `<span class="source-chip" title="${esc(top.value ?? '')} (${esc(top.source)}${conf})">from ${esc(label)}</span>`
}

function sourceListHtml(capture) {
  const candidates = capture?.mediaIdentity?.identity?.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return ''
  // Top 3 distinct sources, scored.
  const seen = new Set()
  const top = []
  for (const c of candidates) {
    if (!c || !c.source || !c.value) continue
    if (seen.has(c.source)) continue
    seen.add(c.source)
    top.push(c)
    if (top.length >= 3) break
  }
  return top.map((c) => `<li><span class="src">${esc(SOURCE_LABELS[c.source] ?? c.source)}</span><span class="score">${Number.isFinite(c.confidence) ? c.confidence : '–'}</span></li>`).join('')
}

function renderHlsGroup(group) {
  const div = document.createElement('div')
  div.className = 'card'
  const domain = safeDomain(group.primary.url || group.primary.pageUrl)
  const variants = group.variants
  const dt = displayTypeFor(group.primary.type, group.primary.mime)
  // Sum variant sizes for the group estimate; unknown sizes are excluded.
  const sizes = variants.map((v) => v.estimatedSize).filter((s) => s != null)
  const groupSize = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) : null
  const thumb = group.primary.thumbnail
    ? `<img class="thumb" src="${escAttr(group.primary.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : ''

  div.innerHTML = `
    <div class="card-header">
      ${thumb}
      <div>
        <div class="card-name">🎬 ${esc(group.primary.customFilename || group.primary.filename || 'HLS Stream')}</div>
        <div class="card-meta">
          <span>${esc(dt)}</span>
          <span>${variants.length} variant${variants.length > 1 ? 's' : ''}</span>
          <span>Estimated size: ${formatSize(groupSize)}</span>
          ${domain ? `<span class="domain">Source: ${esc(domain)}</span>` : ''}
        </div>
      </div>
      <span class="type-badge">${esc(dt)}</span>
    </div>
    <div class="hls-variants">
      ${variants.map((v, i) => `<div class="hls-variant"><span class="dot"></span>${esc(variantLabel(v, i))}</div>`).join('')}
    </div>
    ${variants.length > 1 ? `<select class="hls-quality-select" data-group-hls>
      ${variants.map((v, i) => `<option value="${v.id}">${esc(variantLabel(v, i))}</option>`).join('')}
    </select>` : ''}
    <div class="card-actions">
      <button class="primary" data-act="import-hls">Import</button>
      ${group.primary.pageUrl ? '<button data-act="source">Source</button>' : ''}
      <button class="danger" data-act="remove-hls">Remove</button>
    </div>`

  div.querySelector('[data-act="import-hls"]').onclick = () => {
    const select = div.querySelector('[data-group-hls]')
    const chosen = select ? variants.find((v) => v.id === select.value) : group.primary
    openImport(chosen || group.primary)
  }
  div.querySelector('[data-act="remove-hls"]').onclick = async () => {
    for (const v of variants) await removeCapture(v.id)
  }
  const srcBtn = div.querySelector('[data-act="source"]')
  if (srcBtn) srcBtn.onclick = () => chrome.tabs.create({ url: group.primary.pageUrl })
  return div
}

/**
 * Variant label: URL-derived quality first (a /1080/index.m3u8 variant is
 * "1080p"), then the captured quality field, then the cleaned filename.
 */
function variantLabel(variant, index) {
  const fromUrl = urlQualityLabel(variant.url)
  if (fromUrl) return fromUrl
  if (variant.quality) return variant.quality
  const clean = (variant.filename || '').replace(/\.(m3u8|m3u)$/i, '').replace(/.*\//, '')
  if (clean && clean !== variant.filename) return clean
  return `Variant ${index + 1}`
}

function renderForm() {
  const capture = state.captures.find((c) => c.id === state.selectedId)
  if (!capture) { state.selectedId = null; render(); return }

  $('#dlgName').value = capture.customFilename || capture.filename || ''

  // Context indicator
  const ctx = $('#ctxIndicator')
  const hasCtx = capture.requestContext && capture.requestContext.attached
  ctx.hidden = !hasCtx

  // Phase 14: about-this-name panel — show the top 3 candidate sources.
  const about = $('#aboutName')
  const aboutList = $('#aboutNameList')
  const sources = sourceListHtml(capture)
  if (sources) {
    aboutList.innerHTML = sources
    about.hidden = false
  } else {
    aboutList.innerHTML = ''
    about.hidden = true
  }

  // Status message
  const msg = $('#dlgMsg')
  if (state.importStatus === 'submitting') { msg.textContent = 'Submitting…'; msg.className = 'msg loading' }
  else if (state.importStatus === 'success') { msg.textContent = '✓ Import created — see Remote Imports in 9Drive.'; msg.className = 'msg ok' }
  else if (state.importStatus === 'error') { msg.textContent = state.importMsg; msg.className = 'msg err' }
  else { msg.textContent = ''; msg.className = 'msg' }

  // Start button state
  const startBtn = $('#dlgStart')
  startBtn.disabled = state.importStatus === 'submitting'
}

async function populateDropdowns() {
  const opts = await loadOptions()
  fillSelect($('#dlgFolder'), [{ id: '', label: 'Root' }, ...opts.folders.map((f) => ({ id: f.id, label: f.name }))])
  fillSelect($('#dlgAccount'), [{ id: '', label: 'Automatic' }, ...opts.storageAccounts.map((a) => ({ id: a.id, label: a.displayName || a.email }))])
  fillSelect($('#dlgWorker'), [{ id: '', label: 'Direct' }, ...opts.workers.map((w) => ({ id: w.id, label: `${w.name}${w.status === 'healthy' ? '' : ` (${w.status})`}` }))])
}

function fillSelect(select, items) {
  select.innerHTML = ''
  for (const it of items) {
    const opt = document.createElement('option')
    opt.value = it.id; opt.textContent = it.label
    select.appendChild(opt)
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function openImport(capture) {
  state.selectedId = capture.id
  state.importStatus = 'idle'
  state.importMsg = ''
  render()
  await populateDropdowns()
}

function cancelImport() {
  state.selectedId = null
  state.importStatus = 'idle'
  state.importMsg = ''
  render()
}

async function startImport() {
  const capture = state.captures.find((c) => c.id === state.selectedId)
  if (!capture) return
  // Snapshot the user's edited filename BEFORE render() re-populates the input
  // from capture.filename — render() must never overwrite explicit user input.
  const userFilename = $('#dlgName').value.trim() || null
  state.importStatus = 'submitting'
  render()

  try {
    let serverId = capture.remoteId
    if (!serverId) {
      const cfg = await chrome.storage.local.get('9drive.config')
      const apiBase = (cfg['9drive.config']?.apiBase || cfg['9drive.config']?.baseUrl || '').replace(/\/$/, '')
      const token = cfg['9drive.config']?.deviceToken
      if (!apiBase || !token) throw new Error('Not connected')
      const listRes = await fetch(`${apiBase}/browser-capture/resources`, { headers: { authorization: `Bearer ${token}` } })
      const list = listRes.ok ? (await listRes.json()).items ?? [] : []
      serverId = list.find((r) => r.url === capture.displayUrl || r.url === stripQuery(capture.url))?.id
      if (!serverId) throw new Error('Capture not synced yet — reopen the popup in a moment.')
    }
    const cfg = await chrome.storage.local.get('9drive.config')
    const apiBase = (cfg['9drive.config']?.apiBase || cfg['9drive.config']?.baseUrl || '').replace(/\/$/, '')
    const token = cfg['9drive.config']?.deviceToken
    const res = await fetch(`${apiBase}/browser-capture/resources/${serverId}/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: userFilename,
        folderId: $('#dlgFolder').value || null,
        connectedAccountId: $('#dlgAccount').value || null,
        workerId: $('#dlgWorker').value || null,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`)
    // Persist the user's edited filename so reopening the dialog keeps it.
    if (userFilename && userFilename !== capture.filename) {
      await send({ type: 'updateCapture', id: capture.id, patch: { customFilename: userFilename } })
    }
    await send({ type: 'markConsumed', url: capture.url })
    state.importStatus = 'success'
    render()
    setTimeout(() => { state.selectedId = null; state.importStatus = 'idle'; render() }, 2000)
  } catch (e) {
    state.importStatus = 'error'
    state.importMsg = e.message
    render()
  }
}

async function removeCapture(id) {
  await send({ type: 'removeCapture', id })
  if (state.selectedId === id) cancelImport()
  await refreshState()
}

// ── Clear all ────────────────────────────────────────────────────────────────

async function clearAll() {
  await send({ type: 'clearAll' })
  state.selectedId = null
  state.importStatus = 'idle'
  state.importMsg = ''
  await refreshState()
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes == null) return 'Unknown'
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return 'Unknown'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
function formatDuration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
function stripQuery(url) { try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href } catch { return url } }
function safeDomain(url) { try { return new URL(url).hostname } catch { return '' } }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;') }

// ── Pairing ─────────────────────────────────────────────────────────────────

$('#pairForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const msg = $('#pairMsg')
  msg.className = 'msg loading'; msg.textContent = 'Connecting…'
  try {
    const result = await send({ type: 'pair', baseUrl: $('#baseUrl').value.trim(), pairingCode: $('#pairingCode').value.trim() })
    if (result?.error) { msg.textContent = result.error; msg.className = 'msg err'; return }
    await refreshState()
  } catch (e) {
    msg.textContent = e.message; msg.className = 'msg err'
  }
})

// ── Footer buttons ─────────────────────────────────────────────────────────

$('#dlgCancel').onclick = cancelImport
$('#dlgStart').onclick = startImport
$('#clearAll').onclick = clearAll

// ── Phase 14: debug log toggle ──────────────────────────────────────────────

async function loadDebugFlag() {
  try {
    const obj = await chrome.storage.local.get('9drive.debug')
    state.debug = obj['9drive.debug'] === '1'
  } catch { state.debug = false }
  paintDebugToggle()
}

function paintDebugToggle() {
  const btn = $('#debugToggle')
  if (!btn) return
  btn.classList.toggle('on', state.debug)
  btn.textContent = state.debug ? 'Debug log: ON' : 'Debug log'
}

$('#debugToggle').addEventListener('click', async () => {
  state.debug = !state.debug
  paintDebugToggle()
  try { await send({ type: 'SET_DEBUG', enabled: state.debug }) } catch { /* ignore */ }
  try { await chrome.storage.local.set({ '9drive.debug': state.debug ? '1' : '0' }) } catch { /* ignore */ }
})

// ── Capture Settings (filter checkboxes) ────────────────────────────────────

/** Paint each `[data-filter]` checkbox from the persisted config. */
async function paintFilters() {
  try {
    const cfg = await getConfig()
    const filters = cfg.captureFilters
    for (const box of document.querySelectorAll('#captureSettings input[type="checkbox"][data-filter]')) {
      const key = box.dataset.filter
      if (key in filters) box.checked = Boolean(filters[key])
    }
  } catch { /* ignore — checkboxes keep their HTML defaults */ }
}

/** Single delegated change listener: persist the new value immediately. */
document.querySelector('#captureSettings')?.addEventListener('change', async (e) => {
  const box = e.target
  if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox' || !box.dataset.filter) return
  try { await setCaptureFilters({ [box.dataset.filter]: box.checked }) } catch { /* ignore */ }
})

// ── Init ────────────────────────────────────────────────────────────────────

void loadDebugFlag()
void paintFilters()
refreshState()
