import { describe, expect, it, vi, afterEach } from 'vitest'
import { AppError } from '../../../utils/app-error.js'
import { vpsWorkerDriver, signVpsHealthRequest, validateVpsHealthPayload } from './vps.js'
import { VPS_CAPABILITIES, PROVIDER_SAFETY_BUDGETS } from '../provider-capabilities.js'
import { buildTransportForWorker } from '../transport.js'
import { registerDriver } from '../driver-registry.js'
import { VpsRemoteFetchTransport } from '../transports/vps-transport.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('vps driver metadata', () => {
  it('exposes exact display name Virtual Private Server with hmac-only manual config', () => {
    const meta = vpsWorkerDriver.getMetadata()
    expect(meta.key).toBe('vps')
    expect(meta.displayName).toBe('Virtual Private Server')
    expect(meta.managed).toBe(false)
    expect(meta.authTypes).toEqual(['hmac'])
    expect(meta.fields).toEqual([])
  })

  it('declares local safety budgets (no provider free-tier)', () => {
    expect(vpsWorkerDriver.getCapabilities?.()).toMatchObject({ providerType: 'vps', streaming: true, rangeRequests: true, selectable: true })
    expect(VPS_CAPABILITIES.freeTier.requestsPerMonth).toBeNull()
    expect(VPS_CAPABILITIES.freeTier.egressBytesPerMonth).toBeNull()
    expect(VPS_CAPABILITIES.freeTier.note).toMatch(/no provider free-tier/i)
    expect(PROVIDER_SAFETY_BUDGETS.vps).toEqual({ maxRequestsPerMonth: null, maxEgressBytesPerMonth: null })
  })
})

describe('vps validateConfig', () => {
  it('accepts https endpoint + hmac secret and preserves sub-paths', async () => {
    const out = await vpsWorkerDriver.validateConfig({ endpointUrl: 'https://relay.example.com/vps/', authType: 'hmac', secret: 's3cret' })
    expect(out.endpointUrl).toBe('https://relay.example.com/vps')
    expect(out.configEncryptedInput).toEqual({ manual: true, provider: 'vps' })
  })

  it('rejects non-hmac auth', async () => {
    await expect(vpsWorkerDriver.validateConfig({ endpointUrl: 'https://relay.example.com', authType: 'bearer', secret: 'x' })).rejects.toMatchObject({
      code: 'WORKER_DRIVER_CONFIG_INVALID',
    })
    await expect(vpsWorkerDriver.validateConfig({ endpointUrl: 'https://relay.example.com', authType: 'none', secret: null })).rejects.toMatchObject({
      code: 'WORKER_DRIVER_CONFIG_INVALID',
    })
  })

  it('rejects missing secret and invalid endpoints', async () => {
    await expect(vpsWorkerDriver.validateConfig({ endpointUrl: 'https://relay.example.com', authType: 'hmac', secret: null })).rejects.toMatchObject({
      code: 'WORKER_DRIVER_CONFIG_INVALID',
    })
    await expect(vpsWorkerDriver.validateConfig({ endpointUrl: 'http://relay.example.com', authType: 'hmac', secret: 'x' })).rejects.toMatchObject({
      code: 'WORKER_ENDPOINT_INVALID',
    })
    await expect(vpsWorkerDriver.validateConfig({ endpointUrl: 'https://user:pass@relay.example.com', authType: 'hmac', secret: 'x' })).rejects.toMatchObject({
      code: 'WORKER_ENDPOINT_INVALID',
    })
  })
})

describe('vps health + transport', () => {
  it('signs health requests deterministically', () => {
    const sig = signVpsHealthRequest('secret', 'GET', '/health')
    expect(sig).toMatch(/^[a-f0-9]{64}$/)
    expect(sig).toBe(signVpsHealthRequest('secret', 'GET', '/health'))
    expect(sig).not.toBe(signVpsHealthRequest('other', 'GET', '/health'))
  })

  it('validates relay health identity', () => {
    expect(validateVpsHealthPayload({ service: '9drive-relay', protocolVersion: '9drive-relay-v1', status: 'ok' })).toMatchObject({ status: 'healthy' })
    expect(() => validateVpsHealthPayload({ service: 'other', status: 'ok' })).toThrowError(AppError)
  })

  it('testConnection sends HMAC and parses healthy payload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ service: '9drive-relay', protocolVersion: '9drive-relay-v1', status: 'ok', capabilities: { streaming: true } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const probe = await vpsWorkerDriver.testConnection({ endpointUrl: 'https://relay.example.com', authType: 'hmac', secret: 's3cret' })
    expect(probe.status).toBe('healthy')
    const [, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect((opts.headers as Record<string, string>)['x-9drive-signature']).toMatch(/^[a-f0-9]{64}$/)
  })

  it('testConnection maps 401 to auth failure and rejects non-hmac', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(vpsWorkerDriver.testConnection({ endpointUrl: 'https://relay.example.com', authType: 'hmac', secret: 'x' })).rejects.toMatchObject({ code: 'WORKER_AUTH_FAILED' })
    await expect(vpsWorkerDriver.testConnection({ endpointUrl: 'https://relay.example.com', authType: 'bearer', secret: 'x' })).rejects.toMatchObject({
      code: 'WORKER_DRIVER_CONFIG_INVALID',
    })
  })

  it('builds a vps transport through the generic registry (no Direct fallback)', () => {
    registerDriver(vpsWorkerDriver)
    const transport = buildTransportForWorker(
      { driver: 'vps', endpointUrl: 'https://relay.example.com', authType: 'hmac', secretEncrypted: 'enc' },
      { decryptSecret: () => 'decrypted' },
    )
    expect(transport).toBeInstanceOf(VpsRemoteFetchTransport)
    expect(transport.request).toBeInstanceOf(Function)
  })

  it('requires a secret for transport', () => {
    registerDriver(vpsWorkerDriver)
    expect(() =>
      buildTransportForWorker({ driver: 'vps', endpointUrl: 'https://relay.example.com', authType: 'hmac', secretEncrypted: null }, { decryptSecret: (s) => s }),
    ).toThrowError(AppError)
  })
})
