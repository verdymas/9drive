import { AppError } from '../../utils/app-error.js'
import type { RemoteFetchTransport, RemoteFetchWorkerAuthType } from './types.js'
import { resolveDriver } from './driver-registry.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from './errors.js'

/**
 * Build the byte transport for a Remote Import (spec §31).
 *
 * - workerId null → DirectRemoteFetchTransport (the plain 9Drive downloader).
 * - workerId set → registry → driver → driver.createTransport().
 *
 * THIS PHASE: no driver implements createTransport yet, so a selected worker
 * fails the job explicitly with WORKER_TRANSPORT_NOT_IMPLEMENTED — never a
 * silent fallback to Direct (spec §30).
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