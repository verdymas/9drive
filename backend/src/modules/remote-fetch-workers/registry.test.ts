import { beforeAll, describe, expect, it } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import { registerDriver, getDriver, hasDriver, listDrivers, resolveDriver } from './driver-registry.js'
import { buildTransportForWorker } from './transport.js'
import { cloudflareWorkerDriver } from './drivers/cloudflare.js'
import type { RemoteFetchWorkerDriver } from './types.js'

/**
 * A stub driver registered ONLY in tests (spec §50). Proves the registry is
 * not Cloudflare-hard-coded: CRUD/validation/selection run without any
 * `if (driver === 'cloudflare')` branch.
 */
const testRelayDriver: RemoteFetchWorkerDriver = {
  key: 'test-relay',
  displayName: 'Test Relay',
  validateConfig: async ({ endpointUrl }) => {
    if (!endpointUrl?.includes('relay')) throw new AppError('WORKER_ENDPOINT_INVALID', 'invalid', 400)
    return { endpointUrl }
  },
  testConnection: async () => ({ status: 'healthy', protocolVersion: '9drive-relay-v1' }),
  getMetadata: () => ({ key: 'test-relay', displayName: 'Test Relay', managed: false, authTypes: ['none'], fields: [] }),
  createTransport: () => ({ request: async () => ({ status: 200, headers: {}, body: '' }) }),
}

const DEFAULT_KEY = 'cloudflare'

describe('driver registry', () => {
  beforeAll(() => {
    // Register the stub + the real cloudflare driver ONCE. The registry is a
    // module singleton; re-registering is idempotent (key-overwrite).
    registerDriver(testRelayDriver)
    registerDriver(cloudflareWorkerDriver)
  })

  it('registers a driver and resolves it by key', () => {
    registerDriver(testRelayDriver)
    expect(hasDriver('test-relay')).toBe(true)
    expect(getDriver('test-relay')?.displayName).toBe('Test Relay')
    expect(resolveDriver('test-relay')).toBe(testRelayDriver)
  })

  it('throws the stable WORKER_DRIVER_UNSUPPORTED for an unknown key', () => {
    expect(() => resolveDriver('nonexistent')).toThrowError(AppError)
    try {
      resolveDriver('nonexistent')
    } catch (error) {
      expect((error as AppError).code).toBe('WORKER_DRIVER_UNSUPPORTED')
    }
  })

  it('lists all registered drivers', () => {
    registerDriver(testRelayDriver)
    const keys = listDrivers().map((d) => d.key)
    expect(keys).toContain('test-relay')
    expect(keys).toContain('cloudflare')
  })

  it('builds a transport through the driver when createTransport exists', () => {
    registerDriver(testRelayDriver)
    const transport = buildTransportForWorker(
      { driver: 'test-relay', endpointUrl: 'https://relay.example', authType: 'none', secretEncrypted: null },
      { decryptSecret: (s) => s },
    )
    expect(transport).toBeDefined()
    expect(transport.request).toBeInstanceOf(Function)
  })

  it('fails explicitly with WORKER_TRANSPORT_NOT_IMPLEMENTED when the driver has no transport', () => {
    // cloudflare driver (registered in app) has no createTransport this phase.
    expect(() =>
      buildTransportForWorker(
        { driver: DEFAULT_KEY, endpointUrl: 'https://relay.example', authType: 'hmac', secretEncrypted: null },
        { decryptSecret: (s) => s },
      ),
    ).toThrowError(AppError)
    try {
      buildTransportForWorker(
        { driver: DEFAULT_KEY, endpointUrl: 'https://relay.example', authType: 'hmac', secretEncrypted: null },
        { decryptSecret: (s) => s },
      )
    } catch (error) {
      expect((error as AppError).code).toBe('WORKER_TRANSPORT_NOT_IMPLEMENTED')
    }
  })
})