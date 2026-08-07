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
}

export type CreateRemoteImportInput = {
  url: string
  folderId?: string | null
  connectedAccountId?: string | null
  /** User-entered filename (wins over any detection). */
  fileName?: string | null
  /** Server-side detected filename from the probe (fallback when no custom). */
  detectedFileName?: string | null
  mimeType?: string | null
  /** HLS import options; present only for HLS sources (from the probe). */
  hls?: HlsImportOptions | null
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
 * modal ignores.
 */
export function probeRemoteUrl(url: string, signal?: AbortSignal) {
  return apiFetch<{ data: ProbeResult }>('/remote-imports/probe', {
    method: 'POST',
    body: JSON.stringify({ url }),
    signal,
  })
}

export function createRemoteImport(input: CreateRemoteImportInput) {
  return apiFetch<RemoteImportItem>('/remote-imports', {
    method: 'POST',
    body: JSON.stringify(input),
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

export function deleteRemoteImport(id: string) {
  return apiFetch<void>(`/remote-imports/${id}`, { method: 'DELETE' })
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
