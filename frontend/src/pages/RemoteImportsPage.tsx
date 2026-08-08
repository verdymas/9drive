import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudDownload, Loader2, Pause, RefreshCw, Trash2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/drive/PageHeader'
import { RemoteImportModal, formatDuration } from '@/components/drive/RemoteImportModal'
import { apiFetch, formatBytes, formatDate } from '@/lib/api'
import {
  accountLabel,
  bytesOf,
  cancelRemoteImport,
  deleteRemoteImport,
  elapsedSecondsSince,
  formatShortDuration,
  isConvertRetryable,
  listRemoteImports,
  retryRemoteConvert,
  retryRemoteImport,
  statusLabel,
  type RemoteImportItem,
} from '@/lib/remoteImports'

type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string }
type FolderOption = { id: string; name: string }

const POLL_INTERVAL_MS = 3_000

/**
 * Compact, privacy-safe formatter for a remote import's source URL.
 *
 * The backend already strips query strings from `displayUrl`, but even the
 * path can be long and ugly. Show only the hostname + first path segment with
 * an ellipsis so the card never expands for a 1,000-char URL, and the full
 * signed query never reaches the DOM. The raw source URL is not displayed,
 * tooltipped, or stored in any attribute.
 */
export function formatDisplayUrl(url: string, maxPathSegments = 1): string {
  try {
    const parsed = new URL(url)
    const pathSegments = parsed.pathname.split('/').filter(Boolean)
    if (pathSegments.length === 0) return parsed.hostname
    const shown = pathSegments.slice(0, maxPathSegments).join('/')
    const rest = pathSegments.length > maxPathSegments ? '/…' : ''
    const suffix = parsed.pathname.endsWith('/') ? '/' : ''
    return `${parsed.hostname}/${shown}${rest}${suffix}`
  } catch {
    // Not a parseable URL — never display a raw signed string; fall back to a
    // neutral placeholder.
    return 'remote source'
  }
}

/**
 * Stage-aware import progress.
 *
 * A `totalBytes` transfer happens in two distinct phases — the download
 * writes `downloadedBytes`, the upload writes `uploadedBytes` — so a single
 * `downloaded/total` ratio is wrong: it never moves during the upload and pins
 * at 100% the moment the download ends, even though the import is still
 * uploading (trivially "always 100%" for large files). We therefore show the
 * ratio of whichever phase is currently running, and cap it at 99% until that
 * phase actually finishes — the bar never claims completion early.
 *
 * Returns `null` when there's no known total to measure against (e.g. a
 * server that never sent a Content-Length), in which case the UI shows a
 * spinner/indeterminate bar instead of a bogus percentage.
 */
export function progressPercent(item: RemoteImportItem) {
  if (item.status === 'completed') return 100
  if (item.status === 'failed' || item.status === 'cancelled') return 0

  if (item.status === 'processing' && item.stage === 'uploading') {
    // The upload measures against `uploadTotalBytes` (the final output size —
    // for HLS the remuxed file, which differs from the SOURCE totalBytes).
    const total = bytesOf(item.uploadTotalBytes ?? item.totalBytes)
    if (total <= 0) return null
    const bytes = bytesOf(item.uploadedBytes)
    if (bytes <= 0) return 0
    // Cap at 99 so the bar never claims completion while the stage is unfinished.
    return Math.min(99, Math.round((bytes / total) * 100))
  }

  const total = bytesOf(item.totalBytes)
  if (total <= 0) return null
  const bytes = bytesOf(item.downloadedBytes)
  if (bytes <= 0) return 0
  return Math.min(99, Math.round((bytes / total) * 100))
}

/**
 * HLS-specific progress line for an import row (§13, §17):
 *   - downloading segments → "Downloading HLS segments · 128 / 420",
 *   - live recording → "Recording live stream · 00:18:32 / 01:00:00",
 *   - remuxing → "Remuxing media · 74%".
 * Uses the same `h:mm:ss` duration formatter as the modal. Never renders for a
 * non-HLS or idle HLS import. The recorded live duration is the elapsed media
 * time (`hlsMediaDurationSeconds`), not the raw segment count.
 */
export function hlsActivityLine(item: RemoteImportItem): string | null {
  if (item.sourceType !== 'hls_master' && item.sourceType !== 'hls_media') return null
  const isLive = item.hlsIsLive === true

  if (item.stage === 'segments') {
    // Live recording reports elapsed media time instead of a static segment
    // list — the segment count moves but the display is duration-based (§13).
    if (isLive) {
      const elapsed = item.hlsMediaDurationSeconds
      const target = item.hlsRecordingDurationSeconds
      if (elapsed != null) {
        return `Recording live stream · ${formatDuration(elapsed)}${target != null ? ` / ${formatDuration(target)}` : ''}`
      }
      if (target != null) return `Recording live stream · ${formatDuration(target)} max`
      return 'Recording live stream'
    }
    if (item.hlsSegmentCount != null && item.hlsCompletedSegmentCount != null) {
      return `Downloading HLS segments · ${item.hlsCompletedSegmentCount} / ${item.hlsSegmentCount}`
    }
  }
  if (item.stage === 'remuxing') {
    if (item.remuxProgress != null) {
      // remuxProgress is a 0–1 fraction from the backend; show a 0–100 percent.
      const percent = Math.max(0, Math.min(100, Math.round(item.remuxProgress * 100)))
      return `Remuxing media · ${percent}%`
    }
    return 'Remuxing media'
  }
  return null
}

/**
 * Static HLS summary for a row that is not mid-activity (queued/completed/
 * failed/cancelled or idle): quality, audio language, output container and
 * media duration, e.g. "1080p · English · MKV · 1:30:24".
 */
export function hlsSummaryLine(item: RemoteImportItem): string {
  const parts: string[] = []
  if (item.hlsVariantHeight != null) parts.push(`${item.hlsVariantHeight}p`)
  if (item.hlsAudioTrackLanguage) parts.push(item.hlsAudioTrackLanguage)
  if (item.hlsOutputContainer) parts.push(item.hlsOutputContainer.toUpperCase())
  if (item.hlsMediaDurationSeconds != null) parts.push(formatDuration(item.hlsMediaDurationSeconds))
  if (item.hlsIsLive && item.hlsRecordingDurationSeconds != null) parts.push(`rec ${formatDuration(item.hlsRecordingDurationSeconds)}`)
  if (!parts.length) return 'HLS video'
  return `HLS video · ${parts.join(' · ')}`
}

function StatusBadge({ item }: { item: RemoteImportItem }) {
  const base = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold'
  const classes: Record<RemoteImportItem['status'], string> = {
    queued: 'bg-slate-100 text-slate-600',
    processing: 'bg-blue-50 text-blue-700',
    completed: 'bg-emerald-50 text-emerald-700',
    failed: 'bg-red-50 text-red-700',
    cancelled: 'bg-amber-50 text-amber-700',
  }
  return (
    <span className={`${base} ${classes[item.status]}`}>
      {item.status === 'processing' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {statusLabel(item)}
    </span>
  )
}

export function RemoteImportsPage() {
  const [items, setItems] = useState<RemoteImportItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [folders, setFolders] = useState<FolderOption[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await listRemoteImports(100)
      setItems(data.items)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load remote imports')
    } finally {
      setLoading(false)
    }
  }, [])

  // Poll while any import is still active (queued/processing).
  const hasActive = items.some((item) => item.status === 'queued' || item.status === 'processing')

  useEffect(() => {
    load().catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
    if (hasActive) {
      pollTimer.current = setTimeout(() => {
        load().catch(() => undefined)
      }, POLL_INTERVAL_MS)
    }
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [items, load, hasActive])

  useEffect(() => {
    async function loadMeta() {
      try {
        const [accountsData, foldersData] = await Promise.all([
          apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts'),
          apiFetch<{ folders: FolderOption[] }>('/folders?all=1'),
        ])
        setAccounts(accountsData.accounts || [])
        setFolders(foldersData.folders || [])
      } catch {
        /* non-fatal */
      }
    }
    loadMeta().catch(() => undefined)
  }, [])

  async function handleCancel(id: string) {
    setBusyId(id)
    try {
      await cancelRemoteImport(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel import')
    } finally {
      setBusyId(null)
    }
  }

  async function handleRetry(id: string) {
    setBusyId(id)
    try {
      await retryRemoteImport(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry import')
    } finally {
      setBusyId(null)
    }
  }

  async function handleRetryConvert(id: string) {
    setBusyId(id)
    try {
      await retryRemoteConvert(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry conversion')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id)
    try {
      await deleteRemoteImport(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete import')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Remote Imports"
        actions={
          <Button size="sm" onClick={() => setModalOpen(true)}>
            <CloudDownload className="h-3.5 w-3.5" />Import from URL
          </Button>
        }
      />
      <div className="mt-4 flex flex-wrap items-center gap-2 lg:hidden">
        <Button size="sm" onClick={() => setModalOpen(true)}>
          <CloudDownload className="h-3.5 w-3.5" />Import from URL
        </Button>
        <Button size="sm" variant="outline" onClick={() => load().catch(() => undefined)}>
          <RefreshCw className="h-3.5 w-3.5" />Refresh
        </Button>
      </div>

      {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}

      <Card className="mt-4 min-w-0 p-4 sm:p-5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />Loading imports...
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center">
            <CloudDownload className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-500">No remote imports yet.</p>
            <p className="mt-1 text-xs text-slate-400">Paste a URL to download a file into your storage.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {items.map((item) => {
              const percent = progressPercent(item)
              const active = item.status === 'queued' || item.status === 'processing'
              const retryable = item.status === 'failed' || item.status === 'cancelled'
              return (
                // The card is its own overflow containment box: w-full keeps it
                // inside the grid column, min-w-0 lets it shrink below content,
                // and overflow-hidden clips any long child text that would
                // otherwise push the page sideways. The combined metadata line
                // is a min-w-0 truncate so a long filename/URL/path ellipsizes
                // instead of forcing the row wider.
                <div key={item.id} className="w-full max-w-full min-w-0 overflow-hidden rounded-2xl border border-slate-100 bg-slate-50/60 p-3 sm:p-3.5">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
                    {/* Main column: filename + safe URL + metadata */}
                    <div className="min-w-0 max-w-full flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-extrabold text-slate-900" title={item.fileName}>{item.fileName}</p>
                        <span className="shrink-0"><StatusBadge item={item} /></span>
                      </div>
                      <p className="mt-1 min-w-0 truncate text-xs text-slate-400" title={formatDisplayUrl(item.displayUrl)}>{formatDisplayUrl(item.displayUrl)}</p>
                      {(item.sourceType === 'hls_master' || item.sourceType === 'hls_media') ? (
                        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-semibold text-slate-500">
                          {item.hlsIsLive ? (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">Live</span>
                          ) : (
                            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700">HLS</span>
                          )}
                          <span className="min-w-0 truncate">{hlsActivityLine(item) ?? hlsSummaryLine(item)}</span>
                        </p>
                      ) : null}
                      <p className="mt-0.5 min-w-0 truncate text-xs text-slate-500" title={`Created ${formatDate(item.createdAt)}${item.totalBytes ? ` · ${formatBytes(item.totalBytes)}` : ''}`}>
                        Created {formatDate(item.createdAt)}
                        {item.totalBytes ? ` · ${formatBytes(item.totalBytes)}` : ''}
                        {item.failedAt ? ` · Failed ${formatDate(item.failedAt)}` : ''}
                        {item.completedAt ? ` · Completed ${formatDate(item.completedAt)}` : ''}
                        {item.attempt > 1 ? ` · Attempt ${item.attempt}` : ''}
                      </p>
                    </div>

                    {/* Actions column: shrink-0, stays inside the card */}
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {active && (
                        <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => handleCancel(item.id)}>
                          <Pause className="h-3.5 w-3.5" />Cancel
                        </Button>
                      )}
                      {retryable && (
                        <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => handleRetry(item.id)}>
                          <RefreshCw className="h-3.5 w-3.5" />Retry
                        </Button>
                      )}
                      {isConvertRetryable(item) && (
                        <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => handleRetryConvert(item.id)} title="Retry only the conversion, reusing the downloaded segments">
                          <Wand2 className="h-3.5 w-3.5" />Retry convert
                        </Button>
                      )}
                      <Button size="sm" variant="danger" disabled={busyId === item.id} onClick={() => handleDelete(item.id)} aria-label={`Delete remote import ${item.fileName}`} title={`Delete ${item.fileName}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {percent !== null ? (
                    <div className="mt-2.5 flex min-w-0 w-full max-w-full items-center gap-3">
                      {/* overflow-hidden keeps the fill inside the rounded track */}
                      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <div
                          className={active ? 'h-full rounded-full bg-blue-600 transition-[width] duration-300 ease-out' : item.status === 'failed' ? 'h-full rounded-full bg-red-500' : 'h-full rounded-full bg-emerald-500'}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <span className="shrink-0 text-right text-[11px] font-bold text-slate-500">
                        {item.status === 'completed' ? 'Complete' : `${percent}%`}
                        {active ? (
                          item.stage === 'uploading'
                            ? ` · ${formatBytes(item.uploadedBytes)} / ${formatBytes(item.uploadTotalBytes ?? item.totalBytes)}`
                            : ` · ${formatBytes(item.downloadedBytes)}`
                        ) : null}
                      </span>
                    </div>
                  ) : null}

                  {item.status === 'processing' && item.stage === 'uploading' ? (
                    <p className="mt-1.5 text-[11px] font-semibold text-blue-700">
                      Uploading to {accountLabel(item)}
                      {item.uploadTotalBytes && item.uploadedBytes !== item.uploadTotalBytes ? ` · ${formatBytes(item.uploadedBytes)} / ${formatBytes(item.uploadTotalBytes)}` : ''}
                      {item.attempt > 1 ? ` · Attempt ${item.attempt}` : ''}
                    </p>
                  ) : null}

                  {item.status === 'queued' && item.attempt > 1 ? (
                    <p className="mt-1.5 text-[11px] font-semibold text-slate-500">
                      {item.retryFromStage === 'remuxing' ? 'Queued for conversion retry' : 'Queued for retry'}
                      {` · Attempt ${item.attempt}`}
                      {` · waiting ${formatShortDuration(elapsedSecondsSince(item.queuedAt))}`}
                    </p>
                  ) : null}

                  {item.errorMessage && item.status === 'failed' ? (
                    <p className="mt-2 line-clamp-2 break-words rounded-xl bg-red-50 p-2 text-xs font-semibold text-red-700 [overflow-wrap:anywhere]" title={item.errorMessage}>
                      {item.errorMessage}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <RemoteImportModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => load().catch(() => undefined)}
        accounts={accounts}
        folders={folders}
      />
    </>
  )
}
