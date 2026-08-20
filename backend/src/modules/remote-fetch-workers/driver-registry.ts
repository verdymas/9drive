import { AppError } from '../../utils/app-error.js'
import type { RemoteFetchWorkerDriver } from './types.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from './errors.js'

/**
 * Registry of installed Remote Fetch Worker drivers (spec §7).
 *
 * Drivers are keyed by a stable string (`cloudflare`, future: `vercel`,
 * `generic-http-relay`, `self-hosted`, ...). The database stores only the key;
 * every provider-specific behavior lives behind the driver interface so the
 * Worker table, CRUD API and Workers menu never need provider branches.
 */
const drivers = new Map<string, RemoteFetchWorkerDriver>()

export function registerDriver(driver: RemoteFetchWorkerDriver) {
  drivers.set(driver.key, driver)
}

export function getDriver(key: string): RemoteFetchWorkerDriver | undefined {
  return drivers.get(key)
}

export function hasDriver(key: string): boolean {
  return drivers.has(key)
}

export function listDrivers(): RemoteFetchWorkerDriver[] {
  return [...drivers.values()]
}

/** Resolve a worker's driver or throw the stable unsupported-driver error. */
export function resolveDriver(driverKey: string): RemoteFetchWorkerDriver {
  const driver = getDriver(driverKey)
  if (!driver) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_UNSUPPORTED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DRIVER_UNSUPPORTED, 400)
  }
  return driver
}