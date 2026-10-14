import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDriver } from './driver-registry.js'
import { vpsWorkerDriver } from './drivers/vps.js'
import { createWorker, updateWorker, serializeWorker, testWorkerConnection } from './workers.service.js'

// ── Mocks: isolate the service from prisma + audit + crypto ──────────────
const h = vi.hoisted(() => {
  const baseWorker = {
    id: 'worker-vps-1',
    name: 'VPS SG #1',
    slug: null,
    driver: 'vps',
    endpointUrl: 'https://relay.example.com',
    isEnabled: true,
    isDefault: false,
    priority: null,
    region: null,
    description: null,
    authType: 'hmac',
    secretEncrypted: 'enc:vps-shared-secret',
    configEncrypted: null,
    capabilitiesJson: null,
    metadataJson: null,
    status: 'unknown',
    lastHealthCheckAt: null,
    lastHealthyAt: null,
    lastFailedAt: null,
    lastErrorCode: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  const prismaMock = {
    remoteFetchWorker: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: any) => unknown) => fn({ remoteFetchWorker: h.prismaMock.remoteFetchWorker })),
  }
  return {
    baseWorker,
    prismaMock,
    auditSpy: vi.fn(),
    // Identity crypto: encrypted values stay comparable, plaintext recoverable.
    encryptSpy: vi.fn((s: string) => `enc:${s}`),
    decryptSpy: vi.fn((s: string) => s.replace(/^enc:/, '')),
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: (...args: unknown[]) => h.auditSpy(...args) }))
vi.mock('../../utils/crypto.js', () => ({
  encryptText: (s: string) => h.encryptSpy(s),
  decryptText: (s: string) => h.decryptSpy(s),
  randomToken: () => 'relay-secret-xyz',
}))

const SECRET = 'vps-shared-secret-value'

beforeAll(() => {
  registerDriver(vpsWorkerDriver)
})

beforeEach(() => {
  // clearAllMocks: reset call history between tests but keep the hoisted
  // implementations (unlike restoreAllMocks, which leaves stale history).
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  h.prismaMock.remoteFetchWorker.create.mockImplementation(async ({ data }: any) => ({ ...h.baseWorker, ...data }))
  h.prismaMock.remoteFetchWorker.findFirst.mockResolvedValue({ ...h.baseWorker })
  h.prismaMock.remoteFetchWorker.update.mockImplementation(async ({ data }: any) => ({ ...h.baseWorker, ...data }))
})

describe('vps worker create', () => {
  it('saves with valid HMAC credentials and stores authType hmac', async () => {
    const created = await createWorker('user-1', {
      name: 'VPS SG #1',
      driver: 'vps',
      endpointUrl: 'https://relay.example.com/',
      authType: 'hmac',
      secret: SECRET,
    }) as unknown as Record<string, unknown>
    expect(created.authType).toBe('hmac')
    expect(created.endpointUrl).toBe('https://relay.example.com')
    expect(created.status).toBe('unknown')
    const data = h.prismaMock.remoteFetchWorker.create.mock.calls[0][0].data
    expect(data.secretEncrypted).toBe(`enc:${SECRET}`)
    // The test crypto mock prefixes ciphertext; strip it before parsing the config blob.
    expect(JSON.parse(String(data.configEncrypted).replace(/^enc:/, ''))).toEqual({ manual: true, provider: 'vps' })
  })

  it('defaults omitted authType to the driver sole type (hmac), not none', async () => {
    const created = await createWorker('user-1', {
      name: 'VPS SG #1',
      driver: 'vps',
      endpointUrl: 'https://relay.example.com',
      secret: SECRET,
    }) as unknown as Record<string, unknown>
    expect(created.authType).toBe('hmac')
  })

  it('rejects explicit non-hmac auth with a clear validation error', async () => {
    await expect(createWorker('user-1', {
      name: 'VPS SG #1',
      driver: 'vps',
      endpointUrl: 'https://relay.example.com',
      authType: 'none',
      secret: SECRET,
    })).rejects.toMatchObject({ code: 'WORKER_DRIVER_CONFIG_INVALID' })
    await expect(createWorker('user-1', {
      name: 'VPS SG #1',
      driver: 'vps',
      endpointUrl: 'https://relay.example.com',
      authType: 'bearer',
      secret: SECRET,
    })).rejects.toMatchObject({ code: 'WORKER_DRIVER_CONFIG_INVALID' })
  })

  it('rejects a missing secret with a clear validation error', async () => {
    await expect(createWorker('user-1', {
      name: 'VPS SG #1',
      driver: 'vps',
      endpointUrl: 'https://relay.example.com',
      authType: 'hmac',
      secret: null,
    })).rejects.toMatchObject({ code: 'WORKER_DRIVER_CONFIG_INVALID' })
  })

  it('rejects non-https endpoints', async () => {
    await expect(createWorker('user-1', {
      name: 'VPS SG #1',
      driver: 'vps',
      endpointUrl: 'http://relay.example.com',
      authType: 'hmac',
      secret: SECRET,
    })).rejects.toMatchObject({ code: 'WORKER_ENDPOINT_INVALID' })
  })
})

describe('vps worker update', () => {
  it('keeps the stored secret when blank and updates the endpoint', async () => {
    const updated = await updateWorker('user-1', 'worker-vps-1', {
      endpointUrl: 'https://relay2.example.com',
    }) as unknown as Record<string, unknown>
    expect(updated.endpointUrl).toBe('https://relay2.example.com')
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    // Blank/absent secret → keep existing (never nulls the credential).
    expect(data.secretEncrypted).toBeUndefined()
  })

  it('replaces the secret when a new one is supplied', async () => {
    await updateWorker('user-1', 'worker-vps-1', { secret: 'brand-new-secret' })
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(data.secretEncrypted).toBe('enc:brand-new-secret')
  })
})

describe('vps secret redaction', () => {
  it('never exposes the secret in serialized API shapes', () => {
    const wire = serializeWorker({ ...h.baseWorker, secretEncrypted: `enc:${SECRET}` }) as Record<string, unknown>
    expect(wire.secretEncrypted).toBeUndefined()
    expect(wire.configEncrypted).toBeUndefined()
    expect(wire.credentialConfigured).toBe(true)
    expect(JSON.stringify(wire)).not.toContain(SECRET)
  })
})

describe('vps test connection', () => {
  function stubFetchOnce(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => handler(url, init)))
  }

  it('verifies the real relay endpoint with HMAC (healthy)', async () => {
    const seen: Array<{ url: string; signature: string | null }> = []
    stubFetchOnce(async (url, init) => {
      seen.push({ url, signature: new Headers(init.headers).get('x-9drive-signature') })
      return new Response(
        JSON.stringify({ service: '9drive-relay', protocolVersion: '9drive-relay-v1', status: 'ok', capabilities: { streaming: true, rangeRequests: true } }),
        { status: 200 },
      )
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const result = await testWorkerConnection('user-1', 'worker-vps-1')
    expect(result.status).toBe('healthy')
    // The actual endpoint was called over GET /health with an HMAC signature.
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://relay.example.com/health')
    expect(seen[0].signature).toMatch(/^[a-f0-9]{64}$/)
    // Healthy capabilities persisted; the secret never reaches logs.
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(data.status).toBe('healthy')
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain(SECRET)
    logSpy.mockRestore()
  })

  it('maps relay 401 to authentication failure (never a credential leak)', async () => {
    stubFetchOnce(async () => new Response('{}', { status: 401 }))
    const result = await testWorkerConnection('user-1', 'worker-vps-1')
    expect(result.status).toBe('unhealthy')
    expect(result.lastErrorCode).toBe('WORKER_AUTH_FAILED')
  })

  it('maps timeouts to a connection-timeout code', async () => {
    stubFetchOnce(async () => {
      const err = new Error('The operation was aborted due to timeout') as Error & { cause?: unknown }
      err.cause = Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' })
      throw err
    })
    const result = await testWorkerConnection('user-1', 'worker-vps-1')
    expect(result.status).toBe('unhealthy')
    expect(result.lastErrorCode).toBe('WORKER_CONNECTION_TIMEOUT')
  })

  it('maps protocol mismatch to a protocol code', async () => {
    stubFetchOnce(async () => new Response(JSON.stringify({ service: 'something-else', status: 'ok' }), { status: 200 }))
    const result = await testWorkerConnection('user-1', 'worker-vps-1')
    expect(result.status).toBe('unhealthy')
    expect(result.lastErrorCode).toBe('WORKER_PROTOCOL_INVALID')
  })
})
