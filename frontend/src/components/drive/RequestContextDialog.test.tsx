import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RequestContextDialog } from '@/components/drive/RequestContextDialog'

const MASKED = '••••••••'

const maskedDetails = {
  attached: true,
  referer: 'https://example.com/watch/123',
  origin: 'https://example.com',
  userAgent: 'Mozilla/5.0 test-agent',
  cookie: { attached: true, masked: `session=${MASKED}; cf_clearance=${MASKED}` },
}

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

  it('renders an empty state for imports with no context', async () => {
    apiFetchMock.mockResolvedValueOnce({
      attached: false,
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
