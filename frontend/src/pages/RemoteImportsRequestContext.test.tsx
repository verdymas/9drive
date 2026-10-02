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

function installMocks() {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (typeof path === 'string' && path.includes('/request-context')) {
      return {
        attached: true,
        referer: 'https://example.com/watch/123',
        origin: 'https://example.com',
        userAgent: 'Mozilla/5.0 test-agent',
        cookie: { attached: true, masked: `session=${MASKED}` },
      }
    }
    if (typeof path === 'string' && path.startsWith('/remote-imports')) {
      return { items: [withCtx, plain], cursor: null }
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
    expect(await screen.findByText('https://example.com/watch/123')).toBeInTheDocument()
    expect(screen.getByText(`session=${MASKED}`)).toBeInTheDocument()
    expect(apiFetchMock).toHaveBeenCalledWith('/remote-imports/with-ctx/request-context')
  })

  it('rows without attached context expose no details action', async () => {
    installMocks()
    const { RemoteImportsPage } = await import('@/pages/RemoteImportsPage')
    render(<RemoteImportsPage />)

    await screen.findByText('plain.bin')
    expect(screen.queryByRole('button', { name: /View request context for plain\.bin/ })).not.toBeInTheDocument()
    // Exactly one View action across both rows.
    await waitFor(() => {
      expect(screen.getAllByText('View')).toHaveLength(1)
    })
  })
})
