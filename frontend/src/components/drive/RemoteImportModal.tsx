import { useEffect, useState, type FormEvent } from 'react'
import { CloudDownload, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DummyModal } from '@/components/drive/DummyModal'
import { createRemoteImport } from '@/lib/remoteImports'

type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string }
type FolderOption = { id: string; name: string }

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

  useEffect(() => {
    if (open) {
      setUrl('')
      setFolderId(defaultFolderId ?? '')
      setAccountId('')
      setFileName('')
      setError('')
    }
  }, [open, defaultFolderId])

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
      })
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start import')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DummyModal open={open} title="Import from URL" description="Download a remote file into your storage." onClose={onClose}>
      <form onSubmit={handleSubmit} className="grid gap-4">
        <label className="grid gap-2 text-sm font-semibold">
          File URL
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/file.pdf" type="url" required />
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          File Name (optional)
          <Input value={fileName} onChange={(event) => setFileName(event.target.value)} placeholder="Auto-detected from URL" />
        </label>
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
        {error ? <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}
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
