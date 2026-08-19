import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuotaTrackerPage } from './QuotaTrackerPage'
import * as Api from '@/lib/api'

/**
 * Behaviour tests for the Quota Tracker Auto Allocation toggle.
 *
 * The page fetches three endpoints on mount (storage/summary, connected-accounts,
 * storage/routing-policy). `apiFetch` is mocked per path; the toggle asserts the
 * PATCH call, optimistic flip, revert on failure, and per-account disable while
 * the request is in flight.
 */

const summary = { totalBytes: '1000', usedBytes: '400', availableBytes: '600' }
const routingPolicy = { policy: { id: 'p1', mode: 'most_available' as const, priorityAccountIds: [], roundRobinCursor: 0 } }

const account = (id: string, autoAllocationEnabled: boolean, status = 'connected') => ({
  id,
  email: `${id}@example.com`,
  displayName: null,
  provider: 'google_drive',
  status,
  autoAllocationEnabled,
  storageAccount: { totalBytes: '500', usedBytes: '100', availableBytes: '400', lastSyncedAt: '2026-08-07T00:00:00.000Z' },
})

let pendingPatch: (() => void) | null = null

function mockApi(accounts: Array<ReturnType<typeof account>>) {
  vi.spyOn(Api, 'apiFetch').mockImplementation(async (path: string, options?: RequestInit) => {
    const url = String(path)
    if (url === '/storage/summary') return summary
    if (url === '/storage/routing-policy' && (!options || !options.method)) return routingPolicy
    if (url === '/connected-accounts' && (!options || !options.method)) return { accounts }
    if (url.startsWith('/connected-accounts/') && options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body)) as { autoAllocationEnabled: boolean }
      const target = accounts.find((a) => url === `/connected-accounts/${a.id}`)
      if (!target) throw new Error('account not found')
      // Keep the mock pending until the test releases it, to exercise the
      // loading/disabled state deterministically.
      await new Promise<void>((resolve) => { pendingPatch = resolve })
      target.autoAllocationEnabled = body.autoAllocationEnabled
      return { account: { ...target, autoAllocationEnabled: target.autoAllocationEnabled } }
    }
    if (url === '/storage/routing-policy' && options?.method === 'PATCH') return routingPolicy
    throw new Error(`unexpected apiFetch path: ${url}`)
  })
}

afterEach(() => {
  pendingPatch = null
  vi.restoreAllMocks()
})

async function renderPage() {
  const utils = render(<QuotaTrackerPage />)
  // The account email appears in both the routing list and its quota card.
  await screen.findAllByText('acc-a@example.com')
  return utils
}

/** The account quota card (the second occurrence of the email in the DOM). */
function cardFor(email: string): HTMLElement {
  const emailNodes = screen.getAllByText(email)
  return emailNodes[1].closest('[class*="rounded-2xl"]') as HTMLElement
}

describe('QuotaTrackerPage — REAUTH_REQUIRED account state', () => {
  beforeEach(() => {
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  it('renders the Reconnection Required pill, friendly text, and last-known quota for a reauth account (Allocation ON)', async () => {
    mockApi([account('acc-a', true, 'reauth_required')])
    await renderPage()
    const card = cardFor('acc-a@example.com')
    expect(within(card).getByText('Reconnection Required')).toBeTruthy()
    expect(within(card).getByText(/Google authorization is no longer valid/)).toBeTruthy()
    // Auto Allocation stays ON — preference visible, effective usage suspended.
    expect(within(card).getByText('Unavailable until reconnected.')).toBeTruthy()
    expect(within(card).getByRole('switch', { name: /disable automatic allocation for acc-a/i })).toHaveAttribute('aria-checked', 'true')
    // Last-known quota numbers still shown.
    expect(within(card).getByText(/100 B \/ 500 B/)).toBeTruthy()
  })

  it('reconnect button calls POST /connected-accounts/:id/reconnect and opens the popup URL', async () => {
    mockApi([account('acc-a', true, 'reauth_required')])
    await renderPage()
    // Extend the mock: the reconnect POST returns the OAuth URL; the popup
    // stub records where the popup is redirected.
    const popupRedirects: string[] = []
    ;(window.open as ReturnType<typeof vi.fn>).mockImplementation(() => ({ location: { set href(v: string) { popupRedirects.push(v) } }, document: { write: () => undefined } }) as unknown as Window)
    const apiFetchMock = Api.apiFetch as unknown as ReturnType<typeof vi.fn>
    const original = apiFetchMock.getMockImplementation() as (path: string, options?: RequestInit) => Promise<unknown>
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (String(path) === '/connected-accounts/acc-a/reconnect' && options?.method === 'POST') return { url: 'https://accounts.google.com/o/oauth2/auth?state=xyz' }
      return original(path, options)
    })
    const card = cardFor('acc-a@example.com')
    await userEvent.click(within(card).getByRole('button', { name: /reconnect google drive/i }))
    await waitFor(() => {
      expect(Api.apiFetch).toHaveBeenCalledWith('/connected-accounts/acc-a/reconnect', expect.objectContaining({ method: 'POST' }))
      expect(popupRedirects[0]).toContain('accounts.google.com')
    })
  })
})

describe('QuotaTrackerPage — Auto Allocation toggle', () => {
  beforeEach(() => {
    // window.open is not exercised in these tests; noop to avoid jsdom noise.
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  it('renders an ON state with helper text for an allocation-enabled account', async () => {
    mockApi([account('acc-a', true)])
    await renderPage()
    const card = cardFor('acc-a@example.com')
    expect(within(card).getByText('Eligible for Automatic storage allocation.')).toBeTruthy()
    expect(within(card).getByRole('switch', { name: /disable automatic allocation for acc-a/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the Allocation Disabled badge and helper for an OFF account', async () => {
    mockApi([account('acc-a', false)])
    await renderPage()
    expect(screen.getByText('Allocation Disabled')).toBeTruthy()
    expect(screen.getByText('Excluded from Automatic storage allocation. Existing files and Sync are not affected.')).toBeTruthy()
    expect(screen.getByRole('switch', { name: /enable automatic allocation for acc-a/i })).toHaveAttribute('aria-checked', 'false')
  })

  it('flips optimistically and sends PATCH with the inverted value, then reconciles', async () => {
    mockApi([account('acc-a', true)])
    await renderPage()
    const toggle = screen.getByRole('switch', { name: /disable automatic allocation for acc-a/i })
    await userEvent.click(toggle)
    // Optimistic: immediately OFF with the disabled helper text.
    expect(await screen.findByText('Excluded from Automatic storage allocation. Existing files and Sync are not affected.')).toBeTruthy()
    // Server confirms.
    pendingPatch!()
    await waitFor(() => {
      expect(Api.apiFetch).toHaveBeenCalledWith('/connected-accounts/acc-a', expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('"autoAllocationEnabled":false') }))
    })
    await screen.findByText('Auto Allocation disabled for this account.')
  })

  it('reverts the optimistic flip and surfaces an error when the PATCH fails', async () => {
    mockApi([account('acc-a', true)])
    await renderPage()
    // Now break only the PATCH; the page stays rendered with the loaded data.
    vi.restoreAllMocks()
    vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.spyOn(Api, 'apiFetch').mockImplementation(async (path: string, options?: RequestInit) => {
      const url = String(path)
      if (url.startsWith('/connected-accounts/') && options?.method === 'PATCH') throw new Error('Network failure')
      throw new Error(`unexpected apiFetch path: ${url}`)
    })
    const toggle = screen.getByRole('switch', { name: /disable automatic allocation for acc-a/i })
    await userEvent.click(toggle)
    // The PATCH rejects → the optimistic flip is reverted and the error shown.
    await screen.findByText('Network failure')
    expect(screen.getByRole('switch', { name: /disable automatic allocation for acc-a/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('disables the switch while an update is in flight', async () => {
    mockApi([account('acc-a', true)])
    await renderPage()
    const toggle = screen.getByRole('switch', { name: /disable automatic allocation for acc-a/i })
    await userEvent.click(toggle)
    // In-flight: disabled.
    expect(toggle).toBeDisabled()
    pendingPatch!()
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /enable automatic allocation for acc-a/i })).not.toBeDisabled()
    })
  })
})
