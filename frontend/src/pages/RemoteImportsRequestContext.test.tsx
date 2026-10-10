import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const MASKED = '••••••••'

const withCtx = {
  id: 'with-ctx',
  fileName: 'protected.mkv',
  displayUrl: 'https://example.com/download',
  status: 'completed',
  stage: 'finished',
  totalBytes: '1000',
  downloadedBytes: '1000',
  uploadedBytes: '1000',
  uploadTotalBytes: null,
  uploadProgress: 100,
  queuedAt: null,
  retryRequestedAt: null,
  heartbeatAt: null,
  retryFromStage: null,
  mimeType: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  completedAt: '2026-01-01T00:00:00.000Z',
  failedAt: null,
  cancelledAt: null,
  attempt: 1,
  fileId: null,
  folderId: null,
  connectedAccountId: null,
  workerId: null,
  workerNameSnapshot: null,
  requestContext: { attached: true, referer: true, origin: true, userAgent: true, cookie: true },
}

const plain = { ...withCtx, id: 'plain', fileName: 'plain.bin', requestContext: undefined }
const failedCtx = {
  ...withCtx,
  id: 'failed-ctx',
  fileName: 'expired.mkv',
  status: 'failed',
  stage: 'finished',
  errorMessage: 'The download link expired.',
}

const apiFetchMock = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

let currentDownloadUrl = 'https://cdn.example.com/file.mkv?token=signed-value'

function installMocks() {
  currentDownloadUrl = 'https://cdn.example.com/file.mkv?token=signed-value'
  apiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
    if (typeof path === 'string' && path.endsWith('/download-url') && options?.method === 'PATCH') {
      currentDownloadUrl = JSON.parse(options.body ?? '{}').url
      return { ...failedCtx, status: 'queued', stage: 'waiting', attempt: 2 }
    }
    if (typeof path === 'string' && path.includes('/request-context')) {
      return {
        attached: true,
        downloadUrl: currentDownloadUrl,
        referer: 'https://example.com/watch/123',
        origin: 'https://example.com',
        userAgent: 'Mozilla/5.0 test-agent',
        cookie: { attached: true, masked: `session=${MASKED}` },
      }
    }
    if (typeof path === 'string' && path.startsWith('/remote-imports')) {
      return { items: [withCtx, plain, failedCtx], cursor: null }
    }
    if (typeof path === 'string' && path.startsWith('/connected-accounts')) return { accounts: [] }
    if (typeof path === 'string' && path.startsWith('/folders')) return { folders: [] }
    if (typeof path === 'string' && path.startsWith('/workers')) return { items: [], workers: [] }
    return {}
  })
}

describe('RemoteImportsPage request-context action', () => {
  it('badge is an interactive button that lazily fetches and shows details', async () => {
    installMocks()
    const { RemoteImportsPage } = await import('@/pages/RemoteImportsPage')
    render(<RemoteImportsPage />)

    const viewButtons = await screen.findAllByRole('button', { name: /View request context for protected\.mkv/ })
    expect(viewButtons).toHaveLength(1)
    // Lazy: no details fetch before the click.
    expect(apiFetchMock.mock.calls.some(([p]) => typeof p === 'string' && p.includes('/request-context'))).toBe(false)

    fireEvent.click(viewButtons[0])
    expect(await screen.findByText('https://cdn.example.com/file.mkv?token=signed-value')).toBeInTheDocument()
    expect(screen.getByText('https://example.com/watch/123')).toBeInTheDocument()
    expect(screen.getByText(`session=${MASKED}`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Download URL' })).toBeInTheDocument()
    // Completed imports are not editable — no Edit affordance.
    expect(screen.queryByRole('button', { name: 'Edit Download URL' })).not.toBeInTheDocument()
    expect(apiFetchMock).toHaveBeenCalledWith('/remote-imports/with-ctx/request-context')
  })

  it('failed imports expose Edit and saving requeues with the new URL', async () => {
    installMocks()
    const { RemoteImportsPage } = await import('@/pages/RemoteImportsPage')
    render(<RemoteImportsPage />)

    const viewButtons = await screen.findAllByRole('button', { name: /View request context for expired\.mkv/ })
    fireEvent.click(viewButtons[0])
    await screen.findByText('https://cdn.example.com/file.mkv?token=signed-value')

    fireEvent.click(screen.getByRole('button', { name: 'Edit Download URL' }))
    const input = screen.getByLabelText('New Download URL')
    expect(input).toHaveValue('https://cdn.example.com/file.mkv?token=signed-value')
    fireEvent.change(input, { target: { value: 'https://cdn.example.com/file.mkv?token=fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & restart' }))

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/remote-imports/failed-ctx/download-url', {
        method: 'PATCH',
        body: JSON.stringify({ url: 'https://cdn.example.com/file.mkv?token=fresh' }),
      })
    })
    // Dialog re-fetches and shows the saved URL after the PATCH.
    expect(await screen.findByText('https://cdn.example.com/file.mkv?token=fresh')).toBeInTheDocument()
  })

  it('shows a save error without closing when the PATCH fails', async () => {
    installMocks()
    apiFetchMock.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.endsWith('/download-url')) {
        throw new Error('The URL is blocked.')
      }
      if (typeof path === 'string' && path.includes('/request-context')) {
        return {
          attached: true,
          downloadUrl: currentDownloadUrl,
          referer: null,
          origin: null,
          userAgent: null,
          cookie: { attached: false, masked: null },
        }
      }
      if (typeof path === 'string' && path.startsWith('/remote-imports')) {
        return { items: [failedCtx], cursor: null }
      }
      return {}
    })
    const { RemoteImportsPage } = await import('@/pages/RemoteImportsPage')
    render(<RemoteImportsPage />)

    const viewButtons = await screen.findAllByRole('button', { name: /View request context for expired\.mkv/ })
    fireEvent.click(viewButtons[0])
    await screen.findByText('https://cdn.example.com/file.mkv?token=signed-value')

    fireEvent.click(screen.getByRole('button', { name: 'Edit Download URL' }))
    fireEvent.change(screen.getByLabelText('New Download URL'), { target: { value: 'https://blocked.example/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & restart' }))

    expect(await screen.findByText('The URL is blocked.')).toBeInTheDocument()
    // Still editing — the dialog did not close or clear the draft.
    expect(screen.getByLabelText('New Download URL')).toBeInTheDocument()
  })

  it('rows without attached context expose no details action', async () => {
    installMocks()
    const { RemoteImportsPage } = await import('@/pages/RemoteImportsPage')
    render(<RemoteImportsPage />)

    await screen.findByText('plain.bin')
    expect(screen.queryByRole('button', { name: /View request context for plain\.bin/ })).not.toBeInTheDocument()
    // One View action per context-attached row (withCtx + failedCtx), none for plain.
    await waitFor(() => {
      expect(screen.getAllByText('View')).toHaveLength(2)
    })
  })
})
