import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch } from '@/lib/api'

type SmbHealth = {
  available: boolean
  status: 'running' | 'stopped' | 'reload_required' | 'config_error' | 'unavailable'
  version?: string | null
  service?: string | null
  configPath?: string | null
  message?: string
  connectedUsers?: number | null
}

type SmbShare = {
  id: string
  name: string
  path: string
  description: string
  readOnly: boolean
  guestAccess: boolean
  browsable: boolean
  validUsers: string[]
  validGroups: string[]
  hideFiles: string
}

type SmbUser = {
  id: string
  name: string
  enabled: boolean
}

type ShareFormState = {
  name: string
  path: string
  description: string
  readOnly: boolean
  guestAccess: boolean
  browsable: boolean
  validUsers: string
  validGroups: string
  hideFiles: string
}

const emptyShareForm: ShareFormState = {
  name: '',
  path: '',
  description: '',
  readOnly: true,
  guestAccess: false,
  browsable: true,
  validUsers: '',
  validGroups: '',
  hideFiles: '',
}

function shareToForm(share: SmbShare): ShareFormState {
  return {
    name: share.name,
    path: share.path,
    description: share.description,
    readOnly: share.readOnly,
    guestAccess: share.guestAccess,
    browsable: share.browsable,
    validUsers: share.validUsers.join(', '),
    validGroups: share.validGroups.join(', '),
    hideFiles: share.hideFiles,
  }
}

function splitList(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function statusBadge(status: SmbHealth['status']) {
  switch (status) {
    case 'running':
      return <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700">Running</span>
    case 'stopped':
      return <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-700">Stopped</span>
    case 'reload_required':
      return <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700">Reload Required</span>
    case 'config_error':
      return <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-700">Configuration Error</span>
    default:
      return <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-bold text-slate-600">Unavailable</span>
  }
}

function parseForm(form: ShareFormState) {
  return {
    name: form.name,
    path: form.path,
    description: form.description,
    readOnly: form.readOnly,
    guestAccess: form.guestAccess,
    browsable: form.browsable,
    validUsers: splitList(form.validUsers),
    validGroups: splitList(form.validGroups),
    hideFiles: form.hideFiles,
  }
}

export function SmbPage() {
  const [health, setHealth] = useState<SmbHealth | null>(null)
  const [shares, setShares] = useState<SmbShare[]>([])
  const [users, setUsers] = useState<SmbUser[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [editShare, setEditShare] = useState<SmbShare | null>(null)
  const [deleteShare, setDeleteShare] = useState<SmbShare | null>(null)
  const [shareForm, setShareForm] = useState<ShareFormState>(emptyShareForm)

  const [userModal, setUserModal] = useState<null | { mode: 'create' } | { mode: 'reset'; user: SmbUser }>(null)
  const [deleteUser, setDeleteUser] = useState<SmbUser | null>(null)
  const [userName, setUserName] = useState('')
  const [userPassword, setUserPassword] = useState('')

  async function load() {
    setLoading(true)
    try {
      const [healthData, sharesData, usersData] = await Promise.all([
        apiFetch<SmbHealth>('/smb/status'),
        apiFetch<{ shares: SmbShare[] }>('/smb'),
        apiFetch<{ users: SmbUser[] }>('/smb/users'),
      ])
      setHealth(healthData)
      setShares(sharesData.shares)
      setUsers(usersData.users)
      setMessage('')
    } catch (error) {
      setHealth(null)
      setMessage(error instanceof Error ? error.message : 'Failed to load SMB status.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().catch(() => undefined)
  }, [])

  async function reloadConfig() {
    setBusy(true)
    setMessage('')
    try {
      const result = await apiFetch<{ status: string; message: string }>('/smb/reload', { method: 'POST' })
      setMessage(result.message)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to reload Samba.')
    } finally {
      setBusy(false)
      await load().catch(() => undefined)
    }
  }

  async function createShare(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      await apiFetch('/smb', { method: 'POST', body: JSON.stringify(parseForm(shareForm)) })
      setCreateOpen(false)
      setShareForm(emptyShareForm)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to create share.')
    } finally {
      setBusy(false)
    }
  }

  async function saveShare(event: FormEvent) {
    event.preventDefault()
    if (!editShare) return
    setBusy(true)
    setMessage('')
    try {
      await apiFetch(`/smb/${encodeURIComponent(editShare.id)}`, { method: 'PUT', body: JSON.stringify(parseForm(shareForm)) })
      setEditShare(null)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to update share.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmDeleteShare() {
    if (!deleteShare) return
    setBusy(true)
    setMessage('')
    try {
      await apiFetch(`/smb/${encodeURIComponent(deleteShare.id)}`, { method: 'DELETE' })
      setDeleteShare(null)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete share.')
    } finally {
      setBusy(false)
    }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      await apiFetch('/smb/users', { method: 'POST', body: JSON.stringify({ name: userName, password: userPassword }) })
      setUserModal(null)
      setUserName('')
      setUserPassword('')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to create user.')
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault()
    if (!userModal || userModal.mode !== 'reset') return
    setBusy(true)
    setMessage('')
    try {
      await apiFetch(`/smb/users/${encodeURIComponent(userModal.user.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ password: userPassword }),
      })
      setUserModal(null)
      setUserPassword('')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to reset password.')
    } finally {
      setBusy(false)
    }
  }

  async function toggleUser(user: SmbUser) {
    setBusy(true)
    setMessage('')
    try {
      await apiFetch(`/smb/users/${encodeURIComponent(user.id)}`, { method: 'PUT', body: JSON.stringify({ enabled: !user.enabled }) })
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Failed to ${user.enabled ? 'disable' : 'enable'} user.`)
    } finally {
      setBusy(false)
    }
  }

  async function confirmDeleteUser() {
    if (!deleteUser) return
    setBusy(true)
    setMessage('')
    try {
      await apiFetch(`/smb/users/${encodeURIComponent(deleteUser.id)}`, { method: 'DELETE' })
      setDeleteUser(null)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete user.')
    } finally {
      setBusy(false)
    }
  }

  function openCreate() {
    setShareForm(emptyShareForm)
    setCreateOpen(true)
  }

  function openEdit(share: SmbShare) {
    setEditShare(share)
    setShareForm(shareToForm(share))
  }

  const readOnlyCount = useMemo(() => shares.filter((share) => share.readOnly).length, [shares])
  const enabledUsers = useMemo(() => users.filter((user) => user.enabled).length, [users])

  const unavailable = health && !health.available

  return (
    <>
      <PageHeader
        title="SMB"
        description="Manage Samba shares and users. The SMB server itself is provided by Samba on this machine."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => load().catch(() => undefined)} disabled={loading} title="Refresh">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="outline" size="sm" onClick={reloadConfig} disabled={busy || !health?.available}>
              <Activity className="h-4 w-4" />Reload
            </Button>
            <Button size="sm" onClick={openCreate} disabled={!health?.available || busy}>
              <Plus className="h-4 w-4" />Create Share
            </Button>
          </>
        }
      />

      {message ? <p className="mt-5 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}

      {/* Health card */}
      <Card className="mt-6 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-600 text-white">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <p className="font-extrabold">Samba Service</p>
              <p className="mt-0.5 text-sm text-slate-500">
                {loading ? 'Checking...' : health ? `Version ${health.version ?? 'unknown'} · ${health.service ?? 'service'} · ${health.configPath ?? ''}` : 'Status unknown'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {health?.status === 'running' ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : health?.status === 'config_error' ? <XCircle className="h-5 w-5 text-red-500" /> : <AlertTriangle className="h-5 w-5 text-amber-500" />}
            {health ? statusBadge(health.status) : <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-bold text-slate-600">Unknown</span>}
          </div>
        </div>
        {unavailable || health?.status === 'config_error' ? (
          <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{health?.message ?? 'Samba is not available on this machine.'}</p>
        ) : null}
      </Card>

      {/* Metric tiles */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <FolderOpen className="h-5 w-5 text-blue-600" />
          <p className="mt-3 text-2xl font-extrabold">{shares.length}</p>
          <p className="text-sm text-slate-500">Shares</p>
        </Card>
        <Card className="p-4">
          <KeyRound className="h-5 w-5 text-emerald-600" />
          <p className="mt-3 text-2xl font-extrabold">{readOnlyCount}</p>
          <p className="text-sm text-slate-500">Read-only shares</p>
        </Card>
        <Card className="p-4">
          <Users className="h-5 w-5 text-indigo-600" />
          <p className="mt-3 text-2xl font-extrabold">{enabledUsers}</p>
          <p className="text-sm text-slate-500">Enabled SMB users</p>
        </Card>
      </div>

      {/* Shares table */}
      <Card className="mt-6 min-w-0 overflow-hidden p-0">
        <div className="border-b border-slate-200 p-4 sm:p-5">
          <h2 className="text-lg font-extrabold">Shares</h2>
          <p className="mt-1 text-sm text-slate-500">Shares are defined in smb.conf and applied with a Samba reload.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/60 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-bold">Name</th>
                <th className="px-5 py-3 font-bold">Path</th>
                <th className="px-5 py-3 font-bold">Read Only</th>
                <th className="px-5 py-3 font-bold">Guest</th>
                <th className="px-5 py-3 font-bold">Users</th>
                <th className="px-5 py-3 font-bold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shares.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-slate-500">
                    {unavailable ? 'Samba is unavailable on this machine.' : 'No shares yet. Create your first share to get started.'}
                  </td>
                </tr>
              ) : (
                shares.map((share) => (
                  <tr key={share.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60">
                    <td className="px-5 py-3.5">
                      <p className="font-bold text-slate-950">{share.name}</p>
                      {share.description ? <p className="mt-0.5 text-xs text-slate-500">{share.description}</p> : null}
                    </td>
                    <td className="max-w-[220px] truncate px-5 py-3.5 font-mono text-xs text-slate-600" title={share.path}>{share.path}</td>
                    <td className="px-5 py-3.5">
                      {share.readOnly ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-700">Read only</span> : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">Read/Write</span>}
                    </td>
                    <td className="px-5 py-3.5">
                      {share.guestAccess ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">Guest OK</span> : <span className="text-xs text-slate-400">No</span>}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-600">
                      {share.validUsers.length > 0 || share.validGroups.length > 0 ? (
                        <span className="line-clamp-1">
                          {[...share.validUsers, ...share.validGroups.map((group) => `@${group}`)].join(', ')}
                        </span>
                      ) : (
                        <span className="text-slate-400">Everyone</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(share)} title="Edit share">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteShare(share)} title="Delete share" className="text-orange-600 hover:bg-orange-50">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Users */}
      <Card className="mt-6 min-w-0 p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4 sm:p-5">
          <div>
            <h2 className="text-lg font-extrabold">SMB Users</h2>
            <p className="mt-1 text-sm text-slate-500">Users are stored in Samba's password database. Passwords are never stored in 9Drive.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setUserName(''); setUserPassword(''); setUserModal({ mode: 'create' }) }} disabled={!health?.available || busy}>
            <UserPlus className="h-4 w-4" />Add User
          </Button>
        </div>
        <div className="grid gap-2 p-4 sm:p-5">
          {users.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-300 p-5 text-center text-sm text-slate-500">No SMB users yet.</p>
          ) : (
            users.map((user) => (
              <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-50 p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-950">{user.name}</p>
                    <p className="text-xs text-slate-500">{user.enabled ? 'Enabled' : 'Disabled'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => { setUserPassword(''); setUserModal({ mode: 'reset', user }) }} title="Reset password">
                    <KeyRound className="h-4 w-4" />Reset Password
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggleUser(user)} disabled={busy} title={user.enabled ? 'Disable user' : 'Enable user'}>
                    {user.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-orange-600 hover:bg-orange-50" onClick={() => setDeleteUser(user)} title="Delete user">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Create share modal */}
      <DummyModal open={createOpen} title="Create Share" description="Define a new SMB share. The path must be an existing directory on this machine." onClose={() => setCreateOpen(false)} className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={createShare}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-500">Name</span>
              <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.name} onChange={(event) => setShareForm((f) => ({ ...f, name: event.target.value }))} required placeholder="Movies" />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-500">Path</span>
              <input className="h-11 rounded-xl border border-slate-200 px-3 font-mono text-sm focus:border-blue-500 focus:outline-none" value={shareForm.path} onChange={(event) => setShareForm((f) => ({ ...f, path: event.target.value }))} required placeholder="/srv/media/movies" />
            </label>
          </div>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">Description</span>
            <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.description} onChange={(event) => setShareForm((f) => ({ ...f, description: event.target.value }))} placeholder="Movie library" />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">Hide files</span>
            <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.hideFiles} onChange={(event) => setShareForm((f) => ({ ...f, hideFiles: event.target.value }))} placeholder="/.*\.DS_Store/ /desktop.ini/" />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 p-3">
              <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={shareForm.readOnly} onChange={(event) => setShareForm((f) => ({ ...f, readOnly: event.target.checked }))} />
              <span className="text-sm font-semibold text-slate-700">Read only</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 p-3">
              <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={shareForm.guestAccess} onChange={(event) => setShareForm((f) => ({ ...f, guestAccess: event.target.checked }))} />
              <span className="text-sm font-semibold text-slate-700">Guest access</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 p-3">
              <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={shareForm.browsable} onChange={(event) => setShareForm((f) => ({ ...f, browsable: event.target.checked }))} />
              <span className="text-sm font-semibold text-slate-700">Browsable</span>
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-500">Allowed users</span>
              <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.validUsers} onChange={(event) => setShareForm((f) => ({ ...f, validUsers: event.target.value }))} placeholder="media, alice" />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-500">Allowed groups</span>
              <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.validGroups} onChange={(event) => setShareForm((f) => ({ ...f, validGroups: event.target.value }))} placeholder="family, friends" />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" type="button" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Share'}</Button>
          </div>
        </form>
      </DummyModal>

      {/* Edit share modal */}
      <DummyModal open={Boolean(editShare)} title="Edit Share" description={editShare ? `Update share '${editShare.name}' — Samba will be reloaded to apply changes.` : ''} onClose={() => setEditShare(null)} className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={saveShare}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-500">Name</span>
              <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.name} onChange={(event) => setShareForm((f) => ({ ...f, name: event.target.value }))} required />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-500">Path</span>
              <input className="h-11 rounded-xl border border-slate-200 px-3 font-mono text-sm focus:border-blue-500 focus:outline-none" value={shareForm.path} onChange={(event) => setShareForm((f) => ({ ...f, path: event.target.value }))} required />
            </label>
          </div>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">Description</span>
            <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.description} onChange={(event) => setShareForm((f) => ({ ...f, description: event.target.value }))} />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 p-3">
              <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={shareForm.readOnly} onChange={(event) => setShareForm((f) => ({ ...f, readOnly: event.target.checked }))} />
              <span className="text-sm font-semibold text-slate-700">Read only</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 p-3">
              <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={shareForm.guestAccess} onChange={(event) => setShareForm((f) => ({ ...f, guestAccess: event.target.checked }))} />
              <span className="text-sm font-semibold text-slate-700">Guest access</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 p-3">
              <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={shareForm.browsable} onChange={(event) => setShareForm((f) => ({ ...f, browsable: event.target.checked }))} />
              <span className="text-sm font-semibold text-slate-700">Browsable</span>
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-500">Allowed users</span>
              <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.validUsers} onChange={(event) => setShareForm((f) => ({ ...f, validUsers: event.target.value }))} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-500">Allowed groups</span>
              <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={shareForm.validGroups} onChange={(event) => setShareForm((f) => ({ ...f, validGroups: event.target.value }))} />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" type="button" onClick={() => setEditShare(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Changes'}</Button>
          </div>
        </form>
      </DummyModal>

      {/* Delete share confirm */}
      <DummyModal open={Boolean(deleteShare)} title="Delete share?" description="This removes the share from smb.conf. The files on disk are NOT deleted." onClose={() => setDeleteShare(null)}>
        <p className="text-sm text-slate-600">Are you sure you want to delete the share <b>{deleteShare?.name}</b>?</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={() => setDeleteShare(null)} disabled={busy}>Cancel</Button>
          <Button variant="danger" type="button" onClick={confirmDeleteShare} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete Share
          </Button>
        </div>
      </DummyModal>

      {/* Create user modal */}
      <DummyModal open={userModal?.mode === 'create'} title="Add SMB User" description="Creates a user in Samba's password database (pdbedit)." onClose={() => setUserModal(null)}>
        <form className="grid gap-4" onSubmit={createUser}>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">Username</span>
            <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={userName} onChange={(event) => setUserName(event.target.value)} required placeholder="media" />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">Password</span>
            <input type="password" className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={userPassword} onChange={(event) => setUserPassword(event.target.value)} required minLength={8} placeholder="At least 8 characters" />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" type="button" onClick={() => setUserModal(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create User'}</Button>
          </div>
        </form>
      </DummyModal>

      {/* Reset password modal */}
      <DummyModal open={userModal?.mode === 'reset'} title="Reset Password" description={userModal?.mode === 'reset' ? `Set a new password for '${userModal.user.name}'.` : ''} onClose={() => setUserModal(null)}>
        <form className="grid gap-4" onSubmit={resetPassword}>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">New password</span>
            <input type="password" className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={userPassword} onChange={(event) => setUserPassword(event.target.value)} required minLength={8} placeholder="At least 8 characters" />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" type="button" onClick={() => setUserModal(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Set Password'}</Button>
          </div>
        </form>
      </DummyModal>

      {/* Delete user confirm */}
      <DummyModal open={Boolean(deleteUser)} title="Delete user?" description="Removes the SMB user from Samba's password database. Files are not affected." onClose={() => setDeleteUser(null)}>
        <p className="text-sm text-slate-600">Are you sure you want to delete the SMB user <b>{deleteUser?.name}</b>?</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={() => setDeleteUser(null)} disabled={busy}>Cancel</Button>
          <Button variant="danger" type="button" onClick={confirmDeleteUser} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete User
          </Button>
        </div>
      </DummyModal>
    </>
  )
}
