/** 9Drive Capture popup — lists detected resources, drives the import dialog. */

const $ = (sel) => document.querySelector(sel)
const state = { captures: [], connected: false, options: null }
const TYPE_ICONS = { video: '🎬', hls: '🎬', dash: '🎬', document: '📄' }

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve))
}

async function refresh() {
  const s = await send({ type: 'getState' })
  state.captures = s?.captures ?? []
  state.connected = Boolean(s?.connected)
  $('#conn').textContent = state.connected ? 'Connected' : 'Not connected'
  $('#conn').classList.toggle('off', !state.connected)
  $('#pairForm').hidden = state.connected
  renderList()
}

function renderList() {
  const list = $('#list')
  list.innerHTML = ''
  const pending = state.captures.filter((c) => c.status === 'detected')
  if (!state.connected && pending.length === 0) {
    list.innerHTML = '<div class="empty">Connect to your 9Drive to start capturing.</div>'
    return
  }
  if (pending.length === 0) {
    list.innerHTML = '<div class="empty">No captured media yet.<br />Play or open a video/PDF to detect it.</div>'
    return
  }
  for (const c of [...pending].sort((a, b) => b.ts - a.ts)) {
    const div = document.createElement('div')
    div.className = 'item'
    const name = c.filename || '(unnamed)'
    const meta = `${TYPE_ICONS[c.type] ?? '📦'} ${c.type.toUpperCase()}${c.mime ? ` · ${c.mime}` : ''}`
    div.innerHTML = `
      <div class="name"></div>
      <div class="meta"></div>
      <div class="row">
        <button class="primary" data-act="import"></button>
        <button data-act="open">Source</button>
        <button class="danger" data-act="remove">Remove</button>
      </div>`
    div.querySelector('.name').textContent = name
    div.querySelector('.meta').textContent = meta
    const importBtn = div.querySelector('[data-act="import"]')
    importBtn.textContent = 'Import'
    // Never render raw URLs (they may carry signed params).
    div.querySelector('[data-act="open"]').addEventListener('click', () => {
      // Source page only — never the resource URL itself.
      if (c.pageUrl) chrome.tabs.create({ url: c.pageUrl })
    })
    div.querySelector('[data-act="remove"]').addEventListener('click', async () => {
      await send({ type: 'removeCapture', id: c.id })
      await refresh()
    })
    importBtn.addEventListener('click', () => openDialog(c))
    list.appendChild(div)
  }
}

async function openDialog(capture) {
  $('#dlgMsg').textContent = ''
  $('#dlgName').value = capture.filename || ''
  if (!state.options) {
    try {
      const res = await fetch(`${await apiBase()}/browser-capture/import-options`, { headers: await authHeaders() })
      state.options = res.ok ? await res.json() : { folders: [], storageAccounts: [], workers: [] }
    } catch {
      state.options = { folders: [], storageAccounts: [], workers: [] }
    }
  }
  fillSelect($('#dlgFolder'), [{ id: '', label: 'Root' }, ...state.options.folders.map((f) => ({ id: f.id, label: f.name }))])
  fillSelect($('#dlgAccount'), [{ id: '', label: 'Automatic' }, ...state.options.storageAccounts.map((a) => ({ id: a.id, label: a.displayName || a.email }))])
  fillSelect($('#dlgWorker'), [{ id: '', label: 'Direct' }, ...state.options.workers.map((w) => ({ id: w.id, label: `${w.name}${w.status === 'healthy' ? '' : ` (${w.status})`}` }))])
  $('#dlgStart').onclick = () => startImport(capture)
  $('#importDialog').showModal()
}

/** Resolved API root from storage (set during pairing; may be <base>/api). */
async function apiBase() {
  const cfg = await new Promise((resolve) => chrome.storage.local.get('9drive.config', resolve))
  const c = cfg['9drive.config'] ?? {}
  return (c.apiBase || c.baseUrl || '').replace(/\/$/, '')
}

async function authHeaders() {
  const cfg = await new Promise((resolve) => chrome.storage.local.get('9drive.config', resolve))
  const token = cfg['9drive.config']?.deviceToken
  return token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' }
}

function fillSelect(select, items) {
  select.innerHTML = ''
  for (const it of items) {
    const opt = document.createElement('option')
    opt.value = it.id
    opt.textContent = it.label
    select.appendChild(opt)
  }
}

async function startImport(capture) {
  $('#dlgStart').disabled = true
  $('#dlgMsg').textContent = 'Submitting…'
  $('#dlgMsg').className = 'msg'
  try {
    const base = await apiBase()
    // The backend imports by its own captured-resource id. If this local row
    // was never synced (offline at detection), resolve it by URL first.
    let serverId = capture.remoteId
    if (!serverId) {
      const listRes = await fetch(`${base}/browser-capture/resources`, { headers: await authHeaders() })
      const list = listRes.ok ? (await listRes.json()).items ?? [] : []
      serverId = list.find((r) => r.url === capture.displayUrl || r.url === stripQuery(capture.url))?.id
      if (!serverId) throw new Error('Capture not synced yet — reopen the popup in a moment.')
    }
    const res = await fetch(`${base}/browser-capture/resources/${serverId}/import`, {
      method: 'POST',
      headers: await authHeaders(),
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
    $('#dlgMsg').textContent = '✓ Import created — see Remote Imports in 9Drive.'
    setTimeout(() => {
      $('#importDialog').close()
      refresh()
    }, 1200)
  } catch (e) {
    $('#dlgMsg').textContent = e.message
    $('#dlgMsg').className = 'msg err'
  } finally {
    $('#dlgStart').disabled = false
  }
}

function stripQuery(url) {
  try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href } catch { return url }
}

$('#pairForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const msg = $('#pairMsg')
  msg.className = 'msg'
  msg.textContent = 'Connecting…'
  const result = await send({ type: 'pair', baseUrl: $('#baseUrl').value.trim(), pairingCode: $('#pairingCode').value.trim() })
  if (result?.error) {
    msg.textContent = result.error
    msg.className = 'msg err'
    return
  }
  await refresh()
})

refresh()
