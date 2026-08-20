import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkersPage } from './WorkersPage'
import * as Workers from '@/lib/workers'
import { timeAgo } from '@/lib/utils'

const WORKER_A: Workers.WorkerItem = {
  id: 'w-a',
  name: '9drive-relay',
  slug: null,
  driver: 'cloudflare',
  endpointUrl: 'https://9drive-relay.example-subdomain.workers.dev',
  isEnabled: true,
  isDefault: true,
  priority: 10,
  region: null,
  description: null,
  authType: 'hmac',
  credentialConfigured: true,
  providerConfig: { accountId: 'acc-1', workerName: '9drive-relay' },
  capabilitiesJson: null,
  metadataJson: { protocolVersion: '9drive-relay-v1' },
  status: 'healthy',
  lastHealthCheckAt: '2026-08-20T08:00:00.000Z',
  lastHealthyAt: '2026-08-20T08:00:00.000Z',
  lastFailedAt: null,
  lastErrorCode: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** Managed Cloudflare driver: registration fields only (spec §9). */
const DRIVER: Workers.WorkerDriverMetadata = {
  key: 'cloudflare',
  displayName: 'Cloudflare Worker',
  managed: true,
  authTypes: ['hmac'],
  fields: [
    { key: 'accountId', label: 'Account ID', type: 'text', required: true, help: 'Your Cloudflare Account ID.' },
    { key: 'apiToken', label: 'API Token', type: 'password', secret: true, required: true, help: 'A token with permissions to deploy and manage Workers.' },
    { key: 'workerName', label: 'Worker Name', type: 'text', required: true, autoFillNameFrom: 'workerName', help: 'The name used for the deployed 9Drive relay Worker.' },
  ],
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(Workers, 'listWorkers').mockResolvedValue([WORKER_A])
  vi.spyOn(Workers, 'listWorkerDrivers').mockResolvedValue([DRIVER])
})

function openAddModal() {
  const button = screen.getAllByRole('button', { name: /add worker/i })[0]
  return userEvent.click(button)
}

function addModal() {
  return screen.getByRole('heading', { name: 'Add Worker' }).closest('div.relative') as HTMLElement
}

describe('WorkersPage', () => {
  it('shows the empty state and never implies a worker is required', async () => {
    vi.spyOn(Workers, 'listWorkers').mockResolvedValue([])
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getByText(/no workers registered yet/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /add worker/i })).toBeInTheDocument()
  })

  it('renders the worker row with status badge and Credential configured (never the secret)', async () => {
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getAllByText('9drive-relay').length).toBeGreaterThan(0))
    expect(screen.getByText('Healthy')).toBeInTheDocument()
    expect(screen.getByText('Credential configured')).toBeInTheDocument()
    // The discovered endpoint is system-generated and shown.
    expect(screen.getByText('https://9drive-relay.example-subdomain.workers.dev')).toBeInTheDocument()
    // No Region column, no secret values.
    expect(screen.queryByText('Region', { selector: 'th' })).not.toBeInTheDocument()
    expect(screen.queryByText(/secret/i)).not.toBeInTheDocument()
  })

  it('shows the relative Last Check via timeAgo', async () => {
    const checkTime = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    vi.spyOn(Workers, 'listWorkers').mockResolvedValue([{ ...WORKER_A, lastHealthCheckAt: checkTime }])
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getAllByText('9drive-relay').length).toBeGreaterThan(0))
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument()
    expect(timeAgo(checkTime)).toBe('5 minutes ago')
  })

  it('add modal asks only for Account ID / API Token / Worker Name — never endpoint/region/auth/description', async () => {
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /add worker/i })).toBeInTheDocument())
    await openAddModal()
    const modal = addModal()
    expect(within(modal).getByLabelText(/account id/i)).toBeInTheDocument()
    expect(within(modal).getByLabelText(/api token/i)).toBeInTheDocument()
    expect(within(modal).getByLabelText(/worker name/i)).toBeInTheDocument()
    // The removed fields never appear.
    expect(within(modal).queryByLabelText(/endpoint url/i)).not.toBeInTheDocument()
    expect(within(modal).queryByLabelText(/authentication/i)).not.toBeInTheDocument()
    expect(within(modal).queryByLabelText(/shared secret/i)).not.toBeInTheDocument()
    expect(within(modal).queryByLabelText(/description/i)).not.toBeInTheDocument()
    // No separate Name field — Worker Name doubles as the display name (§7).
    expect(within(modal).queryByLabelText(/^name/i)).not.toBeInTheDocument()
  })

  it('submits config-only payload {driver, config, isEnabled} — no endpointUrl', async () => {
    const create = vi.spyOn(Workers, 'createWorker').mockResolvedValue(WORKER_A)
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /add worker/i })).toBeInTheDocument())
    await openAddModal()
    const modal = addModal()
    await userEvent.type(within(modal).getByLabelText(/account id/i), 'acc-1')
    await userEvent.type(within(modal).getByLabelText(/api token/i), 'tok-1')
    await userEvent.type(within(modal).getByLabelText(/worker name/i), '9drive-relay')
    await userEvent.click(within(modal).getByRole('button', { name: /add worker/i }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({
      driver: 'cloudflare',
      config: { accountId: 'acc-1', apiToken: 'tok-1', workerName: '9drive-relay' },
      isEnabled: true,
      name: undefined,
    })
    // The managed path never sends endpointUrl/authType/secret.
    expect(create.mock.calls[0][0].endpointUrl).toBeUndefined()
    expect(create.mock.calls[0][0].secret).toBeUndefined()
  })

  it('edit modal keeps the API token blank (credential configured hint, never prefilled)', async () => {
    const update = vi.spyOn(Workers, 'updateWorker').mockResolvedValue(WORKER_A)
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getAllByText('9drive-relay').length).toBeGreaterThan(0))
    await userEvent.click(screen.getByTitle('Edit worker'))
    const modal = screen.getByRole('heading', { name: /edit worker/i }).closest('div.relative') as HTMLElement
    // The token field is blank (never returned by the API) with the keep-hint.
    expect((within(modal).getByLabelText(/api token/i) as HTMLInputElement).value).toBe('')
    expect(within(modal).getByText(/leave blank to keep/i)).toBeInTheDocument()
    await userEvent.click(within(modal).getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(update).toHaveBeenCalled())
    // Blank token omitted → config keeps the safe fields but no apiToken key.
    const config = update.mock.calls[0][1].config ?? {}
    expect(config.apiToken).toBeUndefined()
    expect(config.accountId).toBe('acc-1')
    expect(config.workerName).toBe('9drive-relay')
    // The token value is never present in the request.
    expect(JSON.stringify(update.mock.calls[0][1])).not.toContain('tok')
  })

  it('Test Connection posts and shows the result', async () => {
    const test = vi.spyOn(Workers, 'testWorker').mockResolvedValue({ status: 'healthy', lastHealthCheckAt: '2026-08-20T09:00:00.000Z' })
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getAllByText('9drive-relay').length).toBeGreaterThan(0))
    await userEvent.click(screen.getByTitle('Test connection'))
    await waitFor(() => expect(test).toHaveBeenCalledWith('w-a'))
    await waitFor(() => expect(screen.getByText(/connection healthy/i)).toBeInTheDocument())
  })

  it('a provisioning worker hides the test action and shows the Provisioning badge', async () => {
    vi.spyOn(Workers, 'listWorkers').mockResolvedValue([
      { ...WORKER_A, id: 'w-p', name: 'deploying-relay', status: 'provisioning', endpointUrl: null },
    ])
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getByText('Provisioning')).toBeInTheDocument())
    // The worker is not ready — no Test action, and Enable/Disable is inert.
    expect(screen.queryByTitle('Test connection')).not.toBeInTheDocument()
    expect(screen.getByTitle('Disable worker')).toBeDisabled()
  })

  it('a provision_failed worker shows the failure badge and no fake endpoint', async () => {
    vi.spyOn(Workers, 'listWorkers').mockResolvedValue([
      { ...WORKER_A, id: 'w-f', name: 'failed-relay', status: 'provision_failed', endpointUrl: null },
    ])
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getByText('Provision Failed')).toBeInTheDocument())
    expect(screen.queryByTitle('Test connection')).not.toBeInTheDocument()
    // No fake endpoint is invented — the cell shows a dash.
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('Disable posts, reloads, and the disabled default clears itself', async () => {
    const disable = vi.spyOn(Workers, 'disableWorker').mockResolvedValue({ ...WORKER_A, isEnabled: false, isDefault: false, status: 'disabled' })
    const list = vi.spyOn(Workers, 'listWorkers')
    list.mockResolvedValueOnce([WORKER_A]).mockResolvedValue([{ ...WORKER_A, isEnabled: false, isDefault: false, status: 'disabled' }])
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getAllByText('9drive-relay').length).toBeGreaterThan(0))
    await userEvent.click(screen.getByTitle('Disable worker'))
    await waitFor(() => expect(disable).toHaveBeenCalledWith('w-a'))
    await waitFor(() => expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0))
    expect(screen.queryByText('Default', { selector: 'span' })).not.toBeInTheDocument()
  })

  it('Set as Default posts for a non-default worker', async () => {
    const setDefault = vi.spyOn(Workers, 'setDefaultWorker').mockResolvedValue({ ...WORKER_A, isDefault: true })
    vi.spyOn(Workers, 'listWorkers').mockResolvedValue([{ ...WORKER_A, isDefault: false }])
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getAllByText('9drive-relay').length).toBeGreaterThan(0))
    await userEvent.click(screen.getByTitle('Set as default'))
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith('w-a'))
    await waitFor(() => expect(screen.getByText(/is now the default worker/i)).toBeInTheDocument())
  })

  it('multiple workers all render independently', async () => {
    const workers: Workers.WorkerItem[] = [
      WORKER_A,
      { ...WORKER_A, id: 'w-b', name: 'relay-b', isDefault: false, endpointUrl: 'https://relay-b.example.workers.dev' },
      { ...WORKER_A, id: 'w-c', name: 'relay-c', isDefault: false, status: 'unhealthy' },
    ]
    vi.spyOn(Workers, 'listWorkers').mockResolvedValue(workers)
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getAllByText('relay-b').length).toBeGreaterThan(0))
    expect(screen.getAllByText('relay-c').length).toBeGreaterThan(0)
    expect(screen.getByText('Unhealthy')).toBeInTheDocument()
  })
})