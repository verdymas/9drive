import { CloudDownload, Loader2, Search, Check, AlertTriangle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible } from '@/components/ui/collapsible'
import { DummyModal } from '@/components/drive/DummyModal'
import { HlsSection, formatDuration } from '@/components/drive/RemoteImportHlsSection'
import type { ProbeResult } from '@/lib/remoteImports'
import { workerStatusLabel, type WorkerItem } from '@/lib/workers'
import { useRemoteImportForm } from '@/hooks/useRemoteImportForm'

export { HlsSection, formatDuration }

type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string; autoAllocationEnabled: boolean }
type FolderOption = { id: string; name: string }

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

function curlChipLabel(field: 'url' | 'referer' | 'origin' | 'userAgent' | 'cookie'): string {
  switch (field) {
    case 'url': return 'URL'
    case 'referer': return 'Referer'
    case 'origin': return 'Origin'
    case 'userAgent': return 'User-Agent'
    case 'cookie': return 'Cookie'
  }
}

type RemoteImportModalProps = {
  open: boolean
  onClose: () => void
  onCreated: () => void
  accounts: ConnectedAccount[]
  folders: FolderOption[]
  defaultFolderId?: string | null
  workers: WorkerItem[]
}

export function RemoteImportModal({
  open,
  onClose,
  onCreated,
  accounts,
  folders,
  defaultFolderId,
  workers,
}: RemoteImportModalProps) {
  const {
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
  } = useRemoteImportForm({ open, onClose, onCreated, defaultFolderId, workers })

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
                <Input value={context.referer ?? ''} onChange={(event) => updateContext({ referer: event.target.value })} placeholder="https://watch.example/page" type="url" />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                Origin
                <Input value={context.origin ?? ''} onChange={(event) => updateContext({ origin: event.target.value })} placeholder="https://watch.example" type="url" />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                User-Agent
                <Input value={context.userAgent ?? ''} onChange={(event) => updateContext({ userAgent: event.target.value })} placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64)…" />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                Cookie
                <Input value={context.cookie ?? ''} onChange={(event) => updateContext({ cookie: event.target.value })} placeholder="session=…" type="password" autoComplete="off" />
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

        <label className="grid gap-2 text-sm font-semibold">
          Network Route
          <select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={workerId} onChange={(event) => setWorkerId(event.target.value)}>
            <option value="">Direct / No Worker</option>
            {workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name} — {workerStatusLabel(worker.status)}</option>)}
          </select>
          {workers.length === 0 ? <p className="text-xs text-slate-500">No workers registered — imports run directly from 9Drive.</p> : null}
          {workerId && workers.find((worker) => worker.id === workerId)?.status === 'unhealthy' ? (
            <p className="flex items-center gap-1.5 rounded-xl bg-amber-50 p-2.5 text-sm font-semibold text-amber-700"><AlertTriangle className="h-4 w-4" /> This worker last reported unhealthy — the import may fail.</p>
          ) : null}
          {workerId && workers.find((worker) => worker.id === workerId)?.status === 'unknown' ? <p className="text-xs text-slate-500">This worker has not been tested yet.</p> : null}
        </label>

        <label className="grid gap-2 text-sm font-semibold">
          File Name (optional)
          <div className="relative">
            <Input value={fileName} onChange={(event) => handleFileNameChange(event.target.value)} placeholder={probeStatus === 'detecting' ? 'Detecting file name...' : 'Auto-detected from URL'} className="pr-10" />
            {probeStatus === 'detecting' ? <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" /> : null}
          </div>
        </label>
        {probeStatus === 'detecting' ? <p className="flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-sm font-semibold text-blue-700"><Search className="h-4 w-4" /> Detecting file name...</p> : null}
        {probeStatus === 'detected' && hasUserEditedFileName ? <p className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-700"><Check className="h-4 w-4" /> {sourceLabel(probe.result.fileNameSource)}: <span className="font-normal">{probe.result.fileName}</span></p> : null}
        {probeStatus === 'detected' && !hasUserEditedFileName ? <p className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-700"><Check className="h-4 w-4" /> {sourceLabel(probe.result.fileNameSource)}</p> : null}
        {probeFailed ? <p className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-700"><AlertTriangle className="h-4 w-4" /> {probe.status === 'failed' ? probe.message : 'File name could not be detected. Enter it manually.'}</p> : null}
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
            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          Storage Account
          <select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">Automatic (recommended)</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName || account.email || account.id} ({account.provider === 's3' ? 'S3' : account.provider === 'telegram' ? 'Telegram' : 'Google Drive'})</option>)}
          </select>
        </label>
        {accountId && accounts.find((account) => account.id === accountId)?.autoAllocationEnabled === false ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Automatic allocation is disabled for this account. You selected this account manually, so the file can still be stored here.</p> : null}

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
