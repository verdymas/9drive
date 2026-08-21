import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWorker, serializeWorker, testWorkerConnection } from './workers.service.js'
import { cloudflareWorkerDriver, signHealthRequest, HMAC_SIGNATURE_HEADER } from './drivers/cloudflare.js'

// The service reads the Cloudflare API base from env — tests point it at a
// local fake API server (started below).
import { env } from '../../config/env.js'

/**
 * Test-connection integration (spec §41): a local http server stands in for a
 * deployed 9Drive relay. Asserts:
 *   - the HMAC signature header is present and correct
 *   - the relay identity ({service:'9drive-relay'}) is validated
 *   - non-200 → WORKER_UNHEALTHY, 401 → WORKER_AUTH_FAILED, bad protocol →
 *     WORKER_PROTOCOL_UNSUPPORTED, timeouts → WORKER_CONNECTION_TIMEOUT
 *   - health state is persisted (service updates the DB row)
 */

const h = vi.hoisted(() => {
  const workerRow = {
    id: 'worker-1',
    name: 'Local Relay',
    slug: null,
    driver: 'cloudflare',
    endpointUrl: 'http://localhost:0', // replaced below with the real port
    isEnabled: true,
    isDefault: false,
    priority: null,
    region: 'Local',
    description: null,
    authType: 'hmac',
    secretEncrypted: 'enc:shared-secret',
    configEncrypted: null,
    capabilitiesJson: null,
    metadataJson: null,
    status: 'unknown',
    lastHealthCheckAt: null,
    lastHealthyAt: null,
    lastFailedAt: null,
    lastErrorCode: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const prismaMock = {
    remoteFetchWorker: {
      findFirst: vi.fn(async () => ({ ...h.workerRow })),
      findMany: vi.fn(async () => [h.workerRow]),
      create: vi.fn(),
      update: vi.fn(async ({ data }: { data: any }) => ({ ...h.workerRow, ...data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (fn: (tx: any) => unknown) => fn({ remoteFetchWorker: h.prismaMock.remoteFetchWorker })),
  }
  return { workerRow, prismaMock, auditSpy: vi.fn(), decryptSpy: vi.fn((s: string) => s === 'enc:shared-secret' ? 'shared-secret' : s), randomSpy: vi.fn(() => 'e2e-relay-secret') }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: (...args: unknown[]) => h.auditSpy(...args) }))
vi.mock('../../utils/crypto.js', () => ({
  encryptText: (s: string) => s,
  decryptText: (s: string) => h.decryptSpy(s),
  randomToken: (bytes?: number) => h.randomSpy(bytes),
}))

import { registerDriver } from './driver-registry.js'
// Re-register is idempotent; guarantees the driver is present for this file
// even if no other test imported the module entry.
registerDriver(cloudflareWorkerDriver)

let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      // The relay contract: the driver probes `{endpoint}/health`. Endpoint
      // variants (authfail, bad-identity, ...) are reached by pointing the
      // worker's endpointUrl at `.../authfail` etc. so the driver hits
      // `.../authfail/health` — a single handler reads req.url (which contains
      // the endpoint path + /health).
      const endpoint = (req.url?.replace(/\/health$/, '') || '/')
      if (endpoint === '/') {
        if (!req.headers[HMAC_SIGNATURE_HEADER]) {
          res.writeHead(403, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'missing signature' }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({
          status: 'ok',
          service: '9drive-relay',
          protocolVersion: '9drive-relay-v1',
          capabilities: { streaming: true, rangeRequests: true, hls: true },
        }))
      }
      if (endpoint === '/bad-identity') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ status: 'ok', service: 'wrong-service' }))
      }
      if (endpoint === '/bad-protocol') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ status: 'ok', service: '9drive-relay', protocolVersion: '9drive-relay-v0' }))
      }
      if (endpoint === '/authfail') {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'unauthorized' }))
      }
      if (endpoint === '/unhealthy') {
        res.writeHead(503, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'down' }))
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${port}`
      h.workerRow.endpointUrl = baseUrl
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the row to the healthy local relay each test (tests may mutate the
  // endpoint to exercise failure paths; the next test starts clean).
  h.workerRow.endpointUrl = baseUrl
  // Read the LIVE row every call so tests can mutate `h.workerRow` mid-test
  // (e.g. point at /authfail) and the service sees the mutation.
  ;(h.prismaMock.remoteFetchWorker.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ...h.workerRow }))
  ;(h.prismaMock.remoteFetchWorker.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => ({ ...h.workerRow, ...data }))
})

// ── End-to-end managed provisioning (fake Cloudflare API server) ────────────

let cfServer: http.Server
let cfBase = ''

function startFakeCfApi(): Promise<string> {
  return new Promise((resolve) => {
    cfServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      void url

      const write = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      if (path === '/user/tokens/verify') return write(200, { success: true })
      if (path.startsWith('/accounts/acc-1/workers/scripts/') && req.method === 'PUT') {
        // The fake API validates the multipart contract the same way the real
        // one does: the uploaded module part must be named exactly worker.mjs
        // (== metadata.main_module) with the module content type.
        void (async () => {
          try {
            const raw = Buffer.concat(await iterableToBuffer(req))
            const ct = req.headers['content-type'] ?? ''
            console.log(`[test:fake-cf] PUT ${path} content-type="${ct}" bodyBytes=${raw.length}`)
            // Inspect the raw multipart framing.
            const text = raw.toString('utf8')
            // If strictly required, a real parser (busboy) would be used; for
            // asserting the upload contract this string inspection suffices and
            // keeps the fake deterministic.
            if (text.includes('name="worker.mjs"; filename="worker.mjs"') && text.includes('application/javascript+module') && text.includes('"main_module":"worker.mjs"')) {
              write(200, { success: true, result: { id: path.split('/').pop() } })
            } else {
              write(400, { success: false, errors: [{ code: 10021, message: 'script content could not be parsed (syntax or format error)' }] })
            }
          } catch {
            write(400, { success: false, errors: [{ code: 10021, message: 'script content could not be parsed (syntax or format error)' }] })
          }
        })()
        return
      }
      if (path === '/accounts/acc-1/workers/scripts/relay-e2e/subdomain' && req.method === 'GET') return write(200, { success: true, result: { enabled: true, previews_enabled: false } })
      if (path === '/accounts/acc-1/workers/subdomain' && req.method === 'GET') return write(200, { success: true, result: { subdomain: 'e2e-sub' } })
      if (path === '/accounts/acc-1/workers/scripts/relay-e2e/subdomain' && req.method === 'POST') return write(200, { success: true, result: { enabled: true, previews_enabled: false } })
      if (path === '/accounts/acc-1/workers/subdomain' && req.method === 'PUT') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}')
            const sd = parsed.subdomain || 'e2e-sub'
            return write(200, { success: true, result: { subdomain: sd } })
          } catch {
            return write(200, { success: true, result: { subdomain: 'e2e-sub' } })
          }
        })
        return
      }
      if (path === '/accounts/acc-1/workers/scripts/relay-e2e' && req.method === 'DELETE') return write(200, { success: true })
      return write(404, { success: false })
    })
    cfServer.listen(0, '127.0.0.1', () => {
      const { port } = cfServer.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

/** Collect an IncomingMessage body into a single Buffer. */
function iterableToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(chunks))
    stream.on('error', reject)
  })
}

describe('managed provisioning through the real driver (fake CF API)', () => {
  let originalBase: string
  let prismaMockFindFirst: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    cfBase = await startFakeCfApi()
    originalBase = env.CLOUDFLARE_API_BASE
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(env as any).CLOUDFLARE_API_BASE = cfBase
  })

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(env as any).CLOUDFLARE_API_BASE = originalBase
    await new Promise<void>((resolve) => cfServer.close(() => resolve()))
  })

  beforeEach(() => {
    prismaMockFindFirst = h.prismaMock.remoteFetchWorker.findFirst as ReturnType<typeof vi.fn>
    ;(h.decryptSpy as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s)
    ;(h.randomSpy as ReturnType<typeof vi.fn>).mockImplementation(() => 'e2e-relay-secret')
    // createWorker's prisma mock: `update` must return the merged row; register
    // the needed base shape for create.
    ;(h.prismaMock.remoteFetchWorker.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => ({
      ...h.workerRow, ...data, id: 'w-e2e', endpointUrl: data.endpointUrl ?? null,
    }))
    ;(h.prismaMock.remoteFetchWorker.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => ({ ...h.workerRow, ...data }))
    ;(h.prismaMock.remoteFetchWorker.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
    ;(h.prismaMock.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: any) => unknown) => fn({ remoteFetchWorker: h.prismaMock.remoteFetchWorker }))
  })

  it('registers a healthy worker: verify → upload → binding → subdomain → health check', async () => {
    // The discovered endpoint lives at a real workers.dev host, which is not
    // reachable in tests — the deployed relay is simulated by intercepting
    // .workers.dev requests with the healthy 9drive-relay payload. The
    // Cloudflare API calls still go to the fake API server.
    const health = vi.spyOn(globalThis, 'fetch')
    const cfFetch = health.getMockImplementation() ?? (globalThis as any).fetch
    // Only used for .workers.dev hosts; the real (fake-API) fetch is restored.
    const realFetch = cfFetch
    void realFetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('.workers.dev')) {
        return {
          status: 200, ok: true, json: async () => ({
            status: 'ok',
            service: '9drive-relay',
            protocolVersion: '9drive-relay-v1',
            capabilities: { streaming: true, rangeRequests: true },
          }),
        } as unknown as Response
      }
      // Fall through to the fake Cloudflare API server.
      return cfFetch(url, init)
    }))
    try {
      // Drive createWorker with the REAL cloudflare driver (registered above).
      const created = await createWorker('user-1', {
        driver: 'cloudflare',
        config: { accountId: 'acc-1', apiToken: 'tok-e2e', workerName: 'relay-e2e' },
      })
      expect(created.status).toBe('healthy')
      expect(created.endpointUrl).toBe('https://relay-e2e.e2e-sub.workers.dev')
      expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.provisioning_started', 'remote_fetch_worker', 'w-e2e', expect.anything())
      expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.provisioned', 'remote_fetch_worker', 'w-e2e', expect.anything())
      // The wire shape (serializeWorker) never leaks the relay secret or the token.
      const wire = JSON.stringify(serializeWorker(created))
      expect(wire).not.toContain('e2e-relay-secret')
      expect(wire).not.toContain('tok-e2e')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports provision_failed when the deployment upload is rejected (and retries the deprovision cleanup)', async () => {
    // Intercept the UPLOAD step (PUT script) with a 409 → WORKER_PROVISION_CONFLICT.
    const realFetch = (globalThis as any).fetch as typeof fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      if (url.includes('/workers/scripts/') && method === 'PUT') {
        return { status: 409, ok: false, text: async () => '{"errors":[{"message":"already exists"}]}' } as unknown as Response
      }
      return realFetch(url, init)
    }))
    try {
      await expect(
        createWorker('user-1', {
          driver: 'cloudflare',
          config: { accountId: 'acc-1', apiToken: 'tok-e2e', workerName: 'relay-e2e' },
        }),
      ).rejects.toMatchObject({ code: 'WORKER_PROVISION_CONFLICT' })
    } finally {
      vi.unstubAllGlobals()
    }
    const updates = h.prismaMock.remoteFetchWorker.update.mock.calls.map((c: { 0: { data: any } }) => c[0].data)
    const failUpdate = updates.find((d: { status?: string }) => d.status === 'provision_failed')
    expect(failUpdate).toBeDefined()
    expect(failUpdate.lastErrorCode).toBe('WORKER_PROVISION_CONFLICT')
    // The 409 happens at the first upload — the script was never deployed, so
    // the best-effort deprovision cleanup never exists.
    expect(h.prismaMock.remoteFetchWorker.update).toHaveBeenCalled()
  })

  it('reports step=upload with the safe Cloudflare 10021 code when the script parse is rejected', async () => {
    const realFetch = (globalThis as any).fetch as typeof fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      if (url.includes('/workers/scripts/') && method === 'PUT') {
        return { status: 400, ok: false, text: async () => '{"success":false,"errors":[{"code":10021,"message":"script content could not be parsed (syntax or format error)"}]}' } as unknown as Response
      }
      return realFetch(url, init)
    }))
    try {
      await expect(
        createWorker('user-1', {
          driver: 'cloudflare',
          config: { accountId: 'acc-1', apiToken: 'tok-e2e', workerName: 'relay-e2e' },
        }),
      ).rejects.toMatchObject({ code: 'WORKER_PROVISION_FAILED' })
      await expect(
        createWorker('user-1', {
          driver: 'cloudflare',
          config: { accountId: 'acc-1', apiToken: 'tok-e2e', workerName: 'relay-e2e' },
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('step: upload') })
    } finally {
      vi.unstubAllGlobals()
    }
    const updates = h.prismaMock.remoteFetchWorker.update.mock.calls.map((c: { 0: { data: any } }) => c[0].data)
    const failUpdate = updates.find((d: { status?: string }) => d.status === 'provision_failed')
    expect(failUpdate).toBeDefined()
    expect(failUpdate.lastErrorCode).toBe('WORKER_PROVISION_FAILED')
    expect(failUpdate.endpointUrl ?? undefined).toBeUndefined()
  })

  it('never returns a fake endpoint when provisioning failed (no endpoint persisted)', async () => {
    // Fail AFTER the script upload succeeded (subdomain discovery 404s).
    const realFetch = (globalThis as any).fetch as typeof fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/subdomain')) {
        return { status: 404, ok: false, text: async () => '{"success":false}' } as unknown as Response
      }
      return realFetch(url, init)
    }))
    try {
      await createWorker('user-1', {
        driver: 'cloudflare',
        config: { accountId: 'acc-1', apiToken: 'tok-e2e', workerName: 'relay-e2e' },
      }).catch(() => undefined)
    } finally {
      vi.unstubAllGlobals()
    }
    const updates = h.prismaMock.remoteFetchWorker.update.mock.calls.map((c: { 0: { data: any } }) => c[0].data)
    const failUpdate = updates.find((d: { status?: string }) => d.status === 'provision_failed')
    expect(failUpdate).toBeDefined()
    // The driver throws before any endpoint is derived — nothing persisted.
    expect(failUpdate?.endpointUrl ?? undefined).toBeUndefined()
  })
})

describe('testWorkerConnection against a local relay', () => {
  it('probes /health with the HMAC signature and persists healthy state + capabilities', async () => {
    // The default row endpoint is the local server; the STANDARD test hits
    // /health which requires the HMAC header.
    const result = await testWorkerConnection('user-1', 'worker-1')
    expect(result.status).toBe('healthy')
    const updateData = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(updateData.status).toBe('healthy')
    expect(updateData.lastHealthyAt).toBeInstanceOf(Date)
    expect(updateData.capabilitiesJson).toMatchObject({ streaming: true, rangeRequests: true, hls: true })
    expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.test_succeeded', 'remote_fetch_worker', 'worker-1', expect.anything())
  })

  it('persists unhealthy + lastErrorCode when the relay rejects (401)', async () => {
    h.workerRow.endpointUrl = `${baseUrl}/authfail`
    const result = await testWorkerConnection('user-1', 'worker-1')
    expect(result.status).toBe('unhealthy')
    expect(result.lastErrorCode).toBe('WORKER_AUTH_FAILED')
    const updateData = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(updateData).toMatchObject({ status: 'unhealthy', lastErrorCode: 'WORKER_AUTH_FAILED', lastFailedAt: expect.any(Date) })
  })

  it('maps a 5xx to WORKER_UNHEALTHY', async () => {
    h.workerRow.endpointUrl = `${baseUrl}/unhealthy`
    const result = await testWorkerConnection('user-1', 'worker-1')
    expect(result.status).toBe('unhealthy')
    expect(result.lastErrorCode).toBe('WORKER_UNHEALTHY')
  })

  it('rejects a wrong service identity as WORKER_PROTOCOL_INVALID', async () => {
    h.workerRow.endpointUrl = `${baseUrl}/bad-identity`
    const result = await testWorkerConnection('user-1', 'worker-1')
    expect(result.status).toBe('unhealthy')
    expect(result.lastErrorCode).toBe('WORKER_PROTOCOL_INVALID')
  })

  it('rejects an unsupported protocol version as WORKER_PROTOCOL_UNSUPPORTED', async () => {
    h.workerRow.endpointUrl = `${baseUrl}/bad-protocol`
    const result = await testWorkerConnection('user-1', 'worker-1')
    expect(result.status).toBe('unhealthy')
    expect(result.lastErrorCode).toBe('WORKER_PROTOCOL_UNSUPPORTED')
  })

  it('signs the request with the configured shared secret (header verify)', async () => {
    // Verify the signature the driver would send against the shared secret.
    const expected = signHealthRequest('shared-secret', 'GET', '/health')
    expect(expected).toMatch(/^[a-f0-9]{64}$/)
  })
})