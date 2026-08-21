import { AppError } from '../../utils/app-error.js'
import type { RemoteFetchTransport, RemoteFetchWorkerAuthType } from './types.js'
import { resolveDriver } from './driver-registry.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from './errors.js'
import { DirectRemoteFetchTransport } from './transports/direct-transport.js'

/**
 * Build the byte transport for a Remote Import (spec §31).
 *
 * - workerId null → DirectRemoteFetchTransport (the plain 9Drive downloader).
 * - workerId set → registry → driver → driver.createTransport().
 *
 * Unsupported driver only when no registered driver exists. Direct is always available.
 */
export function buildTransportForWorker(worker: {
  driver: string
  endpointUrl: string
  authType: RemoteFetchWorkerAuthType
  secretEncrypted: string | null
}, opts: { decryptSecret: (encrypted: string) => string }): RemoteFetchTransport {
  const driver = resolveDriver(worker.driver)
  if (!driver.createTransport) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_TRANSPORT_NOT_IMPLEMENTED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_TRANSPORT_NOT_IMPLEMENTED, 501)
  }
  const secretDecrypted = worker.secretEncrypted ? opts.decryptSecret(worker.secretEncrypted) : null
  return driver.createTransport({
    endpointUrl: worker.endpointUrl,
    authType: worker.authType,
    secretDecrypted,
  })
}

/** Direct transport factory — no worker, no registry, always available. */
export function buildDirectTransport(opts: { requestContext?: import('../remote-imports/request-context.js').RemoteImportRequestContext | null; sourceUrl?: string } = {}): RemoteFetchTransport {
  return new DirectRemoteFetchTransport(opts)
}

/**
 * Resolve transport for an import: workerId null → Direct, else via registry.
 * Generic: no `if (driver === 'cloudflare')` branching.
 */
export function resolveTransportForImport(
  worker: { driver: string; endpointUrl: string; authType: RemoteFetchWorkerAuthType; secretEncrypted: string | null } | null,
  opts: { decryptSecret: (encrypted: string) => string; requestContext?: import('../remote-imports/request-context.js').RemoteImportRequestContext | null; sourceUrl?: string },
): RemoteFetchTransport {
  if (!worker) {
    return buildDirectTransport({ requestContext: opts.requestContext, sourceUrl: opts.sourceUrl })
  }
  return buildTransportForWorker(worker, { decryptSecret: opts.decryptSecret })
}