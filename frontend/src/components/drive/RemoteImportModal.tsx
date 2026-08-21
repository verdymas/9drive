import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CloudDownload, Loader2, Search, Check, AlertTriangle, Radio, MonitorPlay, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible } from '@/components/ui/collapsible'
import { DummyModal } from '@/components/drive/DummyModal'
import {
  createRemoteImport,
  parseCurl,
  probeRemoteUrl,
  type HlsImportOptions,
  type ParsedCurlResult,
  type ProbeResult,
  type RequestContextInput,
} from '@/lib/remoteImports'
import { workerStatusLabel, type WorkerItem } from '@/lib/workers'

const RECORDING_MIN_SECONDS = 60
const RECORDING_MAX_SECONDS = 21600

type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string; autoAllocationEnabled: boolean }
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
      return 'The source server rejected access to the HLS manifest. If the source requires access headers, open Advanced Request Options below.'
    case 'HLS_MANIFEST_NOT_FOUND':
    case 'HLS_MANIFEST_TIMEOUT':
    case 'HLS_MANIFEST_FETCH_FAILED':
      return 'The HLS manifest could not be read.'
    case 'REMOTE_SOURCE_AUTHENTICATION_REQUIRED':
      return 'The source requires authentication. Try another URL.'
    case 'REMOTE_SOURCE_ACCESS_EXPIRED':
      return 'The source URL or request context may have expired. Capture a fresh media request and try again.'
    case 'HLS_CHILD_AUTHENTICATION_REQUIRED':
      return 'An HLS child resource requires different access credentials. Use the source host for all media or capture a fresh request.'
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

type CurlParseState =
  | { status: 'idle' }
  | { status: 'parsing' }
  | { status: 'ok'; result: ParsedCurlResult }
  | { status: 'failed'; message: string }

/** Parse-error messages keyed by the backend's stable codes (§30). */
function curlParseErrorMessage(code: string | undefined): string | null {
  switch (code) {
    case 'REMOTE_IMPORT_CURL_MULTIPLE_URLS':
      return 'Paste a cURL command with a single URL.'
    case 'REMOTE_IMPORT_CURL_UNSAFE_OPTION':
      return 'The pasted cURL command uses an option that is not supported.'
    case 'REMOTE_IMPORT_HEADER_VALUE_INVALID':
      return 'A request context value is invalid.'
    default:
      return null
  }
}

/** Label for a detected cURL field; used for the summary chips (§33). */
function curlChipLabel(field: 'url' | 'referer' | 'origin' | 'userAgent' | 'cookie'): string {
  switch (field) {
    case 'url': return 'URL'
    case 'referer': return 'Referer'
    case 'origin': return 'Origin'
    case 'userAgent': return 'User-Agent'
    case 'cookie': return 'Cookie'
  }
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
  workers,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  accounts: ConnectedAccount[]
  folders: FolderOption[]
  defaultFolderId?: string | null
  /** Enabled Remote Fetch Workers for Network Route selection (spec §25). */
  workers: WorkerItem[]
}) {
  const [mode, setMode] = useState<'url' | 'curl'>('url')
  const [url, setUrl] = useState('')
  const [curlInput, setCurlInput] = useState('')
  const [curlParse, setCurlParse] = useState<CurlParseState>({ status: 'idle' })
  // Advanced Request Options (URL mode): optional access headers for protected
  // sources. Values are sent to the backend once and never echoed back.
  const [context, setContext] = useState<RequestContextInput>({})
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? '')
  const [accountId, setAccountId] = useState('')
  // Network Route: '' = Direct / no relay; otherwise the selected worker id.
  // Preselects the enabled default worker when one exists (spec §26), and the
  // user can override or return to Direct.
  const [workerId, setWorkerId] = useState('')
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
  const curlDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref mirror of hasUserEditedFileName so the probe's async callback reads the
  // LIVE value, never a stale render closure (the probe may resolve long after
  // the render that started it).
  const hasUserEditedRef = useRef(false)
  // Ref mirror of the request context for the same reason — the probe fires
  // 500ms after the last keystroke and must see the current field values.
  const contextRef = useRef<RequestContextInput>({})
  const workerIdRef = useRef('')

  function updateContext(patch: Partial<RequestContextInput>) {
    const next = { ...contextRef.current, ...patch }
    contextRef.current = next
    setContext(next)
    // Context is part of the probe's input: a changed header may flip the
    // source from forbidden to accessible (or vice versa), so re-probe.
    setError('')
    if (url.trim()) handleUrlChange(url)
  }

  useEffect(() => {
    if (open) {
      setMode('url')
      setUrl('')
      setCurlInput('')
      setCurlParse({ status: 'idle' })
      setContext({})
      setFolderId(defaultFolderId ?? '')
      setAccountId('')
      const defaultWorkerId = workers.find((worker) => worker.isDefault)?.id ?? ''
      setWorkerId(defaultWorkerId)
      workerIdRef.current = defaultWorkerId
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
      if (curlDebounceRef.current) clearTimeout(curlDebounceRef.current)
    }
  }, [open, defaultFolderId, workers])

  // Unmount / close cleanup.
  useEffect(() => {
    return () => {
      probeTokenRef.current += 1
      abortRef.current?.abort()
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (curlDebounceRef.current) clearTimeout(curlDebounceRef.current)
    }
  }, [])

  async function runProbe(targetUrl: string, token: number) {
    const controller = new AbortController()
    abortRef.current?.abort() // cancel any in-flight probe
    abortRef.current = controller
    setProbe({ status: 'detecting' })
    setError('')
    try {
      // Pass the currently-entered request context and selected worker (generic transport)
      const { data } = await probeRemoteUrl(targetUrl, controller.signal, contextRef.current, workerIdRef.current || null)
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
      abortRef.current?.abort()
      abortRef.current = null
      setProbe({ status: 'idle' })
      return
    }
    // Invalidate any previous probe and abort it so a route change (direct→worker)
    // never leaves a direct source request in flight while the debounced worker
    // probe is pending. The new probe will read the current workerIdRef at execution time.
    probeTokenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    const token = probeTokenRef.current
    debounceRef.current = setTimeout(() => {
      void runProbe(trimmed, token)
    }, PROBE_DEBOUNCE_MS)
  }

  // Keep workerId ref in sync and re-probe when Network Route changes (generic transport switch)
  // The selected transport must be used from the first probe, not only during download.
  // No hard-coded driver checks — the backend resolves workerId → driver → transport.
  // handleUrlChange aborts any in-flight probe and invalidates its token, so a
  // direct→worker switch never leaves a direct source request in flight.
  useEffect(() => {
    workerIdRef.current = workerId
    if (open && mode === 'url' && url.trim()) {
      handleUrlChange(url)
    }
  }, [workerId, open, mode, url])

  function handleFileNameChange(value: string) {
    setFileName(value)
    if (!hasUserEditedRef.current) {
      hasUserEditedRef.current = true
      setHasUserEditedFileName(true)
    }
    // A manual edit clears any detection error (the user took over).
    setProbe((prev) => (prev.status === 'failed' ? { status: 'idle' } : prev))
  }

  function handleModeChange(next: 'url' | 'curl') {
    setMode(next)
    setError('')
    setProbe({ status: 'idle' })
    setHlsOptions(null)
    // Cancel any in-flight probe; the other mode's input drives its own probe.
    probeTokenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
  }

  /**
   * cURL mode: the backend parses the command (authoritative, spec §19) after a
   * debounce and returns the URL + boolean context summary. Nothing here is
   * executed, and no header value is ever shown back to the user.
   */
  async function handleCurlChange(value: string) {
    setCurlInput(value)
    setError('')
    const trimmed = value.trim()
    if (curlDebounceRef.current) clearTimeout(curlDebounceRef.current)
    if (!trimmed) {
      setCurlParse({ status: 'idle' })
      return
    }
    // Parse as the user types — but never block on a keystroke; debounce and
    // let the latest input win (a stale parse can't clobber a newer one).
    const token = ++probeTokenRef.current
    curlDebounceRef.current = setTimeout(() => {
      setCurlParse({ status: 'parsing' })
      parseCurl(trimmed)
        .then(({ data }) => {
          if (token !== probeTokenRef.current) return // stale
          setCurlParse({ status: 'ok', result: data })
        })
        .catch((err: unknown) => {
          if (token !== probeTokenRef.current) return // stale
          const code = (err as Error & { code?: string }).code
          setCurlParse({ status: 'failed', message: curlParseErrorMessage(code) ?? 'The pasted cURL command could not be parsed.' })
        })
    }, PROBE_DEBOUNCE_MS)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmedUrl = url.trim()
    if (mode === 'url' && !trimmedUrl) return
    if (mode === 'curl' && !curlInput.trim()) return

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
      if (mode === 'curl') {
        // The server re-parses the raw command (spec §19 — the backend is
        // authoritative); the client preview is display-only.
        await createRemoteImport({
          sourceMode: 'curl',
          curl: curlInput.trim(),
          folderId: folderId || null,
          connectedAccountId: accountId || null,
          workerId: workerId || undefined,
          fileName: fileName.trim() || null,
          detectedFileName: detectedFileName || null,
          hls: hlsOptions ?? undefined,
        })
      } else {
        const attached = Object.values(contextRef.current).some((v) => v != null && v !== '')
        await createRemoteImport({
          sourceMode: 'url',
          url: trimmedUrl,
          folderId: folderId || null,
          connectedAccountId: accountId || null,
          workerId: workerId || undefined,
          fileName: fileName.trim() || null,
          detectedFileName: detectedFileName || null,
          // Direct files send no `hls` field at all (the backend schema accepts
          // `null` too, but the wire must not carry it for non-HLS sources).
          hls: hlsOptions ?? undefined,
          requestContext: attached ? contextRef.current : undefined,
        })
      }
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
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => handleModeChange('url')}
            aria-pressed={mode === 'url'}
            className={`rounded-lg px-3 py-2 text-sm font-bold transition ${mode === 'url' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            URL
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('curl')}
            aria-pressed={mode === 'curl'}
            className={`rounded-lg px-3 py-2 text-sm font-bold transition ${mode === 'curl' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            cURL
          </button>
        </div>

        {mode === 'url' ? (
          <>
            <label className="grid gap-2 text-sm font-semibold">
              File URL
              <Input value={url} onChange={(event) => handleUrlChange(event.target.value)} placeholder="https://example.com/file.pdf" type="url" required />
            </label>
            <Collapsible title="Advanced Request Options">
              <p className="rounded-xl bg-slate-50 p-2.5 text-xs font-semibold text-slate-500">
                Some protected sources require access headers (Referer, Origin, User-Agent or Cookie) to serve media. These are sent only to the source host and are never shown again after creation.
              </p>
              <label className="grid gap-1.5 text-sm font-semibold">
                Referer
                <Input
                  value={context.referer ?? ''}
                  onChange={(event) => updateContext({ referer: event.target.value })}
                  placeholder="https://watch.example/page"
                  type="url"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                Origin
                <Input
                  value={context.origin ?? ''}
                  onChange={(event) => updateContext({ origin: event.target.value })}
                  placeholder="https://watch.example"
                  type="url"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                User-Agent
                <Input
                  value={context.userAgent ?? ''}
                  onChange={(event) => updateContext({ userAgent: event.target.value })}
                  placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64)…"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                Cookie
                <Input
                  value={context.cookie ?? ''}
                  onChange={(event) => updateContext({ cookie: event.target.value })}
                  placeholder="session=…"
                  type="password"
                  autoComplete="off"
                />
              </label>
            </Collapsible>
          </>
        ) : (
          <>
            <label className="grid gap-2 text-sm font-semibold">
              cURL Command
              <Textarea
                value={curlInput}
                onChange={(event) => handleCurlChange(event.target.value)}
                placeholder="curl 'https://example.com/video.m3u8' -H 'Referer: https://site.example/watch/1' -H 'Cookie: session=…'"
                className="font-mono text-xs"
                spellCheck={false}
                rows={5}
                aria-label="cURL command"
              />
            </label>
            <p className="text-xs font-semibold text-slate-500">
              Paste a cURL request from your browser's network tab. Only the URL and Referer / Origin / User-Agent / Cookie headers are used; everything else is rejected. The command is parsed by the server and never executed.
            </p>
            {curlParse.status === 'parsing' ? (
              <p className="flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-sm font-semibold text-blue-700">
                <Loader2 className="h-4 w-4 animate-spin" /> Parsing command…
              </p>
            ) : null}
            {curlParse.status === 'ok' ? (
              <div className="grid gap-2 rounded-xl bg-emerald-50 p-3">
                <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700">
                  <Check className="h-4 w-4" /> Command parsed
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">URL detected</span>
                  {(['referer', 'origin', 'userAgent', 'cookie'] as const).map((field) =>
                    curlParse.result.requestContext[field] ? (
                      <span key={field} className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                        {curlChipLabel(field)} detected
                      </span>
                    ) : null,
                  )}
                </div>
              </div>
            ) : null}
            {curlParse.status === 'failed' ? (
              <p className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-700">
                <XCircle className="h-4 w-4" /> {curlParse.message}
              </p>
            ) : null}
          </>
        )}
        {/* Network Route: Direct by default; an enabled default worker is
            preselected (§26) and the user can override per import (§25). */}
        <label className="grid gap-2 text-sm font-semibold">
          Network Route
          <select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={workerId} onChange={(event) => setWorkerId(event.target.value)}>
            <option value="">Direct / No Worker</option>
            {workers.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.name} — {workerStatusLabel(worker.status)}
              </option>
            ))}
          </select>
          {workers.length === 0 ? (
            <p className="text-xs text-slate-500">No workers registered — imports run directly from 9Drive.</p>
          ) : null}
          {workerId && workers.find((worker) => worker.id === workerId)?.status === 'unhealthy' ? (
            <p className="flex items-center gap-1.5 rounded-xl bg-amber-50 p-2.5 text-sm font-semibold text-amber-700">
              <AlertTriangle className="h-4 w-4" /> This worker last reported unhealthy — the import may fail.
            </p>
          ) : null}
          {workerId && workers.find((worker) => worker.id === workerId)?.status === 'unknown' ? (
            <p className="text-xs text-slate-500">This worker has not been tested yet.</p>
          ) : null}
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
        {accountId && accounts.find((account) => account.id === accountId)?.autoAllocationEnabled === false ? (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Automatic allocation is disabled for this account. You selected this account manually, so the file can still be stored here.</p>
        ) : null}
        <div className="grid gap-3 pt-2 sm:flex sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={submitting || (mode === 'url' ? !url.trim() : !curlInput.trim())}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
            {submitting ? 'Starting...' : 'Start Import'}
          </Button>
        </div>
      </form>
    </DummyModal>
  )
}
