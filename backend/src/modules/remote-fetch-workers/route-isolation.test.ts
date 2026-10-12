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

describe('route isolation: worker jobs never fall back to Direct', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a worker-selected job stays on its exact provider across probe + download + retry', async () => {
    const hits: Array<{ url: string; traceId?: string }> = []
    const workerTransport = {
      request: async (input: { url: string; traceId?: string }) => {
        hits.push({ url: input.url, traceId: input.traceId })
        return { status: 200, statusText: '200', headers: {}, body: (async function* () {})(), finalUrl: input.url, redirectCount: 0 }
      },
    }
    const fetcher = new SecureRemoteFetcher(workerTransport as never, { route: 'worker', workerId: 'w-deno-1', driver: 'deno', relayHost: 'relay.deno.net' })
    expect(fetcher.routeInfo()).toMatchObject({ route: 'worker', workerId: 'w-deno-1', driver: 'deno' })

    await fetcher.fetch({ method: 'HEAD', url: 'https://source.example/file.mp4', traceId: 'job-1:probe-head' } as never)
    await fetcher.fetch({ method: 'GET', url: 'https://source.example/file.mp4', range: 'bytes=0-0', traceId: 'job-1:probe-range' } as never)
    await fetcher.fetch({ method: 'GET', url: 'https://source.example/file.mp4', traceId: 'job-1:download' } as never)
    await fetcher.fetch({ method: 'GET', url: 'https://source.example/file.mp4', traceId: 'job-1:download' } as never)

    expect(hits).toHaveLength(4)
    // Same fetcher/transport throughout — no Direct transport was ever built.
    expect(fetcher.routeInfo().driver).toBe('deno')
    expect(fetcher.routeInfo().workerId).toBe('w-deno-1')
  })

  it('worker 404 maps to DOWNLOAD_HTTP_ERROR on the worker route (never Direct)', async () => {
    const workerTransport = {
      request: async (input: { url: string }) => ({
        status: 404, statusText: '404', headers: {}, body: (async function* () {})(), finalUrl: input.url, redirectCount: 0,
      }),
    }
    const fetcher = new SecureRemoteFetcher(workerTransport as never, { route: 'worker', workerId: 'w-cf-1', driver: 'cloudflare', relayHost: 'relay.workers.dev' })
    const probe = await fetcher.fetch({ method: 'GET', url: 'https://source.example/missing.mp4', traceId: 'job-404:probe-range' } as never)
    expect(probe.status).toBe(404)
    await expect(fetcher.downloadToFile('https://source.example/missing.mp4', '/tmp/never', { traceId: 'job-404:download' } as never)).rejects.toMatchObject({
      code: 'DOWNLOAD_HTTP_ERROR',
    })
    expect(fetcher.routeInfo().route).toBe('worker')
  })

  it('ordinary Direct jobs remain unchanged (route=direct, no worker)', async () => {
    const { buildDirectTransport } = await import('./transport.js')
    void buildDirectTransport
    const directTransport = {
      request: async (input: { url: string }) => ({
        status: 200, statusText: '200', headers: {}, body: (async function* () { yield new Uint8Array([1]) })(), finalUrl: input.url, redirectCount: 0,
      }),
    }
    const fetcher = new SecureRemoteFetcher(directTransport as never, { route: 'direct' })
    const res = await fetcher.fetch({ method: 'GET', url: 'https://source.example/file.mp4', traceId: 'direct-1:download' } as never)
    expect(res.status).toBe(200)
    expect(fetcher.routeInfo().route).toBe('direct')
  })
})
