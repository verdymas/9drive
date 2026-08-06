import { apiFetch } from '@/lib/api'

export type RemoteImportStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'
export type RemoteImportStage = 'waiting' | 'probing' | 'downloading' | 'verifying' | 'selecting_storage' | 'uploading' | 'registering' | 'cleaning' | 'finished'

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
}

export type ProbeResult = {
  originalUrl: string
  finalUrl: string
  fileName: string
  fileNameSource: 'content-disposition-filename-star' | 'content-disposition-filename' | 'final-url-path' | 'original-url-path' | 'generated-fallback'
  mimeType: string | null
  contentLength: number | null
  supportsRange: boolean
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
    case 'verifying': return 'Verifying'
    case 'selecting_storage': return 'Choosing storage'
    case 'uploading': return 'Uploading'
    case 'registering': return 'Registering'
    case 'cleaning': return 'Cleaning up'
    case 'waiting': return 'Waiting'
    default: return 'Processing'
  }
}
