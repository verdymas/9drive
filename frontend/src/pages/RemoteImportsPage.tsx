import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudDownload, Loader2, Pause, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/drive/PageHeader'
import { RemoteImportModal } from '@/components/drive/RemoteImportModal'
import { apiFetch, formatBytes, formatDate } from '@/lib/api'
import {
  cancelRemoteImport,
  deleteRemoteImport,
  listRemoteImports,
  retryRemoteImport,
  statusLabel,
  type RemoteImportItem,
} from '@/lib/remoteImports'

type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string }
type FolderOption = { id: string; name: string }

const POLL_INTERVAL_MS = 3_000

function progressPercent(item: RemoteImportItem) {
  const total = Number(item.totalBytes ?? 0)
  if (total <= 0) return null
  if (item.status === 'completed') return 100
  const downloaded = Number(item.downloadedBytes ?? 0)
  return Math.min(100, Math.round((downloaded / total) * 100))
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

      <Card className="mt-4 p-4 sm:p-5">
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
          <div className="grid gap-3">
            {items.map((item) => {
              const percent = progressPercent(item)
              const active = item.status === 'queued' || item.status === 'processing'
              const retryable = item.status === 'failed' || item.status === 'cancelled'
              return (
                <div key={item.id} className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-extrabold text-slate-900">{item.fileName}</p>
                        <StatusBadge item={item} />
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-400" title={item.displayUrl}>{item.displayUrl}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        Created {formatDate(item.createdAt)}
                        {item.totalBytes ? ` · ${formatBytes(item.totalBytes)}` : ''}
                        {item.failedAt ? ` · Failed ${formatDate(item.failedAt)}` : ''}
                        {item.completedAt ? ` · Completed ${formatDate(item.completedAt)}` : ''}
                        {item.attempt > 1 ? ` · Attempt ${item.attempt}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {active ? (
                        <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => handleCancel(item.id)}>
                          <Pause className="h-3.5 w-3.5" />Cancel
                        </Button>
                      ) : null}
                      {retryable ? (
                        <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => handleRetry(item.id)}>
                          <RefreshCw className="h-3.5 w-3.5" />Retry
                        </Button>
                      ) : null}
                      <Button size="sm" variant="danger" disabled={busyId === item.id} onClick={() => handleDelete(item.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {percent !== null ? (
                    <div className="mt-3">
                      <div className="h-2 rounded-full bg-slate-200">
                        <div
                          className={active ? 'h-full rounded-full bg-blue-600 transition-all duration-1000' : item.status === 'failed' ? 'h-full rounded-full bg-red-500' : 'h-full rounded-full bg-emerald-500'}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <p className="mt-1 text-right text-[11px] font-bold text-slate-500">
                        {item.status === 'completed' ? 'Complete' : `${percent}%`}
                        {item.downloadedBytes ? ` · ${formatBytes(item.downloadedBytes)} downloaded` : ''}
                      </p>
                    </div>
                  ) : null}
                  {item.errorMessage && item.status === 'failed' ? (
                    <p className="mt-2 rounded-xl bg-red-50 p-2.5 text-xs font-semibold text-red-700">{item.errorMessage}</p>
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
