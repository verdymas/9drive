import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CloudDownload, Loader2, Search, Check, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DummyModal } from '@/components/drive/DummyModal'
import { createRemoteImport, probeRemoteUrl, type ProbeResult } from '@/lib/remoteImports'

type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string }
type FolderOption = { id: string; name: string }

type ProbeState =
  | { status: 'idle' }
  | { status: 'detecting' }
  | { status: 'detected'; result: ProbeResult }
  | { status: 'failed'; message: string }

const PROBE_DEBOUNCE_MS = 500

/** Human label for a detected filename's source. */
function sourceLabel(source: ProbeResult['fileNameSource']): string {
  switch (source) {
    case 'content-disposition-filename-star':
    case 'content-disposition-filename':
      return 'Detected from server header'
    case 'final-url-path':
    case 'original-url-path':
      return 'Detected from URL'
    default:
      return 'Generated fallback name'
  }
}

/**
 * Remote Import modal with backend-owned filename detection.
 *
 * While the user types a valid URL, the backend is asked to probe the remote
 * (server-side only — never the browser) after a short debounce. The result
 * fills the File Name field unless the user has manually typed one; a later
 * probe never overwrites a manual edit. Every probe is cancellable and stale
 * responses are ignored, so a slow old probe can never clobber a newer one.
 */
export function RemoteImportModal({
  open,
  onClose,
  onCreated,
  accounts,
  folders,
  defaultFolderId,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  accounts: ConnectedAccount[]
  folders: FolderOption[]
  defaultFolderId?: string | null
}) {
  const [url, setUrl] = useState('')
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? '')
  const [accountId, setAccountId] = useState('')
  const [fileName, setFileName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })

  // The detected name is kept separate from the visible field; the field is
  // only auto-filled while the user has not manually edited it.
  const [detectedFileName, setDetectedFileName] = useState('')
  const [hasUserEditedFileName, setHasUserEditedFileName] = useState(false)

  // A new probe run supersedes any older one; its responses are dropped.
  const probeTokenRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref mirror of hasUserEditedFileName so the probe's async callback reads the
  // LIVE value, never a stale render closure (the probe may resolve long after
  // the render that started it).
  const hasUserEditedRef = useRef(false)

  useEffect(() => {
    if (open) {
      setUrl('')
      setFolderId(defaultFolderId ?? '')
      setAccountId('')
      setFileName('')
      setError('')
      setProbe({ status: 'idle' })
      setDetectedFileName('')
      setHasUserEditedFileName(false)
      hasUserEditedRef.current = false
      probeTokenRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, defaultFolderId])

  // Unmount / close cleanup.
  useEffect(() => {
    return () => {
      probeTokenRef.current += 1
      abortRef.current?.abort()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  async function runProbe(targetUrl: string, token: number) {
    const controller = new AbortController()
    abortRef.current?.abort() // cancel any in-flight probe
    abortRef.current = controller
    setProbe({ status: 'detecting' })
    setError('')
    try {
      const { data } = await probeRemoteUrl(targetUrl, controller.signal)
      if (token !== probeTokenRef.current) return // stale — a newer run started
      setProbe({ status: 'detected', result: data })
      setDetectedFileName(data.fileName)
      // Only auto-fill while the user has not typed their own name — check the
      // live ref, not this render's state snapshot.
      if (!hasUserEditedRef.current) setFileName(data.fileName)
    } catch (err) {
      if (token !== probeTokenRef.current) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      setProbe({ status: 'failed', message: 'File name could not be detected. Enter it manually.' })
    }
  }

  function handleUrlChange(value: string) {
    setUrl(value)
    setError('')
    // A URL change invalidates the previous detection (the old name belongs
    // to a different remote file).
    setDetectedFileName('')
    if (!hasUserEditedFileName) setFileName('')

    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = value.trim()
    // Probe only when the URL looks usable; anything else just clears state.
    if (!trimmed) {
      probeTokenRef.current += 1
      setProbe({ status: 'idle' })
      return
    }
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch {
      probeTokenRef.current += 1
      setProbe({ status: 'idle' })
      return
    }
    const token = probeTokenRef.current
    debounceRef.current = setTimeout(() => {
      void runProbe(trimmed, token)
    }, PROBE_DEBOUNCE_MS)
  }

  function handleFileNameChange(value: string) {
    setFileName(value)
    if (!hasUserEditedRef.current) {
      hasUserEditedRef.current = true
      setHasUserEditedFileName(true)
    }
    // A manual edit clears any detection error (the user took over).
    setProbe((prev) => (prev.status === 'failed' ? { status: 'idle' } : prev))
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!url.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await createRemoteImport({
        url: url.trim(),
        folderId: folderId || null,
        connectedAccountId: accountId || null,
        fileName: fileName.trim() || null,
        detectedFileName: detectedFileName || null,
      })
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start import')
    } finally {
      setSubmitting(false)
    }
  }

  const probeStatus = probe.status
  const probeFailed = probeStatus === 'failed'

  return (
    <DummyModal open={open} title="Import from URL" description="Download a remote file into your storage." onClose={onClose}>
      <form onSubmit={handleSubmit} className="grid gap-4">
        <label className="grid gap-2 text-sm font-semibold">
          File URL
          <Input value={url} onChange={(event) => handleUrlChange(event.target.value)} placeholder="https://example.com/file.pdf" type="url" required />
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          File Name (optional)
          <div className="relative">
            <Input
              value={fileName}
              onChange={(event) => handleFileNameChange(event.target.value)}
              placeholder={probeStatus === 'detecting' ? 'Detecting file name...' : 'Auto-detected from URL'}
              className="pr-10"
            />
            {probeStatus === 'detecting' ? (
              <Loader2 className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-slate-400" />
            ) : null}
          </div>
        </label>
        {probeStatus === 'detecting' ? (
          <p className="flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-sm font-semibold text-blue-700">
            <Search className="h-4 w-4" /> Detecting file name...
          </p>
        ) : null}
        {probeStatus === 'detected' && hasUserEditedFileName ? (
          <p className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">
            <Check className="h-4 w-4" /> {sourceLabel(probe.result.fileNameSource)}: <span className="font-normal">{probe.result.fileName}</span>
          </p>
        ) : null}
        {probeStatus === 'detected' && !hasUserEditedFileName ? (
          <p className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">
            <Check className="h-4 w-4" /> {sourceLabel(probe.result.fileNameSource)}
          </p>
        ) : null}
        {probeFailed ? (
          <p className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-700">
            <AlertTriangle className="h-4 w-4" /> File name could not be detected. Enter it manually.
          </p>
        ) : null}
        {error ? <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}
        <label className="grid gap-2 text-sm font-semibold">
          Destination Folder
          <select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
            <option value="">No folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>{folder.name}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          Storage Account
          <select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">Automatic (recommended)</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.email || account.displayName || account.id} ({account.provider === 's3' ? 'S3' : 'Google Drive'})
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 pt-2 sm:flex sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={submitting || !url.trim()}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
            {submitting ? 'Starting...' : 'Start Import'}
          </Button>
        </div>
      </form>
    </DummyModal>
  )
}
