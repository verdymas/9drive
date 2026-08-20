import { listDrivers } from './driver-registry.js'
import type { WorkerDriverMetadata } from './types.js'

/**
 * Safe driver metadata for the frontend Service selector (spec §44).
 * Exposes only keys/names/field shapes — never secrets or defaults.
 */
export function listDriverMetadata(): WorkerDriverMetadata[] {
  return listDrivers().map((driver) => driver.getMetadata())
}