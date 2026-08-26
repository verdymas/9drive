import { useCallback, useEffect, useState } from 'react'
import { MonitorSmartphone, Plus, Trash2, RefreshCcw, Copy, Check, Download, Link2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { apiFetch, API_URL } from '@/lib/api'

type Pairing = { id: string; code: string; expiresAt: string }
type Device = {
  id: string
  name: string
  browser: string
  platform: string
  extensionVersion: string | null
  status: string
  lastSeenAt: string | null
}

/**
 * Settings → Browser Capture. Pair the extension (one-time code), manage
 * connected devices (rename/rotate/revoke). Minimal Phase-01 surface; Phase 07
 * expands this into a full devices page with cleanup + observability.
 */
export function BrowserCaptureCard() {
  const [devices, setDevices] = useState<Device[]>([])
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ devices: Device[] }>('/browser-capture/devices')
      setDevices(data.devices)
    } catch {
      /* feature disabled or offline — render quietly */
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const createPairing = async () => {
    setBusy(true)
    try {
      const p = await apiFetch<Pairing>('/browser-capture/devices/pairing', { method: 'POST' })
      setPairing(p)
      setCopied(false)
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const rotate = async (id: string) => {
    if (!confirm('Rotate this device token? The extension must re-pair.')) return
    await apiFetch(`/browser-capture/devices/${id}/rotate`, { method: 'POST' })
    await load()
  }

  const revoke = async (id: string) => {
    if (!confirm('Revoke this browser device? Its pending captures stay in your list.')) return
    await apiFetch(`/browser-capture/devices/${id}`, { method: 'DELETE' })
    await load()
  }

  const copyCode = async () => {
    if (!pairing) return
    await navigator.clipboard.writeText(pairing.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const copyBackendUrl = async () => {
    await navigator.clipboard.writeText(API_URL)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const downloadExtension = async () => {
    try {
      const res = await fetch(`${API_URL}/browser-capture/extension.zip`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('9drive.accessToken') ?? ''}` },
      })
      if (!res.ok) { alert(`Download failed: ${res.status}`); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = '9drive-capture.zip'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      alert((e as Error).message)
    }
  }

  return (
    <Card className="overflow-hidden p-3.5">
      <div className="flex flex-col gap-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5"><MonitorSmartphone className="h-5 w-5 text-blue-600" /><h2 className="text-[16px] font-bold">Browser Capture</h2></div>
          <p className="mt-1 text-[13px] text-slate-500">Pair the 9Drive browser extension to send detected media straight to Remote Imports.</p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-1.5 sm:w-auto sm:flex-row">
          <Button className="w-full sm:w-auto" size="sm" variant="outline" onClick={createPairing} disabled={busy}>
            <Plus className="h-4 w-4" />Pair a device
          </Button>
          <Button className="w-full sm:w-auto" size="sm" variant="outline" onClick={downloadExtension}><Download className="h-4 w-4" />Extension .zip</Button>
        </div>
      </div>

      {pairing ? (
        <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/60 p-3">
          <p className="text-xs font-semibold text-blue-900">One-time pairing code (expires {new Date(pairing.expiresAt).toLocaleTimeString()})</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-white px-2 py-1.5 text-[12px]">{pairing.code}</code>
            <Button size="sm" variant="outline" onClick={copyCode}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? 'Copied' : 'Copy'}</Button>
          </div>
          <p className="mt-2.5 text-xs font-semibold text-blue-900">Connect the extension to this backend URL</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-white px-2 py-1.5 text-[12px]">{API_URL}</code>
            <Button size="sm" variant="outline" onClick={copyBackendUrl}><Link2 className="h-4 w-4" />Copy</Button>
          </div>
        </div>
      ) : null}

      {devices.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 p-2.5 dark:border-slate-800">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{d.name}</p>
                <p className="text-xs text-slate-500">
                  {d.browser} · {d.platform} · v{d.extensionVersion ?? '?'}
                  {d.lastSeenAt ? ` · seen ${new Date(d.lastSeenAt).toLocaleString()}` : ' · never seen'}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="outline" onClick={() => rotate(d.id)} title="Rotate credential"><RefreshCcw className="h-4 w-4" /></Button>
                <Button size="sm" variant="danger" onClick={() => revoke(d.id)}><Trash2 className="h-4 w-4" />Revoke</Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}
