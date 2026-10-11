import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Eye, Loader2, Lock, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DummyModal } from '@/components/drive/DummyModal'
import { getRemoteImportRequestContext, updateRemoteImportDownloadUrl, type RemoteImportRequestContextDetails } from '@/lib/remoteImports'
import { workerStatusLabel, type WorkerItem } from '@/lib/workers'

type Props = {
  importId: string | null
  fileName?: string | null
  /** True when the import is failed/cancelled/queued — URL + context are editable. */
  editable?: boolean
  /** The import's current network route (null = Direct). Shown as Network Route. */
  currentWorkerId?: string | null
  /** Selectable workers (enabled, ready) for the Network Route editor. */
  workers?: WorkerItem[]
  /** Called after a save so the parent can refresh the list. */
  onSaved?: () => void
  onClose: () => void
}

type EditableField = 'url' | 'referer' | 'origin' | 'userAgent' | 'cookie' | 'worker'

type TextField = Exclude<EditableField, 'worker'>

const FIELD_META: Record<TextField, { title: string; placeholder: string; secret?: boolean }> = {
  url: { title: 'New Download URL', placeholder: 'https://example.com/file.mp4?token=…' },
  referer: { title: 'New Referer', placeholder: 'https://watch.example/page' },
  origin: { title: 'New Origin', placeholder: 'https://watch.example' },
  userAgent: { title: 'New User-Agent', placeholder: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)…' },
  cookie: { title: 'New Cookie', placeholder: 'session=…', secret: true },
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
export function RequestContextDialog({ importId, fileName, editable, currentWorkerId, workers, onSaved, onClose }: Props) {
  const [details, setDetails] = useState<RemoteImportRequestContextDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revealing, setRevealing] = useState(false)
  const [revealError, setRevealError] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<EditableField | null>(null)
  const [fieldDraft, setFieldDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const workerOptions = workers ?? []
  const currentWorkerName = currentWorkerId
    ? (workerOptions.find((w) => w.id === currentWorkerId)?.name ?? 'Previous worker (unavailable)')
    : 'Direct / No Worker'

  function resetTransientState() {
    setDetails(null)
    setError('')
    setRevealError('')
    setRevealing(false)
    setCopiedKey(null)
    setEditingField(null)
    setFieldDraft('')
    setSaving(false)
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

  /** Prefill the editor: URL from details, headers from details, cookie empty (never prefill a secret). */
  function startEdit(field: EditableField) {
    const prefill =
      field === 'url' ? (details?.downloadUrl ?? '')
      : field === 'referer' ? (details?.referer ?? '')
      : field === 'origin' ? (details?.origin ?? '')
      : field === 'userAgent' ? (details?.userAgent ?? '')
      : field === 'worker' ? (currentWorkerId ?? '')
      : ''
    setFieldDraft(prefill)
    setSaveError('')
    setEditingField(field)
  }

  /**
   * Save one field and auto-restart the import. An empty draft clears the
   * context field (patch `null`); URL requires a non-empty value. Worker
   * sends `{ workerId }` (empty = Direct).
   */
  async function handleSaveField() {
    if (!importId || !editingField) return
    const next = fieldDraft.trim()
    if (editingField === 'url' && !next) {
      setSaveError('Enter a URL.')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const patch =
        editingField === 'url'
          ? { url: next }
          : editingField === 'worker'
            ? { workerId: next ? next : null }
            : { requestContext: { [editingField]: next ? next : null } as Record<Exclude<EditableField, 'url' | 'worker'>, string | null> }
      await updateRemoteImportDownloadUrl(importId, patch)
      setEditingField(null)
      // Re-fetch so the dialog shows the saved value; parent refreshes the list.
      const data = await getRemoteImportRequestContext(importId)
      setDetails(data)
      onSaved?.()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
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
      title={editable ? 'Download Details' : 'Request Context'}
      description={fileName ?? 'Headers attached to this import for protected sources.'}
      onClose={handleClose}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 p-6 text-sm font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />Loading request context...
        </div>
      ) : error ? (
        <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>
      ) : details ? (
        <div className="grid min-w-0 gap-4">
          {!details.attached ? (
            <p className="rounded-xl bg-slate-50 p-3 text-sm font-semibold text-slate-500">No request context attached to this import.</p>
          ) : null}
          {details.downloadUrl ? (
            <FieldRow
              label="Download URL"
              value={details.downloadUrl}
              copyLabel="Copy Download URL"
              copied={copiedKey === 'downloadUrl'}
              onCopy={() => handleCopy('downloadUrl', details.downloadUrl!)}
              action={editable && !editingField ? (
                <Button size="sm" variant="outline" onClick={() => startEdit('url')} aria-label="Edit Download URL">
                  <Pencil className="h-3.5 w-3.5" />Edit
                </Button>
              ) : undefined}
            />
          ) : (
            <p className="text-xs font-semibold text-slate-400">Download URL — Not available</p>
          )}
          {editingField ? (
            <div className="grid min-w-0 gap-2 rounded-xl border border-blue-100 bg-blue-50/60 p-3">
              {editingField === 'worker' ? (
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  New Network Route
                  <select
                    className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                    value={fieldDraft}
                    onChange={(event) => setFieldDraft(event.target.value)}
                    disabled={saving}
                    aria-label="New Network Route"
                  >
                    <option value="">Direct / No Worker</option>
                    {workerOptions.map((worker) => (
                      <option key={worker.id} value={worker.id}>
                        {worker.name} — {workerStatusLabel(worker.status)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  {FIELD_META[editingField].title}
                  <Input
                    value={fieldDraft}
                    onChange={(event) => setFieldDraft(event.target.value)}
                    placeholder={FIELD_META[editingField].placeholder}
                    type={FIELD_META[editingField].secret ? 'password' : editingField === 'url' ? 'url' : 'text'}
                    autoComplete="off"
                    disabled={saving}
                    aria-label={FIELD_META[editingField].title}
                  />
                </label>
              )}
              <p className="text-[11px] font-semibold text-slate-500">
                {editingField === 'url'
                  ? 'Saving replaces the source URL and restarts the import from the beginning (progress is reset).'
                  : editingField === 'worker'
                    ? 'Saving switches the network route and restarts the import from the beginning (progress is reset).'
                    : 'Saving updates this header and restarts the import from the beginning (progress is reset). Leave empty to remove it.'}
              </p>
              {saveError ? <p className="rounded-xl bg-red-50 p-2.5 text-xs font-semibold text-red-700">{saveError}</p> : null}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => { setEditingField(null); setSaveError('') }} disabled={saving}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveField}
                  disabled={
                    saving ||
                    (editingField === 'url' && !fieldDraft.trim()) ||
                    (editingField === 'worker' && fieldDraft === (currentWorkerId ?? ''))
                  }
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {saving ? 'Saving...' : editingField !== 'url' && editingField !== 'worker' && !fieldDraft.trim() ? 'Remove & restart' : 'Save & restart'}
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
              action={editable && !editingField ? (
                <Button size="sm" variant="outline" onClick={() => startEdit('referer')} aria-label="Edit Referer">
                  <Pencil className="h-3.5 w-3.5" />Edit
                </Button>
              ) : undefined}
            />
          ) : (
            <div className="flex min-w-0 items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-400">Referer — Not attached</p>
              {editable && !editingField ? (
                <Button size="sm" variant="outline" onClick={() => startEdit('referer')} aria-label="Add Referer">
                  <Pencil className="h-3.5 w-3.5" />Add
                </Button>
              ) : null}
            </div>
          )}
          {details.origin ? (
            <FieldRow
              label="Origin"
              value={details.origin}
              copyLabel="Copy Origin"
              copied={copiedKey === 'origin'}
              onCopy={() => handleCopy('origin', details.origin!)}
              action={editable && !editingField ? (
                <Button size="sm" variant="outline" onClick={() => startEdit('origin')} aria-label="Edit Origin">
                  <Pencil className="h-3.5 w-3.5" />Edit
                </Button>
              ) : undefined}
            />
          ) : (
            <div className="flex min-w-0 items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-400">Origin — Not attached</p>
              {editable && !editingField ? (
                <Button size="sm" variant="outline" onClick={() => startEdit('origin')} aria-label="Add Origin">
                  <Pencil className="h-3.5 w-3.5" />Add
                </Button>
              ) : null}
            </div>
          )}
          {details.userAgent ? (
            <FieldRow
              label="User-Agent"
              value={details.userAgent}
              copyLabel="Copy User-Agent"
              copied={copiedKey === 'userAgent'}
              onCopy={() => handleCopy('userAgent', details.userAgent!)}
              action={editable && !editingField ? (
                <Button size="sm" variant="outline" onClick={() => startEdit('userAgent')} aria-label="Edit User-Agent">
                  <Pencil className="h-3.5 w-3.5" />Edit
                </Button>
              ) : undefined}
            />
          ) : (
            <div className="flex min-w-0 items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-400">User-Agent — Not attached</p>
              {editable && !editingField ? (
                <Button size="sm" variant="outline" onClick={() => startEdit('userAgent')} aria-label="Add User-Agent">
                  <Pencil className="h-3.5 w-3.5" />Add
                </Button>
              ) : null}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Lock className="h-3.5 w-3.5 text-slate-400" />Cookie
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                {editable && details.cookie.attached && !editingField ? (
                  <Button size="sm" variant="outline" onClick={() => startEdit('cookie')} aria-label="Edit Cookie">
                    <Pencil className="h-3.5 w-3.5" />Edit
                  </Button>
                ) : null}
                {editable && !details.cookie.attached && !editingField ? (
                  <Button size="sm" variant="outline" onClick={() => startEdit('cookie')} aria-label="Add Cookie">
                    <Pencil className="h-3.5 w-3.5" />Add
                  </Button>
                ) : null}
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
          <div className="min-w-0">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Network Route</p>
              {editable && !editingField ? (
                <Button size="sm" variant="outline" onClick={() => startEdit('worker')} aria-label="Edit Network Route">
                  <Pencil className="h-3.5 w-3.5" />Edit
                </Button>
              ) : null}
            </div>
            <p className="mt-1 min-w-0 truncate rounded-xl bg-slate-50 p-2.5 text-xs font-semibold text-slate-900" title={currentWorkerName}>
              {currentWorkerName}
            </p>
          </div>
        </div>
      ) : null}
    </DummyModal>
  )
}
