import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import { probeRemoteUrl } from './probe.js'
import { SecureRemoteFetcher } from './secure-fetcher.js'
import type { RemoteFetchRequest, RemoteFetchResponse, RemoteFetchTransport } from '../remote-fetch-workers/types.js'

/**
 * Probe route selection tests (§direct/§worker): the ENTIRE Check URL probe
 * must run through the transport resolved for the selected worker — from the
 * very first network request (HEAD) through ranged GET and the HLS manifest.
 * No direct fallback, no backend DNS for the target in relay mode, worker
 * validation surfacing before any URL/DNS work.
 *
 * `createSecureFetcherForWorkerId` is mocked (the factory's real worker
 * validation is covered by the service + download-path tests); the real
 * SecureRemoteFetcher runs the probe's HEAD/GET/manifest phases against a
 * recording stub transport so we can assert WHAT issued every request.
 */
const h = vi.hoisted(() => {
  const createSecureFetcherForWorkerId = vi.fn()
  const validateRemoteUrl = vi.fn()
  const resolveAndValidateHost = vi.fn()
  return { createSecureFetcherForWorkerId, validateRemoteUrl, resolveAndValidateHost }
})

vi.mock('./secure-fetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-fetcher.js')>()
  return {
    ...actual,
    createSecureFetcherForWorkerId: (...args: unknown[]) => h.createSecureFetcherForWorkerId(...args),
  }
})

vi.mock('./ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ssrf.js')>()
  return {
    ...actual,
    validateRemoteUrl: h.validateRemoteUrl,
    resolveAndValidateHost: h.resolveAndValidateHost,
  }
})

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
mid/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
high/index.m3u8`

function bodyIterable(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield Buffer.from(text, 'utf8')
  })()
}

/** Recording stub transport: answers per method, records every request. */
function stubTransport(overrides: {
  headStatus?: number
  getStatus?: number
  contentType?: string
  getBody?: string
  finalUrl?: string
  rejectWith?: AppError
}) {
  const requests: Array<{ method: string; url: string; range?: string | null }> = []
  const transport: RemoteFetchTransport = {
    request: async (input: RemoteFetchRequest): Promise<RemoteFetchResponse> => {
      requests.push({ method: input.method ?? 'GET', url: input.url, range: input.range ?? null })
      if (overrides.rejectWith) throw overrides.rejectWith
      const method = input.method ?? 'GET'
      const status = method === 'HEAD' ? overrides.headStatus ?? 200 : overrides.getStatus ?? 200
      return {
        status,
        statusText: String(status),
        headers: { 'content-type': overrides.contentType ?? 'application/octet-stream', 'content-length': '0' } as Record<string, string>,
        body: method === 'HEAD' ? bodyIterable('') : bodyIterable(overrides.getBody ?? ''),
        finalUrl: overrides.finalUrl ?? input.url,
        redirectCount: 0,
      } as RemoteFetchResponse & { finalUrl?: string; redirectCount?: number }
    },
  }
  return { transport, requests }
}

function workerFetcher(transport: RemoteFetchTransport): SecureRemoteFetcher {
  return new SecureRemoteFetcher(transport, { route: 'worker', workerId: 'w-1', driver: 'cloudflare', relayHost: 'relay.example.workers.dev' })
}

function directFetcher(transport: RemoteFetchTransport): SecureRemoteFetcher {
  return new SecureRemoteFetcher(transport, { route: 'direct' })
}

beforeEach(() => {
  h.createSecureFetcherForWorkerId.mockReset()
  h.validateRemoteUrl.mockReset()
  h.resolveAndValidateHost.mockReset()
  h.validateRemoteUrl.mockImplementation(async (raw: string, opts?: { resolveDns?: boolean }) => {
    const url = new URL(raw)
    if (opts?.resolveDns) await h.resolveAndValidateHost(url.hostname)
    return url
  })
  h.resolveAndValidateHost.mockImplementation(async (host: string) => host)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('probe route selection: Direct (workerId=null)', () => {
  it('HEAD and ranged GET both use the direct transport', async () => {
    const { transport, requests } = stubTransport({})
    h.createSecureFetcherForWorkerId.mockImplementation(async (workerId: string | null) => {
      expect(workerId).toBeNull()
      return directFetcher(transport)
    })
    const result = await probeRemoteUrl('https://example.com/file.mp4', 't1', undefined, { workerId: null })
    // Direct mode still runs the full backend DNS gate.
    expect(h.validateRemoteUrl).toHaveBeenCalledWith('https://example.com/file.mp4', { resolveDns: true })
    expect(result.sourceType).toBe('direct_file')
    expect(requests.map((r) => r.method)).toEqual(['HEAD', 'GET'])
    expect(requests[1].range).toBe('bytes=0-0')
    // Only the direct fetcher was created — never a worker fetcher.
    expect(h.createSecureFetcherForWorkerId).toHaveBeenCalledTimes(1)
    expect(h.createSecureFetcherForWorkerId.mock.calls[0][0]).toBeNull()
  })
})

describe('probe route selection: Worker (workerId set)', () => {
  it('HEAD, ranged GET and no direct source request — relay only', async () => {
    const { transport, requests } = stubTransport({})
    h.createSecureFetcherForWorkerId.mockImplementation(async (workerId: string | null) => {
      expect(workerId).toBe('w-1')
      return workerFetcher(transport)
    })
    const result = await probeRemoteUrl('https://example.com/file.mp4', 't2', undefined, { workerId: 'w-1' })
    // Relay mode: syntax/policy validation WITHOUT backend DNS.
    expect(h.validateRemoteUrl).toHaveBeenCalledWith('https://example.com/file.mp4', { resolveDns: false })
    expect(h.resolveAndValidateHost).not.toHaveBeenCalled()
    expect(result.sourceType).toBe('direct_file')
    expect(requests.map((r) => r.method)).toEqual(['HEAD', 'GET'])
    // The factory was asked for the worker ONLY — never a direct fetcher.
    expect(h.createSecureFetcherForWorkerId).toHaveBeenCalledTimes(1)
    expect(h.createSecureFetcherForWorkerId.mock.calls[0][0]).toBe('w-1')
  })

  it('HLS master manifest is fetched through the SAME worker transport', async () => {
    const { transport, requests } = stubTransport({ contentType: 'application/vnd.apple.mpegurl', getBody: MASTER })
    h.createSecureFetcherForWorkerId.mockResolvedValue(workerFetcher(transport))
    const result = await probeRemoteUrl('https://example.com/live/master.m3u8', 't3', undefined, { workerId: 'w-1' })
    expect(result.sourceType).toBe('hls_master')
    expect(result.hls?.variants).toHaveLength(2)
    // HEAD + manifest GET on the HLS-hinted path — every byte through the worker.
    const methods = requests.map((r) => r.method)
    expect(methods).toContain('HEAD')
    expect(methods.filter((m) => m === 'GET').length).toBeGreaterThanOrEqual(1)
    expect(h.createSecureFetcherForWorkerId.mock.calls.every((c) => c[0] === 'w-1')).toBe(true)
  })

  it('relay failure propagates — NO silent direct fallback', async () => {
    const { transport } = stubTransport({ rejectWith: new AppError('WORKER_RELAY_PROTOCOL_ERROR', 'The relay received an invalid request.', 400) })
    h.createSecureFetcherForWorkerId.mockResolvedValue(workerFetcher(transport))
    await expect(
      probeRemoteUrl('https://example.com/file.mp4', 't4', undefined, { workerId: 'w-1' }),
    ).rejects.toMatchObject({ code: 'WORKER_RELAY_PROTOCOL_ERROR' })
    // The worker fetcher was the ONLY fetcher ever created (no re-resolution to direct).
    expect(h.createSecureFetcherForWorkerId).toHaveBeenCalledTimes(1)
    expect(h.createSecureFetcherForWorkerId.mock.calls[0][0]).toBe('w-1')
  })

  it('disabled worker → clear Worker validation error BEFORE any validation or source fetch', async () => {
    h.createSecureFetcherForWorkerId.mockRejectedValue(
      new AppError('REMOTE_IMPORT_WORKER_DISABLED', 'The selected network worker is disabled.', 409),
    )
    await expect(
      probeRemoteUrl('https://example.com/file.mp4', 't5', undefined, { workerId: 'w-off' }),
    ).rejects.toMatchObject({ code: 'REMOTE_IMPORT_WORKER_DISABLED' })
    // URL validation (and its DNS) never ran; no fetch happened.
    expect(h.validateRemoteUrl).not.toHaveBeenCalled()
  })

  it('missing worker → REMOTE_IMPORT_WORKER_UNAVAILABLE surfaces first', async () => {
    h.createSecureFetcherForWorkerId.mockRejectedValue(
      new AppError('REMOTE_IMPORT_WORKER_UNAVAILABLE', 'The selected network worker is no longer available.', 409),
    )
    await expect(
      probeRemoteUrl('https://example.com/file.mp4', 't6', undefined, { workerId: 'w-gone' }),
    ).rejects.toMatchObject({ code: 'REMOTE_IMPORT_WORKER_UNAVAILABLE' })
    expect(h.validateRemoteUrl).not.toHaveBeenCalled()
  })

  it('redirect finalUrl reported by the relay is used as the probe final URL', async () => {
    const { transport } = stubTransport({ finalUrl: 'https://cdn.example.com/redirected/master.m3u8', contentType: 'application/vnd.apple.mpegurl', getBody: MASTER })
    h.createSecureFetcherForWorkerId.mockResolvedValue(workerFetcher(transport))
    const result = await probeRemoteUrl('https://example.com/start', 't7', undefined, { workerId: 'w-1' })
    expect(result.finalUrl).toContain('/redirected/master.m3u8')
  })
})

describe('probe route diagnostics (§10/§11)', () => {
  it('logs route=worker + response route=worker for HEAD, never route=direct', async () => {
    const { transport } = stubTransport({})
    h.createSecureFetcherForWorkerId.mockResolvedValue(workerFetcher(transport))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await probeRemoteUrl('https://example.com/file.mp4', 't8', undefined, { workerId: 'w-1' })
      const lines = logSpy.mock.calls.map((c) => String(c[0]))
      // Worker probe: route=worker on the head request AND its response.
      const probeLines = lines.filter((l) => l.includes('[remote-import:probe]'))
      expect(probeLines.some((l) => l.includes('route=worker') && l.includes('method=HEAD'))).toBe(true)
      expect(probeLines.some((l) => l.includes('response route=worker') && l.includes('status=200'))).toBe(true)
      expect(probeLines.some((l) => l.includes('route=direct'))).toBe(false)
      // Diagnostics carry worker/driver/relayHost but never the target URL query.
      expect(probeLines.some((l) => l.includes('workerId=w-1') && l.includes('driver=cloudflare') && l.includes('relayHost=relay.example.workers.dev'))).toBe(true)
      expect(JSON.stringify(probeLines)).not.toContain('?')
    } finally {
      logSpy.mockRestore()
    }
  })
})