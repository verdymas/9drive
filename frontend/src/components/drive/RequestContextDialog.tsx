import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Eye, Loader2, Lock, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DummyModal } from '@/components/drive/DummyModal'
import { getRemoteImportRequestContext, updateRemoteImportDownloadUrl, type RemoteImportRequestContextDetails } from '@/lib/remoteImports'

type Props = {
  importId: string | null
  fileName?: string | null
  /** True when the import is failed/cancelled/queued — the Download URL is editable. */
  editable?: boolean
  /** Called after a URL save so the parent can refresh the list. */
  onUrlSaved?: () => void
  onClose: () => void
}

function FieldRow({
  label,
  value,
  copyLabel,
  copied,
  onCopy,
  action,
}: {
  label: string
  value: string
  copyLabel: string
  copied: boolean
  onCopy?: () => void
  action?: ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {action}
          {onCopy ? (
            <Button size="sm" variant="outline" onClick={onCopy} aria-label={copyLabel}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1 max-h-32 min-w-0 max-w-full overflow-auto break-words rounded-xl bg-slate-50 p-2.5 text-xs font-semibold text-slate-900 [overflow-wrap:anywhere]">
        {value}
      </p>
    </div>
  )
}

/**
 * Owner-only request-context details dialog for a Remote Import.
 *
 * Fetches masked details lazily on open; the raw Cookie is fetched only after
 * an explicit Reveal click and is cleared (with all other detail state) when
 * the dialog closes. Nothing is persisted outside this component's lifecycle.
 */
export function RequestContextDialog({ importId, fileName, editable, onUrlSaved, onClose }: Props) {
  const [details, setDetails] = useState<RemoteImportRequestContextDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revealing, setRevealing] = useState(false)
  const [revealError, setRevealError] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [editingUrl, setEditingUrl] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [savingUrl, setSavingUrl] = useState(false)
  const [saveError, setSaveError] = useState('')

  function resetTransientState() {
    setDetails(null)
    setError('')
    setRevealError('')
    setRevealing(false)
    setCopiedKey(null)
    setEditingUrl(false)
    setUrlDraft('')
    setSavingUrl(false)
    setSaveError('')
  }

  useEffect(() => {
    if (!importId) {
      // Dialog closed — drop any sensitive detail state immediately.
      resetTransientState()
      return
    }
    let cancelled = false
    resetTransientState()
    setLoading(true)
    getRemoteImportRequestContext(importId)
      .then((data) => {
        if (!cancelled) setDetails(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load request context')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // resetTransientState is stable (no deps) — importId is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importId])

  // Extra safety: clear sensitive state on unmount (dialog lifecycle only).
  useEffect(() => {
    return () => {
      setDetails(null)
    }
  }, [])

  function handleClose() {
    resetTransientState()
    onClose()
  }

  function handleStartEdit() {
    setUrlDraft(details?.downloadUrl ?? '')
    setSaveError('')
    setEditingUrl(true)
  }

  async function handleSaveUrl() {
    if (!importId) return
    const next = urlDraft.trim()
    if (!next) {
      setSaveError('Enter a URL.')
      return
    }
    setSavingUrl(true)
    setSaveError('')
    try {
      await updateRemoteImportDownloadUrl(importId, next)
      setEditingUrl(false)
      // Re-fetch so the dialog shows the saved URL; parent refreshes the list.
      const data = await getRemoteImportRequestContext(importId)
      setDetails(data)
      onUrlSaved?.()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save URL')
    } finally {
      setSavingUrl(false)
    }
  }

  async function handleReveal() {
    if (!importId) return
    setRevealing(true)
    setRevealError('')
    try {
      const data = await getRemoteImportRequestContext(importId, { revealCookie: true })
      setDetails(data)
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : 'Failed to reveal cookie')
    } finally {
      setRevealing(false)
    }
  }

  function handleHide() {
    setDetails((prev) =>
      prev ? { ...prev, cookie: { ...prev.cookie, raw: null } } : prev,
    )
    setRevealError('')
  }

  async function handleCopy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1500)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  const rawCookie = details?.cookie.raw ?? null

  return (
    <DummyModal
      open={importId !== null}
      title="Request Context"
      description={fileName ?? 'Headers attached to this import for protected sources.'}
      onClose={handleClose}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 p-6 text-sm font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />Loading request context...
        </div>
      ) : error ? (
        <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>
      ) : details && !details.attached ? (
        <p className="rounded-xl bg-slate-50 p-3 text-sm font-semibold text-slate-500">No request context attached to this import.</p>
      ) : details ? (
        <div className="grid min-w-0 gap-4">
          {details.downloadUrl ? (
            <FieldRow
              label="Download URL"
              value={details.downloadUrl}
              copyLabel="Copy Download URL"
              copied={copiedKey === 'downloadUrl'}
              onCopy={() => handleCopy('downloadUrl', details.downloadUrl!)}
              action={editable && !editingUrl ? (
                <Button size="sm" variant="outline" onClick={handleStartEdit} aria-label="Edit Download URL">
                  <Pencil className="h-3.5 w-3.5" />Edit
                </Button>
              ) : undefined}
            />
          ) : (
            <p className="text-xs font-semibold text-slate-400">Download URL — Not available</p>
          )}
          {editingUrl ? (
            <div className="grid min-w-0 gap-2 rounded-xl border border-blue-100 bg-blue-50/60 p-3">
              <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                New Download URL
                <Input
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  placeholder="https://example.com/file.mp4?token=…"
                  type="url"
                  disabled={savingUrl}
                  aria-label="New Download URL"
                />
              </label>
              <p className="text-[11px] font-semibold text-slate-500">
                Saving replaces the source URL and restarts the import from the beginning (progress is reset).
              </p>
              {saveError ? <p className="rounded-xl bg-red-50 p-2.5 text-xs font-semibold text-red-700">{saveError}</p> : null}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => { setEditingUrl(false); setSaveError('') }} disabled={savingUrl}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveUrl} disabled={savingUrl || !urlDraft.trim()}>
                  {savingUrl ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {savingUrl ? 'Saving...' : 'Save & restart'}
                </Button>
              </div>
            </div>
          ) : null}
          {details.referer ? (
            <FieldRow
              label="Referer"
              value={details.referer}
              copyLabel="Copy Referer"
              copied={copiedKey === 'referer'}
              onCopy={() => handleCopy('referer', details.referer!)}
            />
          ) : (
            <p className="text-xs font-semibold text-slate-400">Referer — Not attached</p>
          )}
          {details.origin ? (
            <FieldRow
              label="Origin"
              value={details.origin}
              copyLabel="Copy Origin"
              copied={copiedKey === 'origin'}
              onCopy={() => handleCopy('origin', details.origin!)}
            />
          ) : (
            <p className="text-xs font-semibold text-slate-400">Origin — Not attached</p>
          )}
          {details.userAgent ? (
            <FieldRow
              label="User-Agent"
              value={details.userAgent}
              copyLabel="Copy User-Agent"
              copied={copiedKey === 'userAgent'}
              onCopy={() => handleCopy('userAgent', details.userAgent!)}
            />
          ) : (
            <p className="text-xs font-semibold text-slate-400">User-Agent — Not attached</p>
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Lock className="h-3.5 w-3.5 text-slate-400" />Cookie
              </p>
              {details.cookie.attached && !rawCookie ? (
                <Button size="sm" variant="outline" onClick={handleReveal} disabled={revealing}>
                  <Eye className="h-3.5 w-3.5" />{revealing ? 'Revealing...' : 'Reveal'}
                </Button>
              ) : null}
              {rawCookie ? (
                <Button size="sm" variant="outline" onClick={handleHide}>
                  Hide
                </Button>
              ) : null}
            </div>
            {details.cookie.attached ? (
              <p className="mt-1 max-h-32 min-w-0 max-w-full overflow-auto break-words rounded-xl bg-slate-50 p-2.5 text-xs font-semibold text-slate-900 [overflow-wrap:anywhere]">
                {rawCookie ?? details.cookie.masked ?? 'Attached'}
              </p>
            ) : (
              <p className="mt-1 text-xs font-semibold text-slate-400">Not attached</p>
            )}
            {revealError ? <p className="mt-1.5 text-xs font-semibold text-red-600">{revealError}</p> : null}
            {details.cookie.attached && !rawCookie ? (
              <p className="mt-1.5 text-[11px] text-slate-400">Cookie names are shown with values masked. Reveal shows the raw value once.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </DummyModal>
  )
}
