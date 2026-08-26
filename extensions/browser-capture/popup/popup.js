/**
 * 9Drive Capture popup — page-style layout with inline import form.
 *
 * Architecture: single `state` object + `render()` function.
 * No framework; chrome popups are tiny — imperative DOM is fastest and clearest.
 */
import { groupCaptures } from '../src/classify.js'

const $ = (sel) => document.querySelector(sel)

const state = {
  connected: false,
  captures: [],
  selectedId: null,        // capture id being imported
  importStatus: 'idle',    // idle | submitting | success | error
  importMsg: '',
  options: null,           // { folders, storageAccounts, workers }
}

// ── Message API ─────────────────────────────────────────────────────────────

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve))
}

async function refreshState() {
  // Ensure badge is fresh before reading captures (handles captures saved
  // between the last updateBadge and this popup open).
  await send({ type: 'updateBadge' })
  const s = await send({ type: 'getState' })
  state.connected = Boolean(s?.connected)
  state.captures = s?.captures ?? []
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

  const groups = groupCaptures(state.captures)
  const pending = groups.filter((g) => g.status === 'detected')

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

  const icon = { video: '🎬', hls: '🎬', dash: '🎬', document: '📄' }[capture.type] ?? '📦'
  const domain = safeDomain(capture.url || capture.pageUrl)

  div.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-name">${esc(capture.filename || '(unnamed)')}</div>
        <div class="card-meta">
          <span>${icon} ${capture.type.toUpperCase()}</span>
          ${capture.mime ? `<span>${esc(capture.mime)}</span>` : ''}
          ${domain ? `<span class="domain">${esc(domain)}</span>` : ''}
        </div>
      </div>
      <span class="type-badge">${esc(capture.type)}</span>
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

function renderHlsGroup(group) {
  const div = document.createElement('div')
  div.className = 'card'
  const domain = safeDomain(group.primary.url || group.primary.pageUrl)
  const variants = group.variants

  div.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-name">🎬 HLS Stream</div>
        <div class="card-meta">
          <span>${variants.length} variant${variants.length > 1 ? 's' : ''}</span>
          ${domain ? `<span class="domain">${esc(domain)}</span>` : ''}
        </div>
      </div>
      <span class="type-badge">HLS</span>
    </div>
    <div class="hls-variants">
      ${variants.map((v, i) => `<div class="hls-variant"><span class="dot"></span>${esc(qualityLabel(v.filename, i))}</div>`).join('')}
    </div>
    ${variants.length > 1 ? `<select class="hls-quality-select" data-group-hls>
      ${variants.map((v, i) => `<option value="${v.id}">${esc(qualityLabel(v.filename, i))}</option>`).join('')}
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

function qualityLabel(filename, index) {
  const clean = (filename || '').replace(/\.(m3u8|m3u)$/i, '').replace(/.*\//, '')
  if (clean && clean !== filename) return clean
  return `Variant ${index + 1}`
}

function renderForm() {
  const capture = state.captures.find((c) => c.id === state.selectedId)
  if (!capture) { state.selectedId = null; render(); return }

  $('#dlgName').value = capture.filename || ''

  // Context indicator
  const ctx = $('#ctxIndicator')
  const hasCtx = capture.requestContext && capture.requestContext.attached
  ctx.hidden = !hasCtx

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
        filename: $('#dlgName').value.trim() || null,
        folderId: $('#dlgFolder').value || null,
        connectedAccountId: $('#dlgAccount').value || null,
        workerId: $('#dlgWorker').value || null,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`)
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function stripQuery(url) { try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href } catch { return url } }
function safeDomain(url) { try { return new URL(url).hostname } catch { return '' } }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

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

// ── Init ────────────────────────────────────────────────────────────────────

refreshState()
