import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RequestContextDialog } from '@/components/drive/RequestContextDialog'

const MASKED = '••••••••'

const maskedDetails = {
  attached: true,
  downloadUrl: 'https://cdn.example.com/file.mkv?token=signed-value',
  referer: 'https://example.com/watch/123',
  origin: 'https://example.com',
  userAgent: 'Mozilla/5.0 test-agent',
  cookie: { attached: true, masked: `session=${MASKED}; cf_clearance=${MASKED}` },
}

const workersFixture = [
  {
    id: 'worker-A',
    name: 'Cloudflare SG #1',
    slug: null,
    driver: 'cloudflare',
    endpointUrl: 'https://relay.example',
    isEnabled: true,
    isDefault: false,
    priority: null,
    region: 'SG',
    description: null,
    authType: 'hmac',
    credentialConfigured: true,
    providerConfig: null,
    capabilitiesJson: null,
    metadataJson: null,
    status: 'healthy',
    lastHealthCheckAt: null,
    lastHealthyAt: null,
    lastFailedAt: null,
    lastErrorCode: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

const apiFetchMock = vi.fn()

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  formatBytes: (v: unknown) => String(v ?? '--'),
  formatDate: () => 'Jan 1, 2026',
  API_URL: 'http://localhost:4000',
}))

// The dialog imports the helper from remoteImports, which itself imports the
// mocked apiFetch above — no further mocking needed.

afterEach(() => {
  vi.clearAllMocks()
})

function mockDetailsSequence() {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (typeof path === 'string' && path.includes('/request-context?revealCookie=1')) {
      return { ...maskedDetails, cookie: { ...maskedDetails.cookie, raw: 'session=abc123; cf_clearance=xyz789' } }
    }
    if (typeof path === 'string' && path.includes('/request-context')) {
      return maskedDetails
    }
    throw new Error(`unexpected fetch: ${path}`)
  })
}

describe('RequestContextDialog', () => {
  it('fetches details lazily on open and shows Referer, Origin, User-Agent and masked Cookie', async () => {
    mockDetailsSequence()
    render(<RequestContextDialog importId="import-1" fileName="protected.mkv" onClose={() => {}} />)

    expect(apiFetchMock).toHaveBeenCalledWith('/remote-imports/import-1/request-context')
    expect(await screen.findByText('https://example.com/watch/123')).toBeInTheDocument()
    expect(screen.getByText('https://example.com')).toBeInTheDocument()
    expect(screen.getByText('Mozilla/5.0 test-agent')).toBeInTheDocument()
    expect(screen.getByText(`session=${MASKED}; cf_clearance=${MASKED}`)).toBeInTheDocument()
    // Raw value is never shown before Reveal.
    expect(screen.queryByText(/abc123/)).not.toBeInTheDocument()
  })

  it('does not fetch while closed', () => {
    mockDetailsSequence()
    render(<RequestContextDialog importId={null} onClose={() => {}} />)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('edits the Download URL of a failed import and requeues it', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (typeof path === 'string' && path.endsWith('/download-url') && options?.method === 'PATCH') {
        return { id: 'import-1', status: 'queued' }
      }
      if (typeof path === 'string' && path.includes('/request-context')) {
        return maskedDetails
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    const onSaved = vi.fn()
    render(<RequestContextDialog importId="import-1" editable onSaved={onSaved} onClose={() => {}} />)
    expect(await screen.findByText('https://cdn.example.com/file.mkv?token=signed-value')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Download URL' }))
    fireEvent.change(screen.getByLabelText('New Download URL'), { target: { value: 'https://cdn.example.com/file.mkv?token=fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & restart' }))

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/remote-imports/import-1/download-url', {
        method: 'PATCH',
        body: JSON.stringify({ url: 'https://cdn.example.com/file.mkv?token=fresh' }),
      })
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('edits a single header with merge semantics (other fields untouched)', async () => {
    const seen: unknown[] = []
    apiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (typeof path === 'string' && path.endsWith('/download-url') && options?.method === 'PATCH') {
        seen.push(JSON.parse(options.body ?? '{}'))
        return { id: 'import-1', status: 'queued' }
      }
      if (typeof path === 'string' && path.includes('/request-context')) {
        return maskedDetails
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RequestContextDialog importId="import-1" editable onClose={() => {}} />)
    expect(await screen.findByText('https://example.com/watch/123')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Referer' }))
    // Prefilled with the current value — never empty for an attached field.
    expect(screen.getByLabelText('New Referer')).toHaveValue('https://example.com/watch/123')
    fireEvent.change(screen.getByLabelText('New Referer'), { target: { value: 'https://example.com/watch/456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & restart' }))

    await waitFor(() => {
      expect(seen).toEqual([{ requestContext: { referer: 'https://example.com/watch/456' } }])
    })
  })

  it('adds a missing header via the Add affordance', async () => {
    const seen: unknown[] = []
    apiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (typeof path === 'string' && path.endsWith('/download-url') && options?.method === 'PATCH') {
        seen.push(JSON.parse(options.body ?? '{}'))
        return { id: 'import-1', status: 'queued' }
      }
      if (typeof path === 'string' && path.includes('/request-context')) {
        return { ...maskedDetails, origin: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RequestContextDialog importId="import-1" editable onClose={() => {}} />)
    await screen.findByText('Origin — Not attached')

    fireEvent.click(screen.getByRole('button', { name: 'Add Origin' }))
    fireEvent.change(screen.getByLabelText('New Origin'), { target: { value: 'https://watch.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & restart' }))

    await waitFor(() => {
      expect(seen).toEqual([{ requestContext: { origin: 'https://watch.example' } }])
    })
  })

  it('saving an empty header clears it (Remove & restart)', async () => {
    const seen: unknown[] = []
    apiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (typeof path === 'string' && path.endsWith('/download-url') && options?.method === 'PATCH') {
        seen.push(JSON.parse(options.body ?? '{}'))
        return { id: 'import-1', status: 'queued' }
      }
      if (typeof path === 'string' && path.includes('/request-context')) {
        return maskedDetails
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RequestContextDialog importId="import-1" editable onClose={() => {}} />)
    expect(await screen.findByText('https://example.com/watch/123')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Referer' }))
    fireEvent.change(screen.getByLabelText('New Referer'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove & restart' }))

    await waitFor(() => {
      expect(seen).toEqual([{ requestContext: { referer: null } }])
    })
  })

  it('shows the resolved Network Route and switches it via select', async () => {
    const seen: unknown[] = []
    apiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (typeof path === 'string' && path.endsWith('/download-url') && options?.method === 'PATCH') {
        seen.push(JSON.parse(options.body ?? '{}'))
        return { id: 'import-1', status: 'queued' }
      }
      if (typeof path === 'string' && path.includes('/request-context')) {
        return maskedDetails
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(
      <RequestContextDialog
        importId="import-1"
        editable
        currentWorkerId="worker-A"
        workers={workersFixture as never}
        onClose={() => {}}
      />,
    )
    expect(await screen.findByText('Cloudflare SG #1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Network Route' }))
    const select = screen.getByLabelText('New Network Route') as HTMLSelectElement
    expect(select.value).toBe('worker-A')
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & restart' }))

    await waitFor(() => {
      expect(seen).toEqual([{ workerId: null }])
    })
  })

  it('falls back to a snapshot label when the worker is gone from the list', async () => {
    mockDetailsSequence()
    render(<RequestContextDialog importId="import-1" editable currentWorkerId="worker-gone" workers={[]} onClose={() => {}} />)
    expect(await screen.findByText('Previous worker (unavailable)')).toBeInTheDocument()
  })

  it('keeps Save disabled until the Network Route actually changes', async () => {
    mockDetailsSequence()
    render(
      <RequestContextDialog
        importId="import-1"
        editable
        currentWorkerId="worker-A"
        workers={workersFixture as never}
        onClose={() => {}}
      />,
    )
    expect(await screen.findByText('Cloudflare SG #1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Network Route' }))
    expect(screen.getByRole('button', { name: 'Save & restart' })).toBeDisabled()
  })

  it('hides the Network Route Edit affordance when the import is not editable', async () => {
    mockDetailsSequence()
    render(<RequestContextDialog importId="import-1" currentWorkerId={null} workers={[]} onClose={() => {}} />)
    expect(await screen.findByText('Direct / No Worker')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Network Route' })).not.toBeInTheDocument()
  })

  it('edits the cookie without ever prefilling the secret', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/request-context')) {
        return maskedDetails
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RequestContextDialog importId="import-1" editable onClose={() => {}} />)
    expect(await screen.findByText(`session=${MASKED}; cf_clearance=${MASKED}`)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Cookie' }))
    const input = screen.getByLabelText('New Cookie') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.type).toBe('password')
  })

  it('hides the Edit affordance when the import is not editable', async () => {
    mockDetailsSequence()
    render(<RequestContextDialog importId="import-1" onClose={() => {}} />)
    expect(await screen.findByText('https://cdn.example.com/file.mkv?token=signed-value')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Download URL' })).not.toBeInTheDocument()
  })

  it('renders an empty state for imports with no context', async () => {
    apiFetchMock.mockResolvedValueOnce({
      attached: false,
      downloadUrl: null,
      referer: null,
      origin: null,
      userAgent: null,
      cookie: { attached: false, masked: null },
    })
    render(<RequestContextDialog importId="plain" onClose={() => {}} />)
    expect(await screen.findByText(/No request context attached/)).toBeInTheDocument()
  })

  it('reveals the raw cookie only after explicit click', async () => {
    mockDetailsSequence()
    render(<RequestContextDialog importId="import-1" onClose={() => {}} />)
    expect(await screen.findByText(`session=${MASKED}; cf_clearance=${MASKED}`)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Reveal/ }))
    expect(await screen.findByText('session=abc123; cf_clearance=xyz789')).toBeInTheDocument()
    expect(apiFetchMock).toHaveBeenCalledWith('/remote-imports/import-1/request-context?revealCookie=1')
  })

  it('hiding the cookie clears the revealed value from the DOM', async () => {
    mockDetailsSequence()
    render(<RequestContextDialog importId="import-1" onClose={() => {}} />)
    expect(await screen.findByText(`session=${MASKED}; cf_clearance=${MASKED}`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Reveal/ }))
    expect(await screen.findByText('session=abc123; cf_clearance=xyz789')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    await waitFor(() => {
      expect(screen.queryByText('session=abc123; cf_clearance=xyz789')).not.toBeInTheDocument()
    })
    expect(screen.getByText(`session=${MASKED}; cf_clearance=${MASKED}`)).toBeInTheDocument()
  })

  it('keeps long values inside the dialog layout', async () => {
    const longReferer = `https://example.com/watch/${'a'.repeat(400)}`
    apiFetchMock.mockResolvedValueOnce({
      ...maskedDetails,
      referer: longReferer,
      userAgent: 'Mozilla/5.0 ' + 'x'.repeat(500),
    })
    const { container } = render(<RequestContextDialog importId="import-1" onClose={() => {}} />)
    expect(await screen.findByText(longReferer)).toBeInTheDocument()
    // Overflow containment contract: long values wrap instead of widening.
    const wrapped = container.querySelector('.\\[overflow-wrap\\:anywhere\\]')
    expect(wrapped).toBeTruthy()
  })

  it('closing the dialog clears sensitive detail state', async () => {
    mockDetailsSequence()
    const onClose = vi.fn()
    const { rerender } = render(<RequestContextDialog importId="import-1" onClose={onClose} />)
    expect(await screen.findByText('https://example.com/watch/123')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Reveal/ }))
    expect(await screen.findByText('session=abc123; cf_clearance=xyz789')).toBeInTheDocument()

    // Close → state cleared; reopening refetches masked-only (no raw).
    fireEvent.click(screen.getAllByRole('button', { name: /Close modal/ })[0])
    expect(onClose).toHaveBeenCalled()
    rerender(<RequestContextDialog importId={null} onClose={onClose} />)
    expect(screen.queryByText('session=abc123; cf_clearance=xyz789')).not.toBeInTheDocument()

    apiFetchMock.mockClear()
    mockDetailsSequence()
    rerender(<RequestContextDialog importId="import-1" onClose={onClose} />)
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/remote-imports/import-1/request-context')
    })
    expect(screen.queryByText('session=abc123; cf_clearance=xyz789')).not.toBeInTheDocument()
  })
})
