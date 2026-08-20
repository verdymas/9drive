import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import { createWorker, updateWorker, serializeWorker, setDefaultWorker, disableWorker, deleteWorker, testWorkerConnection, listWorkers, getWorker } from './workers.service.js'
import { registerDriver } from './driver-registry.js'
import { cloudflareWorkerDriver } from './drivers/cloudflare.js'

// ── Mocks: isolate the service from prisma + audit + crypto + driver registry ─
const h = vi.hoisted(() => {
  const baseWorker = {
    id: 'worker-1',
    name: 'Cloudflare SG #1',
    slug: null,
    driver: 'cloudflare',
    endpointUrl: 'https://relay.example.workers.dev',
    isEnabled: true,
    isDefault: false,
    priority: 10,
    region: 'Singapore',
    description: null,
    authType: 'hmac',
    secretEncrypted: 'enc:secret',
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
  // Manual-style driver (managed: false) so existing CRUD tests exercise the
  // legacy path, plus full managed spies for the provisioning tests.
  const fakeDriver = {
    key: 'cloudflare',
    displayName: 'Cloudflare Worker',
    validateConfig: vi.fn(async () => ({ endpointUrl: 'https://relay.example.workers.dev' })),
    testConnection: vi.fn(async () => ({ status: 'healthy', protocolVersion: '9drive-relay-v1', capabilities: { streaming: true } })),
    getMetadata: vi.fn(() => ({ key: 'cloudflare', displayName: 'Cloudflare Worker', managed: false, authTypes: ['hmac'], fields: [] })),
    provision: vi.fn(async () => ({ endpointUrl: 'https://relay.example.workers.dev', protocolVersion: '9drive-relay-v1' })),
    update: vi.fn(async () => ({ endpointUrl: undefined })),
    deprovision: vi.fn(async () => undefined),
  }
  return {
    baseWorker, prismaMock, fakeDriver,
    auditSpy: vi.fn(),
    encryptSpy: vi.fn((s: string) => s),
    decryptSpy: vi.fn((s: string) => s),
    randomSpy: vi.fn(() => 'relay-secret-xyz'),
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: (...args: unknown[]) => h.auditSpy(...args) }))
vi.mock('../../utils/crypto.js', () => ({
  encryptText: (s: string) => h.encryptSpy(s),
  decryptText: (s: string) => h.decryptSpy(s),
  randomToken: (bytes?: number) => h.randomSpy(bytes),
}))
vi.mock('./driver-registry.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./driver-registry.js')>()
  return {
    ...original,
    resolveDriver: (key: string) => {
      if (key !== 'cloudflare') throw new AppError('WORKER_DRIVER_UNSUPPORTED', 'The worker uses a service that is not supported.', 400)
      return h.fakeDriver
    },
  }
})

// Import AFTER mocks (vi.mock hoists).
import { listDriverMetadata } from './workers.driver-metadata.js'

beforeAll(() => {
  registerDriver(cloudflareWorkerDriver)
})

function resetMocks() {
  vi.resetAllMocks()
  // vi.resetAllMocks() clears implementations too — reinstall the crypto
  // identity spies every test, and restore the base worker shape (managed
  // describes mutate it).
  ;(h.auditSpy as ReturnType<typeof vi.fn>).mockImplementation(() => undefined)
  ;(h.encryptSpy as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s)
  ;(h.decryptSpy as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s)
  ;(h.randomSpy as ReturnType<typeof vi.fn>).mockImplementation(() => 'relay-secret-xyz')
  h.baseWorker.secretEncrypted = 'enc:secret'
  h.baseWorker.configEncrypted = null
  const tx = h.prismaMock.remoteFetchWorker
  ;(tx.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => ({ ...h.baseWorker, ...data }))
  ;(tx.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => ({ ...h.baseWorker, ...data }))
  ;(tx.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 })
  ;(tx.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(h.baseWorker)
  ;(tx.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([h.baseWorker])
  ;(h.fakeDriver.getMetadata as ReturnType<typeof vi.fn>).mockReturnValue({ key: 'cloudflare', displayName: 'Cloudflare Worker', managed: false, authTypes: ['hmac'], fields: [] })
  ;(h.fakeDriver.validateConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ endpointUrl: 'https://relay.example.workers.dev' })
  ;(h.fakeDriver.testConnection as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'healthy', protocolVersion: '9drive-relay-v1', capabilities: { streaming: true } })
  ;(h.fakeDriver.provision as ReturnType<typeof vi.fn>).mockResolvedValue({ endpointUrl: 'https://relay.example.workers.dev', protocolVersion: '9drive-relay-v1' })
  ;(h.fakeDriver.update as ReturnType<typeof vi.fn>).mockResolvedValue({ endpointUrl: undefined })
  ;(h.fakeDriver.deprovision as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
}

describe('serializeWorker', () => {
  it('never returns encrypted blobs or decrypted secrets — only credentialConfigured', () => {
    const serialized = serializeWorker(h.baseWorker)
    expect(serialized.secretEncrypted).toBeUndefined()
    expect(serialized.configEncrypted).toBeUndefined()
    expect(serialized.credentialConfigured).toBe(true)
    expect(JSON.stringify(serialized)).not.toContain('enc:secret')
  })

  it('reports credentialConfigured=false when no secret is stored', () => {
    const serialized = serializeWorker({ ...h.baseWorker, secretEncrypted: null })
    expect(serialized.credentialConfigured).toBe(false)
  })

  it('surfaces safe providerConfig (accountId/workerName) but never the encrypted token', () => {
    const row = {
      ...h.baseWorker,
      configEncrypted: JSON.stringify({
        version: 1,
        config: { accountId: 'acc-1', workerName: 'relay-1' },
        credentials: { apiToken: 'api-token-secret' },
        runtime: { endpointUrl: null, protocolVersion: '9drive-relay-v1' },
      }),
    }
    const serialized = serializeWorker(row)
    expect(serialized.providerConfig).toMatchObject({ accountId: 'acc-1', workerName: 'relay-1' })
    const wire = JSON.stringify(serialized)
    expect(wire).not.toContain('api-token-secret')
    expect(wire).not.toContain('configEncrypted')
  })

  it('providerConfig is null when the encrypted blob is unreadable (fail-safe)', () => {
    const serialized = serializeWorker({ ...h.baseWorker, configEncrypted: 'garbage-not-encrypted' })
    expect(serialized.providerConfig).toBeNull()
  })
})

describe('createWorker (manual driver — managed: false)', () => {
  beforeEach(resetMocks)

  it('encrypts the secret on create and never persists the plaintext', async () => {
    await createWorker('user-1', {
      name: 'Cloudflare SG #1',
      driver: 'cloudflare',
      endpointUrl: 'https://relay.example.workers.dev',
      secret: 'shared-secret-123',
    })
    const tx = h.prismaMock.remoteFetchWorker.create
    expect(tx).toHaveBeenCalledTimes(1)
    const data = tx.mock.calls[0][0].data
    // The real encryptText wraps the value (AES-256-GCM `iv:tag:ciphertext`);
    // the identity mock stands in for it, so assert the encryption boundary:
    // the plaintext goes through encryptText and never appears as a literal
    // raw secret column value in an API response.
    expect(h.encryptSpy).toHaveBeenCalledWith('shared-secret-123')
    expect(data.secretEncrypted).toBe(h.encryptSpy.mock.results[0].value)
    expect(data.status).toBe('unknown')
  })

  it('unsetting a previous default is transactional', async () => {
    await createWorker('user-1', { name: 'US', driver: 'cloudflare', endpointUrl: 'https://us.example.workers.dev', isDefault: true })
    expect(h.prismaMock.$transaction).toHaveBeenCalled()
    expect(h.prismaMock.remoteFetchWorker.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, deletedAt: null },
      data: { isDefault: false },
    })
  })

  it('rejects an unsupported driver', async () => {
    await expect(
      createWorker('user-1', { name: 'Vercel', driver: 'vercel', endpointUrl: 'https://vercel.example.workers.dev' }),
    ).rejects.toMatchObject({ code: 'WORKER_DRIVER_UNSUPPORTED' })
  })
})

describe('createWorker (managed driver — provisioning flow)', () => {
  beforeEach(() => {
    resetMocks()
    ;(h.fakeDriver.getMetadata as ReturnType<typeof vi.fn>).mockReturnValue({ key: 'cloudflare', displayName: 'Cloudflare Worker', managed: true, authTypes: ['hmac'], fields: [] })
    ;(h.fakeDriver.validateConfig as ReturnType<typeof vi.fn>).mockImplementation(async (input: { config?: Record<string, string> }) => ({
      endpointUrl: null,
      configEncryptedInput: {
        version: 1,
        config: { accountId: input.config?.accountId ?? '', workerName: input.config?.workerName ?? '' },
        credentials: { apiToken: input.config?.apiToken ?? '' },
        runtime: { endpointUrl: null, protocolVersion: '9drive-relay-v1' },
      },
    }))
  })

  it('provisions: persist provisioning → driver.provision with generated secret → health test → healthy', async () => {
    const created = await createWorker('user-1', {
      driver: 'cloudflare',
      config: { accountId: 'acc-1', apiToken: 'tok-1', workerName: 'relay-1' },
    })
    // The relay secret is generated server-side and encrypted at rest.
    expect(h.randomSpy).toHaveBeenCalledWith(32)
    expect(h.encryptSpy).toHaveBeenCalledWith('relay-secret-xyz')

    const createData = h.prismaMock.remoteFetchWorker.create.mock.calls[0][0].data
    expect(createData).toMatchObject({ status: 'provisioning', name: 'relay-1', endpointUrl: null })
    // configEncrypted is the driver-validated blob (contains the apiToken, but
    // ONLY inside the encrypted form — see serializeWorker tests).
    expect(JSON.parse(createData.configEncrypted)).toMatchObject({
      config: { accountId: 'acc-1', workerName: 'relay-1' },
      credentials: { apiToken: 'tok-1' },
    })

    expect(h.fakeDriver.provision).toHaveBeenCalledWith({ config: { accountId: 'acc-1', apiToken: 'tok-1', workerName: 'relay-1' }, secret: 'relay-secret-xyz' })
    expect(h.fakeDriver.testConnection).toHaveBeenCalledWith({ endpointUrl: 'https://relay.example.workers.dev', authType: 'hmac', secret: 'relay-secret-xyz' })

    const healthyUpdate = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(healthyUpdate).toMatchObject({ status: 'healthy', endpointUrl: 'https://relay.example.workers.dev' })
    expect(created.status).toBe('healthy')
    expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.provisioning_started', 'remote_fetch_worker', 'worker-1', expect.anything())
    expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.provisioned', 'remote_fetch_worker', 'worker-1', expect.anything())
  })

  it('keeps the apiToken and relay secret out of every API response', async () => {
    const created = await createWorker('user-1', {
      driver: 'cloudflare',
      config: { accountId: 'acc-1', apiToken: 'tok-secret-1', workerName: 'relay-1' },
    })
    const wire = JSON.stringify(serializeWorker(created))
    expect(wire).not.toContain('tok-secret-1')
    expect(wire).not.toContain('relay-secret-xyz')
    expect(serializeWorker(created).credentialConfigured).toBe(true)
  })

  it('deploy failure → provision_failed + best-effort deprovision + error re-thrown', async () => {
    ;(h.fakeDriver.provision as ReturnType<typeof vi.fn>).mockRejectedValue(new AppError('WORKER_PROVISION_FAILED', 'The relay could not be provisioned by the provider.', 400))
    await expect(
      createWorker('user-1', { driver: 'cloudflare', config: { accountId: 'acc-1', apiToken: 'tok-1', workerName: 'relay-1' } }),
    ).rejects.toMatchObject({ code: 'WORKER_PROVISION_FAILED' })

    const failUpdate = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(failUpdate).toMatchObject({ status: 'provision_failed', lastErrorCode: 'WORKER_PROVISION_FAILED' })
    expect(h.fakeDriver.deprovision).toHaveBeenCalledWith({ config: { accountId: 'acc-1', apiToken: 'tok-1', workerName: 'relay-1' } })
    expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.provision_failed', 'remote_fetch_worker', 'worker-1', expect.anything())
  })

  it('a failing cleanup never masks the original provisioning error', async () => {
    ;(h.fakeDriver.provision as ReturnType<typeof vi.fn>).mockRejectedValue(new AppError('WORKER_PROVISION_FAILED', 'nope', 400))
    ;(h.fakeDriver.deprovision as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('provider unreachable'))
    await expect(
      createWorker('user-1', { driver: 'cloudflare', config: { accountId: 'acc-1', apiToken: 'tok-1', workerName: 'relay-1' } }),
    ).rejects.toMatchObject({ code: 'WORKER_PROVISION_FAILED' })
  })
})

describe('updateWorker secret handling (manual driver)', () => {
  beforeEach(resetMocks)

  it('keeps the existing secret when none is supplied (blank field)', async () => {
    await updateWorker('user-1', 'worker-1', { name: 'Renamed' })
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    // `undefined` means "don't touch" to Prisma — the stored secret survives.
    expect(data.secretEncrypted).toBeUndefined()
    expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.updated', 'remote_fetch_worker', 'worker-1', expect.objectContaining({ credentialUpdated: false }))
  })

  it('replaces the secret when a new one is supplied, and records credentialUpdated', async () => {
    await updateWorker('user-1', 'worker-1', { secret: 'new-secret-456' })
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(h.encryptSpy).toHaveBeenCalledWith('new-secret-456')
    expect(data.secretEncrypted).toBe('new-secret-456')
    expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.updated', 'remote_fetch_worker', 'worker-1', expect.objectContaining({ credentialUpdated: true }))
  })

  it('clears the secret when explicitly nulled', async () => {
    await updateWorker('user-1', 'worker-1', { secret: null })
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(data.secretEncrypted).toBeNull()
  })
})

describe('updateWorker (managed driver)', () => {
  beforeEach(() => {
    resetMocks()
    ;(h.fakeDriver.getMetadata as ReturnType<typeof vi.fn>).mockReturnValue({ key: 'cloudflare', displayName: 'Cloudflare Worker', managed: true, authTypes: ['hmac'], fields: [] })
    ;(h.fakeDriver.update as ReturnType<typeof vi.fn>).mockResolvedValue({ endpointUrl: undefined })
    // Identity decrypt: decryptConfig JSON.parses the (fake) decrypted blob.
    h.baseWorker.configEncrypted = JSON.stringify({
      version: 1,
      config: { accountId: 'acc-1', workerName: 'relay-1' },
      credentials: { apiToken: 'stored-token' },
      runtime: { endpointUrl: 'https://relay-1.sub.workers.dev', protocolVersion: '9drive-relay-v1' },
    })
    h.baseWorker.secretEncrypted = 'enc:relay-secret'
  })

  it('blank apiToken → driver.update receives the stored token (kept)', async () => {
    await updateWorker('user-1', 'worker-1', { config: { accountId: 'acc-1', workerName: 'relay-2' } })
    expect(h.fakeDriver.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // Blank apiToken on edit keeps the stored one — merged in by the service.
        config: expect.objectContaining({ apiToken: 'stored-token', workerName: 'relay-2' }),
        storedConfig: expect.objectContaining({ accountId: 'acc-1', workerName: 'relay-1' }),
        secret: 'enc:relay-secret', // identity decrypt — the SAME secret the driver sees
      }),
    )
  })

  it('new apiToken replaces the stored one — never persisted as plaintext', async () => {
    await updateWorker('user-1', 'worker-1', { config: { apiToken: 'new-token-abc' } })
    const call = h.fakeDriver.update.mock.calls[0][0]
    expect(call.config.apiToken).toBe('new-token-abc')
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(data.configEncrypted).toBeUndefined() // driver returned no change
    const wire = JSON.stringify(serializeWorker({ ...h.baseWorker, ...data }))
    expect(wire).not.toContain('new-token-abc')
  })
})

describe('setDefaultWorker / disableWorker / deleteWorker invariants', () => {
  beforeEach(resetMocks)

  it('rejects setting a disabled worker as default', async () => {
    ;(h.prismaMock.remoteFetchWorker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ ...h.baseWorker, isEnabled: false })
    await expect(setDefaultWorker('user-1', 'worker-1')).rejects.toMatchObject({ code: 'WORKER_DISABLED' })
    expect(h.prismaMock.remoteFetchWorker.update).not.toHaveBeenCalled()
  })

  it('disable clears the default flag atomically (transaction)', async () => {
    ;(h.prismaMock.remoteFetchWorker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ ...h.baseWorker, isDefault: true })
    await disableWorker('user-1', 'worker-1')
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(data).toMatchObject({ isEnabled: false, isDefault: false, status: 'disabled' })
    expect(h.prismaMock.$transaction).toHaveBeenCalled()
  })

  it('manual delete is a soft delete that clears enabled + default', async () => {
    await deleteWorker('user-1', 'worker-1')
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(data.deletedAt).toBeInstanceOf(Date)
    expect(data).toMatchObject({ isEnabled: false, isDefault: false, status: 'disabled' })
  })

  it('managed delete deprovisions the remote script BEFORE the soft delete', async () => {
    ;(h.fakeDriver.getMetadata as ReturnType<typeof vi.fn>).mockReturnValue({ key: 'cloudflare', displayName: 'Cloudflare Worker', managed: true, authTypes: ['hmac'], fields: [] })
    h.baseWorker.configEncrypted = JSON.stringify({
      version: 1,
      config: { accountId: 'acc-1', workerName: 'relay-1' },
      credentials: { apiToken: 'tok' },
      runtime: { endpointUrl: 'https://relay-1.sub.workers.dev', protocolVersion: '9drive-relay-v1' },
    })
    h.decryptSpy.mockImplementation((s: string) => s)
    await deleteWorker('user-1', 'worker-1')
    expect(h.fakeDriver.deprovision).toHaveBeenCalledWith({ config: { accountId: 'acc-1', workerName: 'relay-1' } })
    const data = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(data.deletedAt).toBeInstanceOf(Date)
    expect(h.auditSpy).toHaveBeenCalledWith('user-1', 'worker.deprovisioned', 'remote_fetch_worker', 'worker-1', expect.anything())
  })

  it('managed delete with a failing deprovision BLOCKS the soft delete', async () => {
    ;(h.fakeDriver.getMetadata as ReturnType<typeof vi.fn>).mockReturnValue({ key: 'cloudflare', displayName: 'Cloudflare Worker', managed: true, authTypes: ['hmac'], fields: [] })
    h.baseWorker.configEncrypted = JSON.stringify({
      version: 1,
      config: { accountId: 'acc-1', workerName: 'relay-1' },
      credentials: { apiToken: 'tok' },
      runtime: { endpointUrl: 'https://relay-1.sub.workers.dev', protocolVersion: '9drive-relay-v1' },
    })
    h.decryptSpy.mockImplementation((s: string) => s)
    ;(h.fakeDriver.deprovision as ReturnType<typeof vi.fn>).mockRejectedValue(new AppError('WORKER_PROVISION_FAILED', 'nope', 400))
    await expect(deleteWorker('user-1', 'worker-1')).rejects.toMatchObject({ code: 'WORKER_DEPROVISION_FAILED' })
    expect(h.prismaMock.remoteFetchWorker.update).not.toHaveBeenCalled()
  })

  it('setting default unsets the previous default in one transaction', async () => {
    await setDefaultWorker('user-1', 'worker-1')
    expect(h.prismaMock.$transaction).toHaveBeenCalled()
    expect(h.prismaMock.remoteFetchWorker.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, deletedAt: null, id: { not: 'worker-1' } },
      data: { isDefault: false },
    })
  })
})

describe('listWorkers / getWorker', () => {
  beforeEach(resetMocks)

  it('lists only non-deleted workers, ordered by default/priority/name', async () => {
    await listWorkers()
    expect(h.prismaMock.remoteFetchWorker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    )
  })

  it('404s a deleted worker', async () => {
    ;(h.prismaMock.remoteFetchWorker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await expect(getWorker('worker-gone')).rejects.toMatchObject({ code: 'WORKER_NOT_FOUND', status: 404 })
  })
})

describe('testWorkerConnection', () => {
  beforeEach(resetMocks)

  it('decrypts the secret internally, drives the driver, persists healthy state', async () => {
    const result = await testWorkerConnection('user-1', 'worker-1')
    expect(h.decryptSpy).toHaveBeenCalledWith('enc:secret')
    expect(h.fakeDriver.testConnection).toHaveBeenCalledWith({
      endpointUrl: 'https://relay.example.workers.dev',
      authType: 'hmac',
      secret: 'enc:secret',
    })
    expect(result).toMatchObject({ status: 'healthy' })
    const updateData = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(updateData).toMatchObject({ status: 'healthy', lastErrorCode: null, lastFailedAt: null })
    expect(updateData.capabilitiesJson).toMatchObject({ streaming: true })
  })

  it('persists unhealthy + lastErrorCode when the driver throws', async () => {
    ;(h.fakeDriver.testConnection as ReturnType<typeof vi.fn>).mockRejectedValue(new AppError('WORKER_CONNECTION_TIMEOUT', 'The worker did not respond in time.', 400))
    const result = await testWorkerConnection('user-1', 'worker-1')
    expect(result).toMatchObject({ status: 'unhealthy', lastErrorCode: 'WORKER_CONNECTION_TIMEOUT' })
    const updateData = h.prismaMock.remoteFetchWorker.update.mock.calls[0][0].data
    expect(updateData).toMatchObject({ status: 'unhealthy', lastErrorCode: 'WORKER_CONNECTION_TIMEOUT' })
  })

  it('refuses to test a worker with no endpoint (provision_failed)', async () => {
    ;(h.prismaMock.remoteFetchWorker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ ...h.baseWorker, endpointUrl: null })
    await expect(testWorkerConnection('user-1', 'worker-1')).rejects.toMatchObject({ code: 'WORKER_PROVISION_FAILED' })
  })
})

describe('listDriverMetadata', () => {
  it('exposes only safe driver metadata, never secret VALUES', () => {
    const drivers = listDriverMetadata()
    expect(drivers).toHaveLength(1)
    expect(drivers[0].key).toBe('cloudflare')
    expect(drivers[0].displayName).toBe('Cloudflare Worker')
    // Field DECLARATIONS may name a secret field; actual secret values must never
    // appear (the metadata contains labels/help, not stored credentials).
    expect(JSON.stringify(drivers)).not.toContain('top-secret')
    expect(drivers[0].fields.some((f) => f.secret)).toBe(true)
  })
})