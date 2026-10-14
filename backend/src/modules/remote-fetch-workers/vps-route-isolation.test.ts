import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SecureRemoteFetcher } from '../remote-imports/secure-fetcher.js'

vi.mock('./worker-usage.service.js', () => ({
  getWorkerBudgetStatus: vi.fn(async () => ({ maxEgressBytes: null, egressBytes: 0n })),
  recordWorkerRequest: vi.fn(async () => undefined),
  assertWorkerBudgetAvailable: vi.fn(async () => ({})),
  assertWorkerCapabilities: vi.fn(() => undefined),
  currentPeriodMonth: () => '2026-10',
  resolveSafetyBudgets: () => ({ maxRequests: null, maxEgressBytes: null }),
}))

vi.mock('../remote-imports/ssrf.js', async (original) => ({
  ...(await original<typeof import('../remote-imports/ssrf.js')>()),
  validateRemoteUrl: async (value: string) => new URL(value),
}))

describe('vps route isolation: no Direct or cross-provider fallback', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a VPS-selected job stays on its exact worker across probe + download + retry', async () => {
    const hits: Array<{ url: string; traceId?: string }> = []
    const workerTransport = {
      request: async (input: { url: string; traceId?: string }) => {
        hits.push({ url: input.url, traceId: input.traceId })
        return { status: 200, statusText: '200', headers: {}, body: (async function* () {})(), finalUrl: input.url, redirectCount: 0 }
      },
    }
    const fetcher = new SecureRemoteFetcher(workerTransport as never, { route: 'worker', workerId: 'w-vps-1', driver: 'vps', relayHost: 'relay.example.com' })
    expect(fetcher.routeInfo()).toMatchObject({ route: 'worker', workerId: 'w-vps-1', driver: 'vps' })

    await fetcher.fetch({ method: 'HEAD', url: 'https://source.example/file.mp4', traceId: 'job-1:probe-head' } as never)
    await fetcher.fetch({ method: 'GET', url: 'https://source.example/file.mp4', range: 'bytes=0-0', traceId: 'job-1:probe-range' } as never)
    await fetcher.fetch({ method: 'GET', url: 'https://source.example/file.mp4', traceId: 'job-1:download' } as never)

    expect(hits).toHaveLength(3)
    expect(fetcher.routeInfo().driver).toBe('vps')
    expect(fetcher.routeInfo().workerId).toBe('w-vps-1')
    expect(fetcher.routeInfo().route).toBe('worker')
  })

  it('VPS upstream 404 stays a VPS-route failure (never Direct)', async () => {
    const workerTransport = {
      request: async (input: { url: string }) => ({
        status: 404, statusText: '404', headers: {}, body: (async function* () {})(), finalUrl: input.url, redirectCount: 0,
      }),
    }
    const fetcher = new SecureRemoteFetcher(workerTransport as never, { route: 'worker', workerId: 'w-vps-1', driver: 'vps', relayHost: 'relay.example.com' })
    const probe = await fetcher.fetch({ method: 'GET', url: 'https://source.example/missing.mp4', traceId: 'job-404:probe-range' } as never)
    expect(probe.status).toBe(404)
    await expect(fetcher.downloadToFile('https://source.example/missing.mp4', '/tmp/never', { traceId: 'job-404:download' } as never)).rejects.toMatchObject({
      code: 'DOWNLOAD_HTTP_ERROR',
    })
    expect(fetcher.routeInfo().route).toBe('worker')
    expect(fetcher.routeInfo().driver).toBe('vps')
  })
})
