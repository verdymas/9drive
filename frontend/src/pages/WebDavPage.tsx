import { useEffect, useState } from 'react'
import {
  BookOpen,
  CheckCircle2,
  FolderCog,
  KeyRound,
  Link2,
  Loader2,
  Server,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { API_URL, apiFetch } from '@/lib/api'

const WEBDAV_URL = `${API_URL}/webdav`

type WebDavStatus = {
  configured: boolean
}

type ConnectionTest = {
  status: 'ok' | 'fail' | 'testing' | null
  message?: string
  fileCount?: number
}

function formatCount(count: number) {
  if (count === 1) return '1 file'
  return `${count} files`
}

export function WebDavPage() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [test, setTest] = useState<ConnectionTest>({ status: null })
  const [showCopy, setShowCopy] = useState<'url' | 'rclone' | 'jellyfin' | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [testError, setTestError] = useState('')

  useEffect(() => {
    apiFetch<WebDavStatus>('/webdav/status')
      .then((data) => setConfigured(data.configured))
      .catch(() => setConfigured(false))
  }, [])

  async function runTest(event: React.FormEvent) {
    event.preventDefault()
    setTestError('')
    if (!password) {
      setTestError('Enter the WebDAV password first.')
      return
    }
    setTest({ status: 'testing' })
    try {
      const response = await fetch(`${WEBDAV_URL}/`, {
        method: 'PROPFIND',
        headers: {
          Authorization: `Basic ${btoa(`9drive:${password}`)}`,
          'Content-Type': 'application/xml',
          Depth: '0',
        },
        body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:getcontentlength/></D:prop></D:propfind>',
      })
      if (!response.ok) {
        setTest({ status: 'fail', message: `Server responded with HTTP ${response.status}.` })
        return
      }
      const text = await response.text()
      const fileCount = (text.match(/<D:response[ >]/g) ?? []).length
      setTest({ status: 'ok', message: `Connected. The server lists ${formatCount(fileCount)} top-level ${fileCount === 1 ? 'entry' : 'entries'} (this includes the root itself).`, fileCount })
    } catch {
      setTest({ status: 'fail', message: 'Could not reach the server. Make sure the backend is running and accessible from this browser.' })
    }
  }

  function copy(text: string, kind: 'url' | 'rclone' | 'jellyfin') {
    void navigator.clipboard?.writeText(text)
    setShowCopy(kind)
    window.setTimeout(() => setShowCopy(null), 2000)
  }

  return (
    <>
      <PageHeader
        title="WebDAV"
        description="Expose your 9Drive files as a read-only WebDAV server for rclone, Jellyfin, and other WebDAV clients."
        actions={
          <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
            <ShieldCheck className="h-4 w-4" />Test Connection
          </Button>
        }
      />

      {/* Server status */}
      <Card className="mt-6 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-600 text-white">
              <FolderCog className="h-5 w-5" />
            </div>
            <div>
              <p className="font-extrabold">WebDAV Server</p>
              <p className="mt-0.5 text-sm text-slate-500">
                {configured === null ? 'Checking configuration…' : configured ? 'Active — your files are exposed read-only.' : 'Disabled — set WEBDAV_PASSWORD in the backend .env to enable.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {configured === null ? (
              <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
            ) : configured ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700">Enabled</span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5 text-amber-500" />
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-700">Not configured</span>
              </>
            )}
          </div>
        </div>
        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
          The server is <b>read-only</b>: uploads, moves, and deletes are rejected with 403. Any user with the shared WebDAV password can read every file in your workspace.
        </p>
      </Card>

      {/* Server URL */}
      <Card className="mt-6 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white">
              <Link2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="font-extrabold">Server URL</p>
              <p className="truncate font-mono text-sm text-slate-600">{WEBDAV_URL}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => copy(WEBDAV_URL, 'url')} disabled={!configured}>
            {showCopy === 'url' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : null}Copy
          </Button>
        </div>
        <p className="mt-3 text-sm text-slate-500">Mount this URL in any WebDAV client. The username is <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">9drive</code> and the password is your <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">WEBDAV_PASSWORD</code>.</p>
      </Card>

      {/* rclone */}
      <Card className="mt-6 min-w-0 overflow-hidden p-0">
        <div className="border-b border-slate-200 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-extrabold">rclone</h2>
          </div>
          <p className="mt-1 text-sm text-slate-500">Add the remote once, then mount or copy to/from it as <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">9drive:path</code>.</p>
        </div>
        <div className="border-b border-slate-200 p-4 sm:p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Create the remote</p>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">{'rclone config create 9drive webdav \\\n  url ' + WEBDAV_URL + ' \\\n  vendor other \\\n  user 9drive \\\n  pass <WEBDAV_PASSWORD>'}</pre>
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => copy(`rclone config create 9drive webdav url ${WEBDAV_URL} vendor other user 9drive pass <WEBDAV_PASSWORD>`, 'rclone')} disabled={!configured}>
              {showCopy === 'rclone' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : null}Copy command
            </Button>
            <Button variant="outline" size="sm" onClick={() => copy(`rclone ls 9drive:`, 'rclone')}>
              {showCopy === 'rclone' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : null}Copy test command
            </Button>
          </div>
        </div>
        <div className="p-4 sm:p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Test it</p>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">{'rclone ls 9drive:'}</pre>
        </div>
      </Card>

      {/* Jellyfin */}
      <Card className="mt-6 min-w-0 overflow-hidden p-0">
        <div className="border-b border-slate-200 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-indigo-600" />
            <h2 className="text-lg font-extrabold">Jellyfin</h2>
          </div>
          <p className="mt-1 text-sm text-slate-500">Add 9Drive as a movie or TV library so Jellyfin can stream your files directly.</p>
        </div>
        <div className="grid gap-4 p-4 sm:p-5">
          <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-bold text-slate-900">Library type</p>
            <p className="mt-1">Pick <b>Movies</b>, <b>TV Shows</b>, or <b>Music</b> — whatever you store in 9Drive. Jellyfin uses it to structure metadata and folders.</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-bold text-slate-900">1. Choose folder</p>
            <p className="mt-1">Click <b>+</b> next to Folders and select <b>WebDAV</b>. Fill in:</p>
            <ul className="mt-2 list-inside list-disc space-y-1">
              <li><b>Server address:</b> <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">{WEBDAV_URL}</code></li>
              <li><b>Username:</b> <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">9drive</code></li>
              <li><b>Password:</b> your <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">WEBDAV_PASSWORD</code></li>
            </ul>
          </div>
          <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-bold text-slate-900">2. Save &amp; scan</p>
            <p className="mt-1">Save the library. Jellyfin scans the WebDAV tree and indexes your media — you can then stream it from your library page.</p>
          </div>
        </div>
      </Card>

      {/* Test connection modal */}
      <DummyModal open={testOpen} title="Test Connection" description="Verify the WebDAV server is reachable and your password is correct." onClose={() => setTestOpen(false)} className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={runTest}>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">WebDAV password</span>
            <input
              type="password"
              className="h-11 rounded-xl border border-slate-200 px-3 font-mono text-sm focus:border-blue-500 focus:outline-none"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="WEBDAV_PASSWORD"
              autoFocus
            />
          </label>
          {testError ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{testError}</p> : null}
          {test.status === 'testing' ? (
            <p className="flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">
              <Loader2 className="h-4 w-4 animate-spin" />Testing connection…
            </p>
          ) : test.status === 'ok' ? (
            <p className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4 shrink-0" />{test.message}
            </p>
          ) : test.status === 'fail' ? (
            <p className="flex items-center gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700">
              <XCircle className="h-4 w-4 shrink-0" />{test.message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" type="button" onClick={() => setTestOpen(false)}>Close</Button>
            <Button type="submit" disabled={test.status === 'testing'}>{test.status === 'testing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}Test Connection</Button>
          </div>
        </form>
      </DummyModal>
    </>
  )
}
