import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CloudDownload, Loader2, Search, Check, AlertTriangle, Radio, MonitorPlay } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { DummyModal } from '@/components/drive/DummyModal'
import { createRemoteImport, probeRemoteUrl, type HlsImportOptions, type ProbeResult } from '@/lib/remoteImports'

const RECORDING_MIN_SECONDS = 60
const RECORDING_MAX_SECONDS = 21600

type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string }
type FolderOption = { id: string; name: string }

type ProbeState =
  | { status: 'idle' }
  | { status: 'detecting' }
  | { status: 'detected'; result: ProbeResult }
  | { status: 'failed'; message: string }

const PROBE_DEBOUNCE_MS = 500

/**
 * Safe, human-readable probe messages keyed by the backend's stable error
 * code. Raw Zod/schema text, stack traces, internal IPs or signed URLs must
 * never reach the user.
 */
function probeErrorMessage(code: string | undefined): string | null {
  switch (code) {
    case 'HLS_MANIFEST_FORBIDDEN':
      return 'The source server rejected access to the HLS manifest.'
    case 'HLS_MANIFEST_NOT_FOUND':
    case 'HLS_MANIFEST_TIMEOUT':
    case 'HLS_MANIFEST_FETCH_FAILED':
      return 'The HLS manifest could not be read.'
    case 'REMOTE_SOURCE_AUTHENTICATION_REQUIRED':
      return 'The HLS source requires authentication. Try another URL.'
    case 'HLS_INVALID_MANIFEST':
      return 'The source does not appear to be a valid HLS playlist.'
    default:
      return null
  }
}

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
 * Human duration like "01:00:00". Returns a neutral placeholder for null/NaN.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * The HLS-specific controls in the Remote Import modal (§13, §14, §21).
 *
 * Rendered only after a probe classified the source as HLS (`probe.result.hls`
 * is non-null). Layout:
 *   - a "HLS Video" badge with the playlist kind,
 *   - Quality (optional — only when >1 variant),
 *   - Audio Track (only when >1 audio rendition),
 *   - Output Format (Auto / MKV / MP4),
 *   - live/event sources additionally require a Recording Duration, which the
 *     server enforces between 60 and 21600 seconds.
 *
 * The recorded selections are returned in `onChange` so the parent can send
 * them in the create request's `hls` field.
 */
export function HlsSection({
  hls,
  value,
  onChange,
}: {
  hls: NonNullable<ProbeResult['hls']>
  value: HlsImportOptions
  onChange: (next: HlsImportOptions) => void
}) {
  const isLive = hls.isFinite === false
  const variants = hls.variants
  const tracks = hls.audioTracks

  return (
    <fieldset className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
      <legend className="sr-only">HLS options</legend>
      <p className="flex flex-wrap items-center gap-2 text-sm font-extrabold text-slate-800">
        <Radio className="h-4 w-4 text-blue-600" />
        HLS Video
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-blue-700">
          {hls.playlistType}
        </span>
      </p>

      {isLive ? (
        <p className="rounded-xl bg-amber-50 p-2.5 text-xs font-semibold text-amber-800">
          Live HLS stream detected. A recording duration is required.
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
          <MonitorPlay className="h-4 w-4" />
          {variants.length > 1 ? `${variants.length} quality levels available` : 'Single quality level'}
          {hls.durationSeconds != null && hls.durationSeconds > 0 ? ` · ${formatDuration(hls.durationSeconds)}` : ''}
        </p>
      )}

      {variants.length > 1 ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Quality
          <Select
            value={value.variantId ?? 'auto'}
            onChange={(event) => onChange({ ...value, variantId: event.target.value === 'auto' ? undefined : event.target.value })}
          >
            <option value="auto">Automatic (best available)</option>
            {variants.map((variant) => (
              <option key={variant.id} value={variant.id}>{variant.label}</option>
            ))}
          </Select>
        </label>
      ) : null}

      {tracks.length > 1 ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Audio Track
          <Select
            value={value.audioTrackId ?? 'auto'}
            onChange={(event) => onChange({ ...value, audioTrackId: event.target.value === 'auto' ? undefined : event.target.value })}
          >
            <option value="auto">Auto (default)</option>
            {tracks.map((track) => (
              <option key={track.id} value={track.id}>{track.name || track.language || 'Audio'}</option>
            ))}
          </Select>
        </label>
      ) : null}

      <label className="grid gap-1.5 text-sm font-semibold">
        Output Format
        <Select
          value={value.outputContainer ?? 'auto'}
          onChange={(event) => onChange({ ...value, outputContainer: event.target.value as HlsImportOptions['outputContainer'] })}
        >
          <option value="auto">Automatic (MKV)</option>
          <option value="mkv">MKV</option>
          <option value="mp4">MP4</option>
        </Select>
        {value.outputContainer === 'auto' ? (
          <span className="text-xs font-normal text-gray-500">Automatic uses MKV for maximum compatibility.</span>
        ) : null}
      </label>

      {isLive ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Recording Duration
          <Input
            type="number"
            min={RECORDING_MIN_SECONDS}
            max={RECORDING_MAX_SECONDS}
            step="1"
            value={value.recordingDurationSeconds ?? ''}
            onChange={(event) => {
              const raw = Number(event.target.value)
              onChange({ ...value, recordingDurationSeconds: Number.isInteger(raw) && raw > 0 ? raw : undefined })
            }}
            placeholder={`${RECORDING_MIN_SECONDS} – ${RECORDING_MAX_SECONDS} seconds`}
          />
          <span className="text-xs font-normal text-slate-400">
            {formatDuration(value.recordingDurationSeconds)} recording (between {RECORDING_MIN_SECONDS} and {RECORDING_MAX_SECONDS} seconds)
          </span>
        </label>
      ) : null}
    </fieldset>
  )
}

/**
 * Remote Import modal with backend-owned filename detection + HLS support.
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

  // HLS import options, populated from the probe when the source is HLS. Kept
  // across URL edits so a user's selections survive a repaint, but cleared when
  // the modal closes and when the probe says "not HLS".
  const [hlsOptions, setHlsOptions] = useState<HlsImportOptions | null>(null)

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
      setHlsOptions(null)
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
      // HLS sources expose variant/audio/format controls. Start from `auto`
      // everywhere; the user can override. Reset only when the classification
      // changed (a new URL), never on every probe repaint.
      if (data.sourceType === 'hls_master' || data.sourceType === 'hls_media') {
        const sourceType = data.sourceType
        setHlsOptions((prev) => ({
          sourceType,
          isLive: data.hls?.isFinite === false,
          outputContainer: prev?.outputContainer ?? 'auto',
          variantId: prev?.variantId,
          audioTrackId: prev?.audioTrackId,
          recordingDurationSeconds: prev?.recordingDurationSeconds,
        }))
      } else {
        setHlsOptions(null)
      }
      // Only auto-fill while the user has not typed their own name — check the
      // live ref, not this render's state snapshot.
      if (!hasUserEditedRef.current) setFileName(data.fileName)
    } catch (err) {
      if (token !== probeTokenRef.current) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      const code = (err as Error & { code?: string }).code
      setProbe({
        status: 'failed',
        message: probeErrorMessage(code) ?? 'File name could not be detected. Enter it manually.',
      })
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

    // Client-side mirror of the server's §19 rule: a live source without a
    // recording duration is pointless, and a finite source must not carry one.
    const live = hlsOptions?.isLive === true
    if (live && hlsOptions.recordingDurationSeconds == null) {
      setError('Recording duration is required for a live HLS stream.')
      return
    }
    if (!live && hlsOptions?.recordingDurationSeconds != null) {
      setHlsOptions({ ...hlsOptions, recordingDurationSeconds: undefined })
    }

    // Client-side mirror of the server's §4 rule: when the user typed an
    // explicit filename whose extension contradicts the selected output
    // container, block submission and tell them — the name displayed in this
    // modal must be the name ultimately uploaded. Only HLS imports with an
    // explicit container set are checked.
    const trimmedName = fileName.trim()
    const outputContainer = hlsOptions?.outputContainer
    if (hlsOptions && outputContainer && outputContainer !== 'auto' && trimmedName) {
      const explicit = trimmedName.match(/\.([a-zA-Z0-9]{1,8})$/)
      if (explicit && !/^\.(m3u8|m3u)$/i.test(explicit[0])) {
        const given = explicit[1].toLowerCase()
        if (given !== outputContainer) {
          setError(`The file name extension (.${given}) must match the selected output format (${outputContainer.toUpperCase()}).`)
          return
        }
      }
    }

    setSubmitting(true)
    setError('')
    try {
      await createRemoteImport({
        url: url.trim(),
        folderId: folderId || null,
        connectedAccountId: accountId || null,
        fileName: fileName.trim() || null,
        detectedFileName: detectedFileName || null,
        // Direct files send no `hls` field at all (the backend schema accepts
        // `null` too, but the wire must not carry it for non-HLS sources).
        hls: hlsOptions ?? undefined,
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
            <AlertTriangle className="h-4 w-4" /> {probe.status === 'failed' ? probe.message : 'File name could not be detected. Enter it manually.'}
          </p>
        ) : null}
        {error ? <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}
        {probeStatus === 'detected' && probe.result.hls ? (
          <HlsSection
            hls={probe.result.hls}
            value={hlsOptions ?? { sourceType: probe.result.sourceType as 'hls_master' | 'hls_media', isLive: probe.result.hls.isFinite === false }}
            onChange={setHlsOptions}
          />
        ) : null}
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
