import { useEffect, useState } from 'react'
import { Check, Copy, Eye, Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DummyModal } from '@/components/drive/DummyModal'
import { getRemoteImportRequestContext, type RemoteImportRequestContextDetails } from '@/lib/remoteImports'

type Props = {
  importId: string | null
  fileName?: string | null
  onClose: () => void
}

function FieldRow({
  label,
  value,
  copyLabel,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copyLabel: string
  copied: boolean
  onCopy?: () => void
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
        {onCopy ? (
          <Button size="sm" variant="outline" onClick={onCopy} aria-label={copyLabel}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        ) : null}
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
export function RequestContextDialog({ importId, fileName, onClose }: Props) {
  const [details, setDetails] = useState<RemoteImportRequestContextDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revealing, setRevealing] = useState(false)
  const [revealError, setRevealError] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => {
    if (!importId) {
      // Dialog closed — drop any sensitive detail state immediately.
      setDetails(null)
      setError('')
      setRevealError('')
      setRevealing(false)
      setCopiedKey(null)
      return
    }
    let cancelled = false
    setDetails(null)
    setError('')
    setRevealError('')
    setRevealing(false)
    setCopiedKey(null)
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
  }, [importId])

  // Extra safety: clear sensitive state on unmount (dialog lifecycle only).
  useEffect(() => {
    return () => {
      setDetails(null)
    }
  }, [])

  function handleClose() {
    setDetails(null)
    setError('')
    setRevealError('')
    setRevealing(false)
    setCopiedKey(null)
    onClose()
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
