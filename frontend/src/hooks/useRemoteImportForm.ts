import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createRemoteImport,
  parseCurl,
  probeRemoteUrl,
  type HlsImportOptions,
  type ParsedCurlResult,
  type ProbeResult,
  type RequestContextInput,
} from '@/lib/remoteImports'
import { type WorkerItem } from '@/lib/workers'

export type ProbeState =
  | { status: 'idle' }
  | { status: 'detecting' }
  | { status: 'detected'; result: ProbeResult }
  | { status: 'failed'; message: string }

export type CurlParseState =
  | { status: 'idle' }
  | { status: 'parsing' }
  | { status: 'ok'; result: ParsedCurlResult }
  | { status: 'failed'; message: string }

const PROBE_DEBOUNCE_MS = 500

/** Safe user-facing messages for stable backend probe error codes. */
export function probeErrorMessage(code: string | undefined): string | null {
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

/** Safe user-facing messages for stable cURL parser error codes. */
export function curlParseErrorMessage(code: string | undefined): string | null {
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

export type RemoteImportFormOptions = {
  open: boolean
  onClose: () => void
  onCreated: () => void
  defaultFolderId?: string | null
  workers: WorkerItem[]
}

export function useRemoteImportForm({ open, onClose, onCreated, defaultFolderId, workers }: RemoteImportFormOptions) {
  const [mode, setMode] = useState<'url' | 'curl'>('url')
  const [url, setUrl] = useState('')
  const [curlInput, setCurlInput] = useState('')
  const [curlParse, setCurlParse] = useState<CurlParseState>({ status: 'idle' })
  const [context, setContext] = useState<RequestContextInput>({})
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? '')
  const [accountId, setAccountId] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [fileName, setFileName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  const [hlsOptions, setHlsOptions] = useState<HlsImportOptions | null>(null)
  const [detectedFileName, setDetectedFileName] = useState('')
  const [hasUserEditedFileName, setHasUserEditedFileName] = useState(false)

  const probeTokenRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const curlDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasUserEditedRef = useRef(false)
  const contextRef = useRef<RequestContextInput>({})
  const workerIdRef = useRef('')

  function updateContext(patch: Partial<RequestContextInput>) {
    const next = { ...contextRef.current, ...patch }
    contextRef.current = next
    setContext(next)
    setError('')
    if (url.trim()) handleUrlChange(url)
  }

  useEffect(() => {
    if (!open) return
    setMode('url')
    setUrl('')
    setCurlInput('')
    setCurlParse({ status: 'idle' })
    setContext({})
    contextRef.current = {}
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
  }, [open, defaultFolderId, workers])

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
    abortRef.current?.abort()
    abortRef.current = controller
    setProbe({ status: 'detecting' })
    setError('')
    try {
      const { data } = await probeRemoteUrl(targetUrl, controller.signal, contextRef.current, workerIdRef.current || null)
      if (token !== probeTokenRef.current) return
      setProbe({ status: 'detected', result: data })
      setDetectedFileName(data.fileName)
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
      if (!hasUserEditedRef.current) setFileName(data.fileName)
    } catch (err) {
      if (token !== probeTokenRef.current) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      const code = (err as Error & { code?: string }).code
      setProbe({ status: 'failed', message: probeErrorMessage(code) ?? 'File name could not be detected. Enter it manually.' })
    }
  }

  function handleUrlChange(value: string) {
    setUrl(value)
    setError('')
    setDetectedFileName('')
    if (!hasUserEditedFileName) setFileName('')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = value.trim()
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
    probeTokenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    const token = probeTokenRef.current
    debounceRef.current = setTimeout(() => { void runProbe(trimmed, token) }, PROBE_DEBOUNCE_MS)
  }

  const prevWorkerIdRef = useRef('')
  useEffect(() => {
    const workerChanged = prevWorkerIdRef.current !== workerId
    prevWorkerIdRef.current = workerId
    workerIdRef.current = workerId
    if (workerChanged) {
      setProbe({ status: 'idle' })
      setHlsOptions(null)
      setDetectedFileName('')
    }
    if (open && mode === 'url' && url.trim()) handleUrlChange(url)
  }, [workerId, open, mode, url])

  function handleFileNameChange(value: string) {
    setFileName(value)
    if (!hasUserEditedRef.current) {
      hasUserEditedRef.current = true
      setHasUserEditedFileName(true)
    }
    setProbe((prev) => (prev.status === 'failed' ? { status: 'idle' } : prev))
  }

  function handleModeChange(next: 'url' | 'curl') {
    setMode(next)
    setError('')
    setProbe({ status: 'idle' })
    setHlsOptions(null)
    probeTokenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
  }

  async function handleCurlChange(value: string) {
    setCurlInput(value)
    setError('')
    const trimmed = value.trim()
    if (curlDebounceRef.current) clearTimeout(curlDebounceRef.current)
    if (!trimmed) {
      setCurlParse({ status: 'idle' })
      return
    }
    const token = ++probeTokenRef.current
    curlDebounceRef.current = setTimeout(() => {
      setCurlParse({ status: 'parsing' })
      parseCurl(trimmed)
        .then(({ data }) => {
          if (token !== probeTokenRef.current) return
          setCurlParse({ status: 'ok', result: data })
        })
        .catch((err: unknown) => {
          if (token !== probeTokenRef.current) return
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

    const live = hlsOptions?.isLive === true
    if (live && hlsOptions?.recordingDurationSeconds == null) {
      setError('Recording duration is required for a live HLS stream.')
      return
    }
    if (!live && hlsOptions?.recordingDurationSeconds != null) {
      setHlsOptions({ ...hlsOptions, recordingDurationSeconds: undefined })
    }

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
        await createRemoteImport({
          sourceMode: 'curl',
          curl: curlInput.trim(),
          folderId: folderId || null,
          connectedAccountId: accountId || null,
          workerId: workerId || undefined,
          fileName: fileName.trim() || null,
          detectedFileName: detectedFileName || null,
          mimeType: probe.status === 'detected' ? probe.result.mimeType : null,
          hls: hlsOptions ?? undefined,
        })
      } else {
        const attached = Object.values(contextRef.current).some((value) => value != null && value !== '')
        await createRemoteImport({
          sourceMode: 'url',
          url: trimmedUrl,
          folderId: folderId || null,
          connectedAccountId: accountId || null,
          workerId: workerId || undefined,
          fileName: fileName.trim() || null,
          detectedFileName: detectedFileName || null,
          mimeType: probe.status === 'detected' ? probe.result.mimeType : null,
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

  return {
    mode,
    url,
    curlInput,
    curlParse,
    context,
    folderId,
    accountId,
    workerId,
    fileName,
    submitting,
    error,
    probe,
    hlsOptions,
    detectedFileName,
    hasUserEditedFileName,
    setFolderId,
    setAccountId,
    setWorkerId,
    setHlsOptions,
    updateContext,
    handleUrlChange,
    handleFileNameChange,
    handleModeChange,
    handleCurlChange,
    handleSubmit,
  }
}
