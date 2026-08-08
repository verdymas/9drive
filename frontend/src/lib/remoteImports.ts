import { apiFetch } from '@/lib/api'

export type RemoteImportStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'
export type RemoteImportStage = 'waiting' | 'probing' | 'downloading' | 'segments' | 'remuxing' | 'verifying' | 'selecting_storage' | 'uploading' | 'registering' | 'cleaning' | 'finished'

export type RemoteImportItem = {
  id: string
  fileName: string
  displayUrl: string
  status: RemoteImportStatus
  stage: RemoteImportStage
  totalBytes: string | null
  downloadedBytes: string
  uploadedBytes: string
  /** Final output size being uploaded (HLS: the remuxed file; may differ from totalBytes). */
  uploadTotalBytes: string | null
  /** 0–100 int computed server-side from uploadedBytes / uploadTotalBytes. */
  uploadProgress: number
  /** When the last successful queue.add() happened (retry shows a waiting timer). */
  queuedAt: string | null
  retryRequestedAt: string | null
  /** Rolling liveness evidence from the worker. */
  heartbeatAt: string | null
  /** Server-derived resume stage for a retry (never trusted from the client). */
  retryFromStage: string | null
  mimeType: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  failedAt: string | null
  cancelledAt: string | null
  attempt: number
  fileId: string | null
  folderId: string | null
  connectedAccountId: string | null
  /** Resolved destination account (safe fields only, for the upload label). */
  connectedAccount?: { id: string; provider: string; email: string | null; displayName: string | null } | null
  file?: { id: string; name: string; sizeBytes: string } | null
  // ── HLS/M3U8 fields (populated for HLS imports) ────────────────────────────
  sourceType?: 'hls_master' | 'hls_media' | null
  hlsPlaylistType?: 'vod' | 'event' | 'live' | null
  hlsVariantId?: string | null
  hlsVariantBandwidth?: number | null
  hlsVariantWidth?: number | null
  hlsVariantHeight?: number | null
  hlsAudioTrackId?: string | null
  hlsAudioTrackLanguage?: string | null
  hlsOutputContainer?: 'auto' | 'mkv' | 'mp4' | null
  hlsIsLive?: boolean | null
  hlsRecordingDurationSeconds?: number | null
  hlsMediaDurationSeconds?: number | null
  hlsSegmentCount?: number | null
  hlsCompletedSegmentCount?: number | null
  remuxProgress?: number | null
  outputDurationSeconds?: number | null
  outputCodecSummary?: string | null
  /** Boolean-only summary of an attached request context (never the values). */
  requestContext?: RequestContextSummary
}

export type CreateRemoteImportInput = {
  sourceMode?: 'url' | 'curl'
  url?: string
  /** Paste-as-cURL mode: raw command text (the backend parses it). */
  curl?: string
  folderId?: string | null
  connectedAccountId?: string | null
  /** User-entered filename (wins over any detection). */
  fileName?: string | null
  /** Server-side detected filename from the probe (fallback when no custom). */
  detectedFileName?: string | null
  mimeType?: string | null
  /** HLS import options; present only for HLS sources (from the probe). */
  hls?: HlsImportOptions
  /**
   * Optional access headers (Referer/Origin/User-Agent/Cookie) sent to the
   * source host for protected media. Values are never echoed back by any API —
   * the wire only ever carries `attached` booleans.
   */
  requestContext?: RequestContextInput
}

/** User-supplied access headers for a protected source (spec §6). */
export type RequestContextInput = {
  referer?: string
  origin?: string
  userAgent?: string
  cookie?: string
}

/**
 * Boolean-only summary of an attached request context (spec §19, §36). Values
 * are never serialized — only which fields are attached.
 */
export type RequestContextSummary = {
  attached: boolean
  referer: boolean
  origin: boolean
  userAgent: boolean
  cookie: boolean
}

/** Result of the backend-authoritative cURL parse (booleans only, §19). */
export type ParsedCurlResult = {
  url: string
  requestContext: RequestContextSummary
  unsupportedOptions: string[]
}

export type HlsImportOptions = {
  sourceType: 'hls_master' | 'hls_media'
  /** Opaque variant id from the probe's `hls.variants[].id`. */
  variantId?: string
  /** Opaque audio track id from the probe's `hls.audioTracks[].id`. */
  audioTrackId?: string
  outputContainer?: 'auto' | 'mkv' | 'mp4'
  /** True when the selected media playlist is live/event (no ENDLIST). */
  isLive?: boolean
  recordingDurationSeconds?: number
}

export type ProbeHlsVariant = {
  id: string
  label: string
  bandwidth: number
  averageBandwidth: number | null
  width: number | null
  height: number | null
  frameRate: number | null
  codecs: string[]
  audioGroup: string | null
}

export type ProbeHlsAudioTrack = {
  id: string
  language: string | null
  name: string | null
  isDefault: boolean
  isAutoSelect: boolean
  groupId: string
}

export type ProbeHlsSummary = {
  sourceType: 'hls_master' | 'hls_media'
  playlistType: 'vod' | 'event' | 'live'
  isFinite: boolean
  variants: ProbeHlsVariant[]
  audioTracks: ProbeHlsAudioTrack[]
  durationSeconds: number | null
  detectedInBody: boolean
}

export type ProbeResult = {
  originalUrl: string
  finalUrl: string
  fileName: string
  fileNameSource: 'content-disposition-filename-star' | 'content-disposition-filename' | 'final-url-path' | 'original-url-path' | 'generated-fallback'
  mimeType: string | null
  contentLength: number | null
  supportsRange: boolean
  /** Source classification: direct file, HLS master, or HLS media. */
  sourceType: 'direct_file' | 'hls_master' | 'hls_media'
  /** HLS details when the source is HLS; null for direct files. */
  hls: ProbeHlsSummary | null
}

/**
 * Ask the backend to inspect a remote URL (server-side only — the browser
 * never contacts the remote host). `signal` lets the caller cancel a
 * superseded probe; an aborted fetch rejects with an AbortError which the
 * modal ignores. `requestContext` carries the access headers a protected
 * source needs; they never leave the backend.
 */
export function probeRemoteUrl(url: string, signal?: AbortSignal, requestContext?: RequestContextInput) {
  return apiFetch<{ data: ProbeResult }>('/remote-imports/probe', {
    method: 'POST',
    body: JSON.stringify({ url, ...(requestContext ? { requestContext } : {}) }),
    signal,
  })
}

/**
 * Ask the backend to parse a pasted cURL command (server-side, authoritative —
 * spec §19). Returns the extracted URL + boolean context summary; values are
 * never echoed back. The backend never executes anything.
 */
export function parseCurl(input: string) {
  return apiFetch<{ data: ParsedCurlResult }>('/remote-imports/parse-curl', {
    method: 'POST',
    body: JSON.stringify({ input }),
  })
}

export function createRemoteImport(input: CreateRemoteImportInput) {
  // `hls` is omitted from the wire for direct files (JSON.stringify drops
  // undefined); the backend schema also tolerates `null` from legacy clients.
  return apiFetch<RemoteImportItem>('/remote-imports', {
    method: 'POST',
    body: JSON.stringify({ ...input, hls: input.hls ?? undefined }),
  })
}

export function listRemoteImports(limit = 50, cursor?: string) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  return apiFetch<{ items: RemoteImportItem[]; cursor: string | null }>(`/remote-imports?${params}`)
}

export function getRemoteImport(id: string) {
  return apiFetch<RemoteImportItem>(`/remote-imports/${id}`)
}

export function cancelRemoteImport(id: string) {
  return apiFetch<RemoteImportItem>(`/remote-imports/${id}/cancel`, { method: 'POST' })
}

export function retryRemoteImport(id: string) {
  return apiFetch<RemoteImportItem>(`/remote-imports/${id}/retry`, { method: 'POST' })
}

/**
 * Retry only the conversion (remux) step of a failed HLS import. Reuses the
 * already-downloaded segments; requires the failure to be remux/verify-related.
 */
export function retryRemoteConvert(id: string) {
  return apiFetch<RemoteImportItem>(`/remote-imports/${id}/retry-convert`, { method: 'POST' })
}

/**
 * Error codes that mean the source finished downloading but the conversion
 * failed — a "retry convert" re-runs only the remux step, skipping re-download.
 */
export const CONVERT_RETRYABLE_CODES = ['HLS_REMUX_FAILED', 'HLS_OUTPUT_INVALID'] as const

export function isConvertRetryable(item: RemoteImportItem): boolean {
  const isHls = item.sourceType === 'hls_master' || item.sourceType === 'hls_media'
  return item.status === 'failed' && isHls && CONVERT_RETRYABLE_CODES.includes(item.errorCode as (typeof CONVERT_RETRYABLE_CODES)[number])
}

export function deleteRemoteImport(id: string) {
  return apiFetch<void>(`/remote-imports/${id}`, { method: 'DELETE' })
}

/** Parse a server byte string to a number (safe: NaN → 0). */
export function bytesOf(value: string | null | undefined): number {
  const n = value ? Number(value) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Percent from a byte pair, clamped to [0, 100]. Never NaN, never negative.
 * Used when the server-computed `uploadProgress` is absent (older rows).
 */
export function percentOf(current: string | null | undefined, total: string | null | undefined): number {
  const cur = bytesOf(current)
  const tot = bytesOf(total)
  if (tot <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((cur / tot) * 100)))
}

/** Human label for the storage account the import uploads into. */
export function accountLabel(item: RemoteImportItem): string {
  const account = item.connectedAccount
  if (!account) return 'storage'
  return account.displayName || account.email || (account.provider === 's3' ? 'S3' : 'Google Drive')
}

/** Human label for a status + stage pair (used in tables and badges). */
export function statusLabel(item: RemoteImportItem) {
  switch (item.status) {
    case 'queued': return 'Queued'
    case 'processing': return stageLabel(item.stage)
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
    default: return item.status
  }
}

function stageLabel(stage: RemoteImportStage) {
  switch (stage) {
    case 'probing': return 'Checking URL'
    case 'downloading': return 'Downloading'
    case 'segments': return 'Downloading HLS segments'
    case 'remuxing': return 'Remuxing media'
    case 'verifying': return 'Verifying'
    case 'selecting_storage': return 'Choosing storage'
    case 'uploading': return 'Uploading'
    case 'registering': return 'Registering'
    case 'cleaning': return 'Cleaning up'
    case 'waiting': return 'Waiting'
    default: return 'Processing'
  }
}

/** Safe elapsed-seconds since a timestamp (0 when absent/parse failure). */
export function elapsedSecondsSince(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((now - t) / 1000))
}

/** Short human duration for the retry "waiting Xs" line. */
export function formatShortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
