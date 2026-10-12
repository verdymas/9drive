import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, Maximize, Minimize, Monitor, Play, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/drive/PageHeader'
import { formatDate } from '@/lib/api'
import {
  createServerBrowserSession,
  displayUrl,
  getServerBrowserSession,
  isActiveSession,
  listServerBrowserSessions,
  mintServerBrowserViewToken,
  statusLabel,
  stopServerBrowserSession,
  type ServerBrowserSession,
} from '@/lib/serverBrowser'

const POLL_INTERVAL_MS = 5_000

function StatusBadge({ status }: { status: ServerBrowserSession['status'] }) {
  const classes: Record<ServerBrowserSession['status'], string> = {
    starting: 'bg-blue-50 text-blue-700',
    ready: 'bg-emerald-50 text-emerald-700',
    stopped: 'bg-slate-100 text-slate-600',
    expired: 'bg-amber-50 text-amber-700',
    failed: 'bg-red-50 text-red-700',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${classes[status]}`}>
      {status === 'starting' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {statusLabel(status)}
    </span>
  )
}

export function ServerBrowserPage() {
  const [sessions, setSessions] = useState<ServerBrowserSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [viewToken, setViewToken] = useState<string | null>(null)
  // One-time browser password revealed at creation. Kept only in memory:
  // never stored, and cleared when the session ends.
  const [vncPasswords, setVncPasswords] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const [frameLoading, setFrameLoading] = useState(true)
  const [frameError, setFrameError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameWrapRef = useRef<HTMLDivElement | null>(null)

  const active = sessions.find((s) => s.id === activeId) ?? null

  const load = useCallback(async () => {
    try {
      const rows = await listServerBrowserSessions()
      setSessions(rows)
      setError('')
      // Keep the selection on a live session; otherwise follow the newest active one.
      setActiveId((current) => {
        if (current && rows.some((r) => r.id === current && isActiveSession(r.status))) return current
        return rows.find((r) => isActiveSession(r.status))?.id ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load browser sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  // Poll while the selected session is still starting.
  useEffect(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
    if (active && active.status === 'starting') {
      pollTimer.current = setTimeout(() => {
        getServerBrowserSession(active.id)
          .then((updated) => {
            setSessions((rows) => rows.map((r) => (r.id === updated.id ? updated : r)))
            // Mint the display token as soon as the browser becomes ready so
            // the iframe can connect without an extra click.
            if (updated.status === 'ready' && !viewToken) {
              mintServerBrowserViewToken(updated.id)
                .then(({ token }) => {
                  setViewToken(token)
                  setFrameLoading(true)
                  setFrameError(false)
                })
                .catch(() => undefined)
            }
          })
          .catch(() => undefined)
      }, POLL_INTERVAL_MS)
    }
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [active, viewToken])

  async function handleStart() {
    setBusy(true)
    setError('')
    try {
      const { session, vncPassword } = await createServerBrowserSession()
      setSessions((rows) => [session, ...rows])
      setActiveId(session.id)
      setVncPasswords((prev) => ({ ...prev, [session.id]: vncPassword }))
      setCopied(false)
      setViewToken(null)
      setFrameError(false)
      setFrameLoading(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start browser session')
    } finally {
      setBusy(false)
    }
  }

  async function handleConnect(id: string) {
    setBusy(true)
    setError('')
    try {
      const [session, { token }] = await Promise.all([
        getServerBrowserSession(id),
        mintServerBrowserViewToken(id),
      ])
      setSessions((rows) => rows.map((r) => (r.id === session.id ? session : r)))
      setActiveId(session.id)
      setViewToken(token)
      setFrameLoading(true)
      setFrameError(false)
      setFrameKey((k) => k + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to browser session')
    } finally {
      setBusy(false)
    }
  }

  async function handleStop() {
    if (!active) return
    setBusy(true)
    setError('')
    try {
      const updated = await stopServerBrowserSession(active.id)
      setSessions((rows) => rows.map((r) => (r.id === updated.id ? updated : r)))
      setViewToken(null)
      setVncPasswords((prev) => {
        const next = { ...prev }
        delete next[active.id]
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop browser session')
    } finally {
      setBusy(false)
    }
  }

  function handleReconnect() {
    if (!active) return
    setFrameLoading(true)
    setFrameError(false)
    setFrameKey((k) => k + 1)
  }

  async function handleCopyPassword(password: string) {
    try {
      await navigator.clipboard.writeText(password)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy to clipboard — select and copy it manually.')
    }
  }

  // Track fullscreen so the button label and frame height follow the actual
  // state (including when the user exits with Esc).
  useEffect(() => {
    function onChange() {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Exit fullscreen when the session view unmounts (stop/expire/switch).
  useEffect(() => {
    if (!viewToken && document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined)
    }
  }, [viewToken])

  async function handleToggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else if (frameWrapRef.current) {
        await frameWrapRef.current.requestFullscreen()
      }
    } catch {
      setError('Fullscreen is not available in this browser.')
    }
  }

  return (
    <>
      <PageHeader
        title="Server Browser"
        description="A real Chromium browser running on the server, displayed here. Sessions are private to you and expire automatically."
        actions={
          active && isActiveSession(active.status) ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => handleStop()}>
              <Square className="h-3.5 w-3.5" />End session
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => handleStart()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Start browser session
            </Button>
          )
        }
      />

      {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}

      <Card className="mt-4 min-w-0 p-4 sm:p-5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />Loading sessions...
          </div>
        ) : !active ? (
          <div className="p-8 text-center">
            <Monitor className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-500">No active browser session.</p>
            <p className="mt-1 text-xs text-slate-400">
              Start a session to open an isolated Chromium browser on the server. End it when you are done — expired
              sessions are cleaned up automatically.
            </p>
            {sessions.length > 0 ? (
              <div className="mx-auto mt-4 grid max-w-lg gap-2 text-left">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-xs">
                    <span className="font-semibold text-slate-600">Session ended {formatDate(s.endedAt ?? s.createdAt)}</span>
                    <StatusBadge status={s.status} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <StatusBadge status={active.status} />
                <span className="truncate text-xs text-slate-500">
                  Expires {formatDate(active.expiresAt)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {active.status === 'ready' && !viewToken ? (
                  <Button size="sm" disabled={busy} onClick={() => handleConnect(active.id)}>
                    Connect
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" disabled={busy} onClick={handleReconnect}>
                  <RefreshCw className="h-3.5 w-3.5" />Reconnect
                </Button>
                {viewToken ? (
                  <Button size="sm" variant="outline" onClick={() => handleToggleFullscreen()}>
                    {isFullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
                    {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  </Button>
                ) : null}
              </div>
            </div>

            {active && vncPasswords[active.id] && isActiveSession(active.status) ? (
              <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-3 text-sm">
                <p className="font-bold text-slate-800">
                  Browser password <span className="ml-1 rounded-full bg-blue-600/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700">shown once</span>
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  When the remote browser asks for a login, use user <code className="font-bold">kasm_user</code> with
                  this password. Save it now — it is never stored and cannot be shown again.
                </p>
                <div className="mt-2 flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-xl bg-white px-3 py-2 font-mono text-sm font-bold text-slate-900">
                    {vncPasswords[active.id]}
                  </code>
                  <Button size="sm" variant="outline" onClick={() => handleCopyPassword(vncPasswords[active.id])}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            ) : null}

            {active.status === 'starting' && !viewToken ? (
              <div className="flex items-center justify-center gap-2 rounded-2xl bg-slate-50 p-10 text-sm font-semibold text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />Starting your private browser... this takes a few seconds.
              </div>
            ) : active.status === 'expired' ? (
              <div className="rounded-2xl bg-amber-50 p-6 text-center text-sm font-semibold text-amber-700">
                This session has expired and its browser was cleaned up. Start a new session to continue.
              </div>
            ) : active.status === 'failed' ? (
              <div className="rounded-2xl bg-red-50 p-6 text-center text-sm font-semibold text-red-700">
                This session failed to start. Stop it and start a new one — if it keeps failing, the browser service may
                be unavailable.
              </div>
            ) : active.status === 'stopped' ? (
              <div className="rounded-2xl bg-slate-50 p-6 text-center text-sm font-semibold text-slate-500">
                This session has ended and its browser was cleaned up.
              </div>
            ) : viewToken ? (
              <div
                ref={frameWrapRef}
                className="relative min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950"
              >
                {frameLoading && !frameError ? (
                  <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-slate-950/60 text-sm font-semibold text-white">
                    <Loader2 className="h-4 w-4 animate-spin" />Connecting to your browser...
                  </div>
                ) : null}
                {frameError ? (
                  <div className="flex flex-col items-center gap-3 p-10 text-center">
                    <p className="text-sm font-semibold text-white">Connection to the browser was lost.</p>
                    <Button size="sm" variant="outline" onClick={handleReconnect}>
                      <RefreshCw className="h-3.5 w-3.5" />Reconnect
                    </Button>
                  </div>
                ) : null}
                <iframe
                  key={frameKey}
                  title="Server browser"
                  src={displayUrl(active.id, viewToken)}
                  className={isFullscreen ? 'h-screen w-full border-0 bg-white' : 'h-[70vh] min-h-[480px] w-full border-0 bg-white'}
                  allow="clipboard-read; clipboard-write"
                  onLoad={() => {
                    setFrameLoading(false)
                  }}
                  onError={() => {
                    setFrameLoading(false)
                    setFrameError(true)
                  }}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 rounded-2xl bg-slate-50 p-10 text-sm font-semibold text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />Preparing secure display...
              </div>
            )}

            <p className="text-xs text-slate-400">
              Type the page URL into the remote Chromium's own address bar at the top of its window (click the frame
              first, then <code>Ctrl+L</code> jumps straight there). Your 9Drive login is never typed into the remote
              browser by this page.
            </p>
          </div>
        )}
      </Card>
    </>
  )
}
