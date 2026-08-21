import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Crown,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Collapsible } from '@/components/ui/collapsible'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { timeAgo } from '@/lib/utils'
import {
  createWorker,
  deleteWorker,
  disableWorker,
  enableWorker,
  forceDeleteWorkerLocal,
  listWorkerDrivers,
  listWorkers,
  setDefaultWorker,
  testWorker,
  updateWorker,
  workerStatusBadgeClass,
  workerStatusLabel,
  type CreateWorkerInput,
  type WorkerDriverField,
  type WorkerDriverMetadata,
  type WorkerItem,
} from '@/lib/workers'

/** Form = Service selector + driver-registered fields (+ product toggles). */
type WorkerFormState = {
  driver: string
  fields: Record<string, string>
  isEnabled: boolean
  isDefault: boolean
}

const emptyWorkerForm: WorkerFormState = {
  driver: '',
  fields: {},
  isEnabled: true,
  isDefault: false,
}

export function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerItem[]>([])
  const [drivers, setDrivers] = useState<WorkerDriverMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [editWorker, setEditWorker] = useState<WorkerItem | null>(null)
  const [deleteWorkerRow, setDeleteWorkerRow] = useState<WorkerItem | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string>('')

  const [form, setForm] = useState<WorkerFormState>(emptyWorkerForm)

  const selectedDriver = useMemo(
    () => drivers.find((d) => d.key === form.driver) ?? null,
    [drivers, form.driver],
  )

  async function load() {
    try {
      const [workerRows, driverRows] = await Promise.all([listWorkers(), listWorkerDrivers()])
      setWorkers(workerRows)
      setDrivers(driverRows)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().catch(() => setLoading(false))
  }, [])

  const enabledCount = useMemo(() => workers.filter((w) => w.isEnabled).length, [workers])
  const defaultWorker = useMemo(() => workers.find((w) => w.isDefault), [workers])

  function openCreate() {
    setForm({ ...emptyWorkerForm, driver: drivers[0]?.key ?? '' })
    setCreateOpen(true)
  }

  function openEdit(worker: WorkerItem) {
    setEditWorker(worker)
    const driver = drivers.find((d) => d.key === worker.driver)
    const fields: Record<string, string> = {}
    if (driver?.managed) {
      // Safe provider config (accountId / workerName) is surfaced by the API
      // (never tokens) — prefill those; credential fields stay blank = keep.
      for (const field of driver.fields) {
        if (field.key === 'apiToken' || field.secret) continue
        const value = worker.providerConfig?.[field.key]
        if (typeof value === 'string') fields[field.key] = value
      }
    } else {
      // Manual driver: prefill the stored top-level columns.
      fields.name = worker.name
      fields.endpointUrl = worker.endpointUrl ?? ''
      fields.region = worker.region ?? ''
      fields.authType = worker.authType
      fields.description = worker.description ?? ''
    }
    setForm({
      driver: worker.driver,
      fields,
      isEnabled: worker.isEnabled,
      isDefault: worker.isDefault,
    })
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const payload: CreateWorkerInput = {
        name: selectedDriver?.managed ? undefined : (form.fields.name ?? ''),
        driver: form.driver,
        isEnabled: form.isEnabled,
        isDefault: form.isDefault,
      }
      if (selectedDriver?.managed) {
        // Provider registration fields → config; blank credential = keep on edit.
        const config: Record<string, string> = {}
        for (const field of selectedDriver.fields) {
          if (field.type === 'password' && editWorker && !form.fields[field.key]) continue
          if (form.fields[field.key] !== undefined && form.fields[field.key] !== '') {
            config[field.key] = form.fields[field.key]
          }
        }
        payload.config = config
      } else {
        payload.endpointUrl = form.fields.endpointUrl ?? ''
        payload.authType = (form.fields.authType as CreateWorkerInput['authType']) ?? 'none'
        payload.secret = form.fields.secret || undefined
        payload.region = form.fields.region || null
        payload.description = form.fields.description || null
      }
      if (editWorker) {
        await updateWorker(editWorker.id, payload)
        setMessage('Worker updated.')
      } else {
        await createWorker(payload)
        setMessage('Worker created.')
      }
      setCreateOpen(false)
      setEditWorker(null)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save worker.')
    } finally {
      setBusy(false)
    }
  }

  function setField(key: string, value: string) {
    setForm((f) => ({ ...f, fields: { ...f.fields, [key]: value } }))
  }

  async function handleTest(worker: WorkerItem) {
    setTestingId(worker.id)
    setMessage('')
    setTestResult('')
    try {
      const result = await testWorker(worker.id)
      setTestResult(result.status === 'healthy' ? `${worker.name}: connection healthy.` : `${worker.name}: ${workerStatusLabel(result.status)} — ${result.lastErrorCode ?? ''}`)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Connection test failed.')
    } finally {
      setTestingId(null)
    }
  }

  async function toggleEnabled(worker: WorkerItem) {
    setBusy(true)
    setMessage('')
    try {
      if (worker.isEnabled) await disableWorker(worker.id)
      else await enableWorker(worker.id)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to toggle worker.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSetDefault(worker: WorkerItem) {
    setBusy(true)
    setMessage('')
    try {
      await setDefaultWorker(worker.id)
      setMessage(`"${worker.name}" is now the default worker.`)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to set default worker.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    if (!deleteWorkerRow) return
    setBusy(true)
    setMessage('')
    try {
      await deleteWorker(deleteWorkerRow.id)
      setMessage(`"${deleteWorkerRow.name}" deleted.`)
      setDeleteWorkerRow(null)
      await load()
    } catch (error) {
      // Keep the modal open so the admin can choose the local-only fallback
      // after a genuine provider failure.
      setMessage(error instanceof Error ? error.message : 'Failed to delete worker.')
    } finally {
      setBusy(false)
    }
  }

  /** Admin fallback — local record only; the remote relay may remain. */
  async function confirmForceDeleteLocal() {
    if (!deleteWorkerRow) return
    setBusy(true)
    setMessage('')
    try {
      const result = await forceDeleteWorkerLocal(deleteWorkerRow.id)
      setMessage(result.message ?? `"${deleteWorkerRow.name}" deleted locally.`)
      setDeleteWorkerRow(null)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete worker locally.')
    } finally {
      setBusy(false)
    }
  }

  const driverName = (key: string) => drivers.find((d) => d.key === key)?.displayName ?? key
  const driverManaged = (key: string) => Boolean(drivers.find((d) => d.key === key)?.managed)
  const transientStatus = (s: string) => s === 'provisioning' || s === 'provision_failed'

  /** Render one driver-registered field (label/type/required/help). */
  function renderDriverField(field: WorkerDriverField, editing: boolean) {
    const isSecret = field.type === 'password'
    const hasCredential = editing && isSecret && editWorker?.credentialConfigured
    const common = 'h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none'
    return (
      <label key={field.key} className="grid gap-1.5">
        <span className="text-xs font-bold text-slate-500">
          {field.label}
          {isSecret && field.secret ? <span className="ml-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">Secret</span> : null}
          {hasCredential ? <span className="ml-1 font-normal text-emerald-600">(Credential configured — leave blank to keep)</span> : null}
        </span>
        {field.type === 'select' ? (
          <select
            className={common}
            value={form.fields[field.key] ?? ''}
            onChange={(e) => setField(field.key, e.target.value)}
            required={field.required}
          >
            {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            type={isSecret ? 'password' : 'text'}
            className={common}
            value={form.fields[field.key] ?? ''}
            onChange={(e) => setField(field.key, e.target.value)}
            required={field.required && !(editing && isSecret)}
            placeholder={hasCredential ? '••••••••••••' : ''}
          />
        )}
        {field.help ? <span className="text-xs text-slate-400">{field.help}</span> : null}
        {/* Cloudflare API Token: inline tutorial for the required permissions —
            missing permissions are the #1 cause of provisioning failures. */}
        {field.key === 'apiToken' ? <ApiTokenTutorial /> : null}
      </label>
    )
  }

  /** Step-by-step Cloudflare API token creation (see docs/WORKERS.md). */
  function ApiTokenTutorial() {
    return (
      <Collapsible title="How to create an API token" defaultOpen={false}>
        <ol className="list-none space-y-2 text-xs text-slate-600">
          <li>
            <b className="text-slate-700">1.</b> Open{' '}
            <a
              href="https://dash.cloudflare.com/profile/api-tokens"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:underline"
            >
              dash.cloudflare.com → My Profile → API Tokens <ExternalLink className="h-3 w-3" />
            </a>
            .
          </li>
          <li>
            <b className="text-slate-700">2.</b> <span className="font-semibold text-slate-700">Create Token</span> and pick the{' '}
            <span className="font-semibold text-slate-700">Edit Cloudflare Workers</span> template.
          </li>
          <li>
            <b className="text-slate-700">3.</b> Select the account you registered above and keep zone permissions at{' '}
            <span className="font-semibold text-slate-700">All zones</span> (or the zone hosting your Worker).
          </li>
          <li>
            <b className="text-slate-700">4.</b> Create the token and copy it here. It needs at least:
            <ul className="mt-1 space-y-1 pl-1">
              <li>· <span className="font-semibold text-slate-700">Workers Scripts: Edit</span></li>
              <li>· <span className="font-semibold text-slate-700">Workers R2 Storage: Edit</span> (if you later use R2)</li>
            </ul>
          </li>
          <li>
            <b className="text-slate-700">5.</b> 9Drive deploys the relay Worker automatically — no dashboard setup needed beyond the token.
          </li>
        </ol>
        <p className="text-xs text-slate-400">
          The token is encrypted on 9Drive and never shown again. If provisioning fails with “credentials invalid”, check that the
          token has the <b>Workers Scripts: Edit</b> permission for this account.
        </p>
      </Collapsible>
    )
  }

  function renderManualFields() {
    return (
      <>
        <label className="grid gap-1.5">
          <span className="text-xs font-bold text-slate-500">Name</span>
          <input
            className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none"
            value={form.fields.name ?? ''}
            onChange={(e) => setField('name', e.target.value)}
            required
            placeholder="Cloudflare SG #1"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-bold text-slate-500">Endpoint URL</span>
          <input
            className="h-11 rounded-xl border border-slate-200 px-3 font-mono text-sm focus:border-blue-500 focus:outline-none"
            value={form.fields.endpointUrl ?? ''}
            onChange={(e) => setField('endpointUrl', e.target.value)}
            required
            placeholder="https://relay.example.workers.dev"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">Region</span>
            <input
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none"
              value={form.fields.region ?? ''}
              onChange={(e) => setField('region', e.target.value)}
              placeholder="Singapore"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">Authentication</span>
            <select
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none"
              value={form.fields.authType ?? 'hmac'}
              onChange={(e) => setField('authType', e.target.value)}
            >
              <option value="hmac">HMAC</option>
              <option value="bearer">Bearer token</option>
              <option value="none">None</option>
            </select>
          </label>
        </div>
        <label className="grid gap-1.5">
          <span className="text-xs font-bold text-slate-500">
            Shared Secret {editWorker && editWorker.credentialConfigured ? <span className="font-normal text-emerald-600">(Already configured — leave blank to keep)</span> : null}
          </span>
          <input
            type="password"
            className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none"
            value={form.fields.secret ?? ''}
            onChange={(e) => setField('secret', e.target.value)}
            placeholder={editWorker?.credentialConfigured ? '••••••••••••' : 'Shared secret or bearer token'}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-bold text-slate-500">Description</span>
          <input
            className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none"
            value={form.fields.description ?? ''}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="Primary relay for Asia"
          />
        </label>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Workers"
        description="Remote Fetch Workers are network relays only — 9Drive still performs the download, HLS conversion, and upload."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => load().catch(() => undefined)} disabled={loading} title="Refresh">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button size="sm" onClick={openCreate} disabled={busy}>
              <Plus className="h-4 w-4" />Add Worker
            </Button>
          </>
        }
      />

      {message ? <p className="mt-5 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}
      {testResult ? <p className="mt-5 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{testResult}</p> : null}

      {/* Metric tiles */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <Server className="h-5 w-5 text-blue-600" />
          <p className="mt-3 text-2xl font-extrabold">{workers.length}</p>
          <p className="text-sm text-slate-500">Workers</p>
        </Card>
        <Card className="p-4">
          <Wifi className="h-5 w-5 text-emerald-600" />
          <p className="mt-3 text-2xl font-extrabold">{enabledCount}</p>
          <p className="text-sm text-slate-500">Enabled</p>
        </Card>
        <Card className="p-4">
          <Crown className="h-5 w-5 text-amber-600" />
          <p className="mt-3 text-2xl font-extrabold">{defaultWorker ? defaultWorker.name : '—'}</p>
          <p className="text-sm text-slate-500">Default</p>
        </Card>
      </div>

      {/* Workers table */}
      <Card className="mt-6 min-w-0 overflow-hidden p-0">
        <div className="border-b border-slate-200 p-4 sm:p-5">
          <h2 className="text-lg font-extrabold">Registered Workers</h2>
          <p className="mt-1 text-sm text-slate-500">Route Remote Import traffic through an external relay, or keep using Direct.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/60 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-bold">Worker</th>
                <th className="px-5 py-3 font-bold">Service</th>
                <th className="px-5 py-3 font-bold">Endpoint</th>
                <th className="px-5 py-3 font-bold">Status</th>
                <th className="px-5 py-3 font-bold">Default</th>
                <th className="px-5 py-3 font-bold">Last Check</th>
                <th className="px-5 py-3 font-bold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {workers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                    No workers registered yet. Add a worker to route Remote Import traffic through an external relay.
                  </td>
                </tr>
              ) : (
                workers.map((worker) => (
                  <tr key={worker.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60">
                    <td className="px-5 py-3.5">
                      <p className="font-bold text-slate-950">{worker.name}</p>
                      {worker.credentialConfigured ? <p className="mt-0.5 text-xs text-slate-400">Credential configured</p> : null}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-600">{driverName(worker.driver)}</td>
                    <td className="max-w-[220px] truncate px-5 py-3.5 font-mono text-xs text-slate-600" title={worker.endpointUrl ?? undefined}>
                      {worker.endpointUrl ?? '—'}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${workerStatusBadgeClass(worker.status)}`}>{workerStatusLabel(worker.status)}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      {worker.isDefault ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">Default</span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-600">{timeAgo(worker.lastHealthCheckAt)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1">
                        {!transientStatus(worker.status) ? (
                          <Button variant="ghost" size="sm" onClick={() => handleTest(worker)} disabled={testingId === worker.id} title="Test connection">
                            {testingId === worker.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => openEdit(worker)} title="Edit worker">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => toggleEnabled(worker)} disabled={busy || transientStatus(worker.status)} title={worker.isEnabled ? 'Disable worker' : 'Enable worker'}>
                          {worker.isEnabled ? <WifiOff className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
                        </Button>
                        {!worker.isDefault ? (
                          <Button variant="ghost" size="sm" onClick={() => handleSetDefault(worker)} disabled={!worker.isEnabled || busy || transientStatus(worker.status)} title="Set as default" className="text-amber-600 hover:bg-amber-50">
                            <Crown className="h-4 w-4" />
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => setDeleteWorkerRow(worker)} title="Delete worker" className="text-orange-600 hover:bg-orange-50">
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

      {/* Create / Edit worker modal */}
      <DummyModal
        open={createOpen || Boolean(editWorker)}
        title={editWorker ? `Edit Worker — ${editWorker.name}` : 'Add Worker'}
        description={
          selectedDriver?.managed
            ? '9Drive provisions and manages the relay through the provider. Credentials are encrypted on 9Drive and never shown again.'
            : 'Workers are network relays for Remote Imports. Credentials are encrypted on 9Drive and never shown again.'
        }
        onClose={() => { setCreateOpen(false); setEditWorker(null) }}
        className="sm:max-w-lg"
      >
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-slate-500">Service</span>
            <select className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none" value={form.driver} onChange={(event) => setForm((f) => ({ ...f, driver: event.target.value, fields: {} }))} disabled={Boolean(editWorker)} required>
              {drivers.length === 0 ? <option value="">No services available</option> : null}
              {drivers.map((driver) => (
                <option key={driver.key} value={driver.key}>{driver.displayName}</option>
              ))}
            </select>
          </label>

          {selectedDriver?.managed
            ? selectedDriver.fields.map((field) => renderDriverField(field, Boolean(editWorker)))
            : renderManualFields()}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 p-3">
              <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={form.isEnabled} onChange={(event) => setForm((f) => ({ ...f, isEnabled: event.target.checked }))} />
              <span className="text-sm font-semibold text-slate-700">Enabled</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 p-3">
              <input type="checkbox" className="h-4 w-4 accent-amber-600" checked={form.isDefault} onChange={(event) => setForm((f) => ({ ...f, isDefault: event.target.checked }))} />
              <span className="text-sm font-semibold text-slate-700">Set as default</span>
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" type="button" onClick={() => { setCreateOpen(false); setEditWorker(null) }} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? <><Loader2 className="h-4 w-4 animate-spin" />{selectedDriver?.managed ? 'Deploying…' : 'Saving…'}</>
                : editWorker ? 'Save Changes' : 'Add Worker'}
            </Button>
          </div>
        </form>
      </DummyModal>

      {/* Delete confirm */}
      <DummyModal open={Boolean(deleteWorkerRow)} title="Delete worker?" description={driverManaged(deleteWorkerRow?.driver ?? '') ? 'This also removes the deployed relay at the provider (already-absent relays delete cleanly).' : 'The worker is removed from the registry. Historical Remote Imports keep their record of it.'} onClose={() => setDeleteWorkerRow(null)}>
        <p className="text-sm text-slate-600">Are you sure you want to delete <b>{deleteWorkerRow?.name}</b>?</p>
        {driverManaged(deleteWorkerRow?.driver ?? '') ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3">
            <p className="text-xs font-bold text-red-700">Delete local record only?</p>
            <p className="mt-1 text-xs text-red-600">
              Only removes the record from 9Drive — the remote relay may still exist at the provider. Use this only when the provider
              refuses to remove the relay (for example, a stale or dummy worker). The action is audited.
            </p>
            <Button
              variant="outline"
              type="button"
              size="sm"
              className="mt-2 border-red-200 text-red-700 hover:bg-red-100"
              onClick={confirmForceDeleteLocal}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete local record only
            </Button>
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={() => setDeleteWorkerRow(null)} disabled={busy}>Cancel</Button>
          <Button variant="danger" type="button" onClick={confirmDelete} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete Worker
          </Button>
        </div>
      </DummyModal>

      {/* Test result hints for status icons */}
      {workers.some((w) => w.status === 'unhealthy') ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-amber-700">
          <AlertTriangle className="h-4 w-4" /> One or more workers reported an unhealthy status. Use the test action to re-check.
        </p>
      ) : null}
    </>
  )
}