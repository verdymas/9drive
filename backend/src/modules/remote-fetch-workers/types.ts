/**
 * Remote Fetch Worker domain types (spec §7, §31).
 *
 * A Remote Fetch Worker is a REMOTE NETWORK RELAY used by 9Drive to fetch
 * remote resources — it is NOT the internal BullMQ job worker that processes
 * Remote Imports. It only transports bytes; FFmpeg, HLS parsing, orchestration,
 * temp files, retry, progress and the final Google Drive/S3 upload all stay
 * inside 9Drive.
 */

/** Auth strategy for a worker's connection to its relay endpoint. */
export type RemoteFetchWorkerAuthType = 'hmac' | 'bearer' | 'none'

/** Health status of a registered worker. */
export type RemoteFetchWorkerStatus =
  | 'unknown'
  | 'healthy'
  | 'unhealthy'
  | 'disabled'
  | 'provisioning'
  | 'provision_failed'

/** Safe capabilities reported by a worker's /health endpoint. */
export type RemoteFetchWorkerCapabilities = {
  streaming?: boolean
  rangeRequests?: boolean
  requestContext?: boolean
  hls?: boolean
  maxBodyBytes?: number | null
  protocolVersion?: string
  [key: string]: unknown
}

/** A relay fetch request (reserved for the next phase's transport). */
export type RemoteFetchRequest = {
  method: 'GET' | 'HEAD' | 'POST'
  url: string
  headers?: Record<string, string>
  range?: string
  body?: string
  requestContext?: Record<string, string>
  maxBytes?: number
  timeoutMs?: number
}

/** A relay fetch response (reserved for the next phase's transport). */
export type RemoteFetchResponse = {
  status: number
  statusText?: string
  headers: Record<string, string>
  body: AsyncIterable<Uint8Array> | string
}

/**
 * Transport abstraction (spec §31): how a Remote Import actually gets its
 * remote bytes. Direct mode and each worker driver provide one.
 */
export interface RemoteFetchTransport {
  request(input: RemoteFetchRequest): Promise<RemoteFetchResponse>
}

/** Result of a driver's testConnection(). */
export type WorkerHealthProbe = {
  status: 'healthy' | 'unhealthy'
  protocolVersion?: string
  capabilities?: RemoteFetchWorkerCapabilities
}

/** Driver-provided field schema metadata for the UI form (spec §44). */
export type WorkerDriverField = {
  key: string
  label: string
  type: 'text' | 'password' | 'select' | 'number'
  secret?: boolean
  required?: boolean
  options?: string[]
  help?: string
  /** For managed drivers: the worker record's display name derives from this field's value. */
  autoFillNameFrom?: string
}

/** Safe driver metadata exposed to the frontend (spec §44). Never secrets. */
export type WorkerDriverMetadata = {
  key: string
  displayName: string
  /** true = 9Drive provisions/manages the remote deployment (driver has lifecycle methods). */
  managed: boolean
  authTypes: RemoteFetchWorkerAuthType[]
  fields: WorkerDriverField[]
}

/** Registration credentials/options for a managed (provisioned) driver. */
export type WorkerProvisionInput = {
  /** Driver-specific registration fields, e.g. { accountId, apiToken, workerName }. */
  config: Record<string, string>
  /** Generated relay secret — deployed as a binding, never user-supplied. */
  secret: string
}

/** Result of a successful provision — the service persists these. */
export type WorkerProvisionResult = {
  endpointUrl: string
  protocolVersion?: string
  /** Encrypted-JSON payload the service stores as configEncrypted (never raw request fields). */
  configEncryptedInput?: unknown
}

/** Input for a managed update (edit). */
export type WorkerUpdateInput = {
  /** New registration fields; blank apiToken = keep the stored token. */
  config: Record<string, string>
  /** Existing stored registration fields (for diffing). */
  storedConfig: Record<string, string>
  /** The relay secret currently bound to the deployed script. */
  secret: string
}

/** Result of a managed update. */
export type WorkerUpdateResult = {
  endpointUrl?: string
  configEncryptedInput?: unknown
}

/** Input for deprovisioning (delete / cleanup after failed provision). */
export type WorkerDeprovisionInput = {
  config: Record<string, string>
}

/** A worker driver implementation (spec §7). */
export interface RemoteFetchWorkerDriver {
  key: string
  displayName: string

  /**
   * Validate + normalize driver-specific config. Throws AppError on failure.
   * For managed drivers `config` is the registration payload and `endpointUrl`
   * is rejected (the endpoint is system-discovered after provisioning).
   * May return `configEncryptedInput` — the safe payload the service persists
   * as configEncrypted (encrypted at rest, never returned by any API).
   */
  validateConfig(config: {
    endpointUrl?: string | null
    authType?: RemoteFetchWorkerAuthType
    secret?: string | null
    config?: Record<string, string> | null
  }): Promise<{ endpointUrl?: string | null; configEncryptedInput?: unknown }>

  /** Test connectivity + protocol identity against the relay endpoint. */
  testConnection(input: { endpointUrl: string; authType: RemoteFetchWorkerAuthType; secret?: string | null }): Promise<WorkerHealthProbe>

  /** Safe capabilities metadata for the UI form. */
  getMetadata(): WorkerDriverMetadata

  /**
   * Provision the remote relay (managed drivers). 9Drive deploys the relay
   * code, configures the generated secret binding, discovers the endpoint and
   * returns it. Throws AppError with a safe code on failure.
   */
  provision?(input: WorkerProvisionInput): Promise<WorkerProvisionResult>

  /** Update the remote relay after an edit (managed drivers). */
  update?(input: WorkerUpdateInput): Promise<WorkerUpdateResult>

  /** Remove the remote relay deployment (managed drivers). Idempotent. */
  deprovision?(input: WorkerDeprovisionInput): Promise<void>

  /**
   * Create the byte transport for this driver. Not implemented this phase —
   * present so the execution-time guard can detect its absence and fail
   * explicitly instead of silently fetching Direct.
   */
  createTransport?(worker: {
    endpointUrl: string
    authType: RemoteFetchWorkerAuthType
    secretDecrypted?: string | null
  }): RemoteFetchTransport
}