import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    remoteFetchWorker: { findFirst: vi.fn() },
    remoteImport: { updateMany: vi.fn(async () => ({ count: 1 })) },
  },
}))

vi.mock('../../utils/crypto.js', () => ({
  decryptText: vi.fn((v: string) => {
    if (v === 'enc-secret') return 'relay-secret'
    return v
  }),
  encryptText: vi.fn((v: string) => v),
}))

vi.mock('../../config/env.js', () => ({
  env: {
    VPS_BROWSER_WARMUP_ENABLED: true,
    VPS_BROWSER_WARMUP_TIMEOUT_MS: 25000,
    VPS_BROWSER_WARMUP_REPLAY_WINDOW_SECONDS: 300,
  },
}))

import { prisma } from '../../config/prisma.js'
import { maybeWarmupBeforeProbe, __clearWarmupInflightForTests } from './vps-warmup.service.js'

const workerRow = (over: Record<string, unknown> = {}) => ({
  id: 'worker-1',
  driver: 'vps',
  endpointUrl: 'https://relay.example.com',
  secretEncrypted: 'enc-secret',
  capabilitiesJson: { browserWarmup: { supported: true, configured: true } },
  ...over,
})

describe('maybeWarmupBeforeProbe (once-before-probe, VPS-only, no fallback)', () => {
  beforeEach(() => {
    __clearWarmupInflightForTests()
    vi.resetAllMocks()
    vi.unstubAllGlobals()
    vi.mocked(prisma.remoteFetchWorker.findFirst).mockResolvedValue(workerRow() as never)
  })

  it('skips when mode off', async () => {
    const out = await maybeWarmupBeforeProbe({ workerId: 'worker-1', sourcePageUrl: 'https://watch.example/p', warmupMode: 'off' })
    expect(out).toMatchObject({ warmed: false, skipped: true })
  })

  it('skips Direct routes (auto) and throws in required mode', async () => {
    const skipped = await maybeWarmupBeforeProbe({ workerId: null, sourcePageUrl: 'https://watch.example/p', warmupMode: 'auto' })
    expect(skipped.skipped).toBe(true)
    await expect(maybeWarmupBeforeProbe({ workerId: null, sourcePageUrl: 'https://watch.example/p', warmupMode: 'required' })).rejects.toMatchObject({
      code: 'WARMUP_REQUIRED_MISSING',
    })
  })

  it('skips missing page URL in auto, throws in required', async () => {
    const skipped = await maybeWarmupBeforeProbe({ workerId: 'worker-1', sourcePageUrl: null, warmupMode: 'auto' })
    expect(skipped.skipReason).toBe('missing-page-url')
    await expect(maybeWarmupBeforeProbe({ workerId: 'worker-1', sourcePageUrl: null, warmupMode: 'required' })).rejects.toMatchObject({
      code: 'WARMUP_REQUIRED_MISSING',
    })
  })

  it('skips non-VPS drivers in auto, throws in required', async () => {
    vi.mocked(prisma.remoteFetchWorker.findFirst).mockResolvedValueOnce({ ...workerRow(), driver: 'cloudflare' } as never)
    const skipped = await maybeWarmupBeforeProbe({ workerId: 'w', sourcePageUrl: 'https://watch.example/p', warmupMode: 'auto' })
    expect(skipped.skipReason).toBe('non-vps-driver')
    vi.mocked(prisma.remoteFetchWorker.findFirst).mockResolvedValueOnce({ ...workerRow(), driver: 'cloudflare' } as never)
    await expect(maybeWarmupBeforeProbe({ workerId: 'w', sourcePageUrl: 'https://watch.example/p', warmupMode: 'required' })).rejects.toMatchObject({
      code: 'WARMUP_NOT_SUPPORTED',
    })
  })

  it('skips when relay lacks capability in auto, throws in required', async () => {
    vi.mocked(prisma.remoteFetchWorker.findFirst).mockResolvedValueOnce(workerRow({ capabilitiesJson: { streaming: true } }) as never)
    const skipped = await maybeWarmupBeforeProbe({ workerId: 'w', sourcePageUrl: 'https://watch.example/p', warmupMode: 'auto' })
    expect(skipped.skipReason).toBe('relay-no-capability')
    vi.mocked(prisma.remoteFetchWorker.findFirst).mockResolvedValueOnce(workerRow({ capabilitiesJson: { streaming: true } }) as never)
    await expect(maybeWarmupBeforeProbe({ workerId: 'w', sourcePageUrl: 'https://watch.example/p', warmupMode: 'required' })).rejects.toMatchObject({
      code: 'WARMUP_NOT_SUPPORTED',
    })
  })

  it('calls the relay once and dedupes concurrent callers (single-flight)', async () => {
    vi.mocked(prisma.remoteFetchWorker.findFirst).mockResolvedValue(workerRow() as never)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ protocolVersion: '9drive-relay-v1', status: 'warmed', navigationStatus: 200, mediaObserved: 1, browserMedia206: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const input = { importId: 'import-1', attempt: 1, workerId: 'worker-1', sourcePageUrl: 'https://watch.example/p', warmupMode: 'auto' as const }
    const [a, b] = await Promise.all([maybeWarmupBeforeProbe(input), maybeWarmupBeforeProbe(input)])
    expect(a.warmed).toBe(true)
    expect(b.warmed).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['x-9drive-signature']).toBeDefined()
    expect(opts.headers['x-9drive-timestamp']).toBeDefined()
    expect(opts.headers['x-9drive-nonce']).toBeDefined()
  })

  it('treats relay 429 as busy (skip in auto, throw in required)', async () => {
    vi.mocked(prisma.remoteFetchWorker.findFirst).mockResolvedValue(workerRow() as never)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })))
    const skipped = await maybeWarmupBeforeProbe({ importId: 'i1', workerId: 'worker-1', sourcePageUrl: 'https://watch.example/p', warmupMode: 'auto' })
    expect(skipped.skipReason).toBe('relay-busy')
    await expect(
      maybeWarmupBeforeProbe({ importId: 'i2', workerId: 'worker-1', sourcePageUrl: 'https://watch.example/p', warmupMode: 'required' }),
    ).rejects.toMatchObject({ code: 'WARMUP_BUSY' })
  })

  it('never falls back to Direct on warmup transport failure (auto skips, required throws)', async () => {
    vi.mocked(prisma.remoteFetchWorker.findFirst).mockResolvedValue(workerRow() as never)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }))
    const skipped = await maybeWarmupBeforeProbe({ workerId: 'worker-1', sourcePageUrl: 'https://watch.example/p', warmupMode: 'auto' })
    expect(skipped.skipped).toBe(true)
    await expect(maybeWarmupBeforeProbe({ workerId: 'worker-1', sourcePageUrl: 'https://watch.example/p', warmupMode: 'required' })).rejects.toMatchObject({
      code: 'WARMUP_FAILED',
    })
  })
})
