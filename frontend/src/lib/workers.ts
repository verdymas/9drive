import { apiFetch } from '@/lib/api'

/** Health status of a registered Remote Fetch Worker. */
export type WorkerStatus = 'unknown' | 'healthy' | 'unhealthy' | 'disabled' | 'provisioning' | 'provision_failed'

/** Safe serialized worker shape — never carries encrypted/decrypted secrets. */
export type WorkerItem = {
  id: string
  name: string
  slug: string | null
  driver: string
  /** System-generated after provisioning; null while provisioning / on failure. */
  endpointUrl: string | null
  isEnabled: boolean
  isDefault: boolean
  priority: number | null
  region: string | null
  description: string | null
  authType: 'hmac' | 'bearer' | 'none'
  /** True when a credential (shared secret / token) is stored. Never the value. */
  credentialConfigured: boolean
  /** Safe provider config (e.g. accountId / workerName) for the edit form. Never tokens. */
  providerConfig: Record<string, string> | null
  capabilitiesJson: Record<string, unknown> | null
  metadataJson: Record<string, unknown> | null
  status: WorkerStatus
  lastHealthCheckAt: string | null
  lastHealthyAt: string | null
  lastFailedAt: string | null
  lastErrorCode: string | null
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

/** A driver-registered form field (registration credentials for managed drivers). */
export type WorkerDriverField = {
  key: string
  label: string
  type: 'text' | 'password' | 'select' | 'number'
  secret?: boolean
  required?: boolean
  options?: string[]
  help?: string
  /** Managed drivers: the worker display name derives from this field. */
  autoFillNameFrom?: string
}

/** Safe driver metadata from GET /workers/drivers (spec §44). */
export type WorkerDriverMetadata = {
  key: string
  displayName: string
  /** true = 9Drive provisions/manages the remote deployment. */
  managed: boolean
  authTypes: Array<'hmac' | 'bearer' | 'none'>
  fields: WorkerDriverField[]
}

export type CreateWorkerInput = {
  /** Optional — managed drivers derive it from the worker-name field. */
  name?: string
  driver: string
  /** Managed drivers: provider registration fields. */
  config?: Record<string, string>
  /** Manual drivers only. */
  endpointUrl?: string
  authType?: 'hmac' | 'bearer' | 'none'
  /** Manual drivers only. Blank/absent = keep existing on update. */
  secret?: string
  region?: string | null
  description?: string | null
  isEnabled?: boolean
  isDefault?: boolean
}

export type UpdateWorkerInput = Partial<CreateWorkerInput>

export type WorkerTestResult = {
  status: 'healthy' | 'unhealthy'
  lastHealthCheckAt: string
  lastErrorCode?: string | null
}

export async function listWorkers(): Promise<WorkerItem[]> {
  const data = await apiFetch<{ items: WorkerItem[] }>('/workers')
  return data.items
}

export async function listWorkerDrivers(): Promise<WorkerDriverMetadata[]> {
  const data = await apiFetch<{ drivers: WorkerDriverMetadata[] }>('/workers/drivers')
  return data.drivers
}

export async function createWorker(input: CreateWorkerInput): Promise<WorkerItem> {
  return apiFetch<WorkerItem>('/workers', { method: 'POST', body: JSON.stringify(input) })
}

export async function updateWorker(id: string, input: UpdateWorkerInput): Promise<WorkerItem> {
  return apiFetch<WorkerItem>(`/workers/${id}`, { method: 'PATCH', body: JSON.stringify(input) })
}

export async function deleteWorker(id: string): Promise<void> {
  await apiFetch<void>(`/workers/${id}`, { method: 'DELETE' })
}

/**
 * Admin fallback — explicitly confirmed, audited server-side. Removes the
 * local record ONLY; the remote relay may remain at the provider.
 */
export async function forceDeleteWorkerLocal(id: string): Promise<{ message: string }> {
  return apiFetch<{ message: string }>(`/workers/${id}/force-delete`, {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  })
}

export async function testWorker(id: string): Promise<WorkerTestResult> {
  const data = await apiFetch<{ result: WorkerTestResult }>(`/workers/${id}/test`, { method: 'POST' })
  return data.result
}

export async function enableWorker(id: string): Promise<WorkerItem> {
  return apiFetch<WorkerItem>(`/workers/${id}/enable`, { method: 'POST' })
}

export async function disableWorker(id: string): Promise<WorkerItem> {
  return apiFetch<WorkerItem>(`/workers/${id}/disable`, { method: 'POST' })
}

export async function setDefaultWorker(id: string): Promise<WorkerItem> {
  return apiFetch<WorkerItem>(`/workers/${id}/set-default`, { method: 'POST' })
}

/** Display labels for worker status. */
export function workerStatusLabel(status: WorkerStatus): string {
  switch (status) {
    case 'healthy':
      return 'Healthy'
    case 'unhealthy':
      return 'Unhealthy'
    case 'disabled':
      return 'Disabled'
    case 'provisioning':
      return 'Provisioning'
    case 'provision_failed':
      return 'Provision Failed'
    default:
      return 'Not Checked'
  }
}

/** Badge class for a worker status (inline round-full spans, repo convention). */
export function workerStatusBadgeClass(status: WorkerStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-emerald-100 text-emerald-700'
    case 'unhealthy':
      return 'bg-red-100 text-red-700'
    case 'disabled':
      return 'bg-slate-200 text-slate-600'
    case 'provisioning':
      return 'bg-blue-100 text-blue-700'
    case 'provision_failed':
      return 'bg-rose-100 text-rose-700'
    default:
      return 'bg-amber-100 text-amber-700'
  }
}