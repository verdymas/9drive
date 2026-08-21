/**
 * Stable error codes for the Remote Fetch Worker registry (spec §28, §42).
 *
 * Like HLS_ERROR_CODES, every code maps to a user-facing message that never
 * contains internal IPs, local paths, stack traces, signed URLs, or secrets.
 * The codes are stable strings — the frontend keys UI behavior off the code,
 * not the message.
 */
export const REMOTE_FETCH_WORKER_ERROR_CODES = {
  // Worker CRUD / validation
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
  WORKER_DRIVER_UNSUPPORTED: 'WORKER_DRIVER_UNSUPPORTED',
  WORKER_DRIVER_CONFIG_INVALID: 'WORKER_DRIVER_CONFIG_INVALID',
  WORKER_ENDPOINT_INVALID: 'WORKER_ENDPOINT_INVALID',
  WORKER_DISABLED: 'WORKER_DISABLED',
  // Test-connection failures (safe codes, never raw error bodies)
  WORKER_CONNECTION_TIMEOUT: 'WORKER_CONNECTION_TIMEOUT',
  WORKER_CONNECTION_REFUSED: 'WORKER_CONNECTION_REFUSED',
  WORKER_TLS_ERROR: 'WORKER_TLS_ERROR',
  WORKER_AUTH_FAILED: 'WORKER_AUTH_FAILED',
  WORKER_PROTOCOL_INVALID: 'WORKER_PROTOCOL_INVALID',
  WORKER_PROTOCOL_UNSUPPORTED: 'WORKER_PROTOCOL_UNSUPPORTED',
  WORKER_UNHEALTHY: 'WORKER_UNHEALTHY',
  // Provisioning / managed-deployment failures (safe codes, never raw provider API bodies)
  WORKER_CREDENTIAL_INVALID: 'WORKER_CREDENTIAL_INVALID',
  WORKER_PROVISION_FAILED: 'WORKER_PROVISION_FAILED',
  WORKER_PROVISION_CONFLICT: 'WORKER_PROVISION_CONFLICT',
  WORKER_DEPROVISION_FAILED: 'WORKER_DEPROVISION_FAILED',
  // Local relay build/preflight failure — the artifact is invalid, so no
  // provider request is made (the provider would only reject it).
  WORKER_RELAY_BUILD_FAILED: 'WORKER_RELAY_BUILD_FAILED',
  // Endpoint discovery / workers.dev subdomain lifecycle (Cloudflare managed)
  WORKER_SUBDOMAIN_STATE_FAILED: 'WORKER_SUBDOMAIN_STATE_FAILED',
  WORKER_SUBDOMAIN_ENABLE_FAILED: 'WORKER_SUBDOMAIN_ENABLE_FAILED',
  WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND: 'WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND',
  WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED: 'WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED',
  WORKER_ENDPOINT_BUILD_FAILED: 'WORKER_ENDPOINT_BUILD_FAILED',
  WORKER_HEALTH_CHECK_FAILED: 'WORKER_HEALTH_CHECK_FAILED',
  WORKER_RELAY_PROTOCOL_ERROR: 'WORKER_RELAY_PROTOCOL_ERROR',
  // Remote Import selection / execution
  REMOTE_IMPORT_WORKER_INVALID: 'REMOTE_IMPORT_WORKER_INVALID',
  REMOTE_IMPORT_WORKER_DISABLED: 'REMOTE_IMPORT_WORKER_DISABLED',
  REMOTE_IMPORT_WORKER_DRIVER_UNSUPPORTED: 'REMOTE_IMPORT_WORKER_DRIVER_UNSUPPORTED',
  REMOTE_IMPORT_WORKER_UNAVAILABLE: 'REMOTE_IMPORT_WORKER_UNAVAILABLE',
  // This phase: no relay transport is implemented yet — a selected worker
  // fails the job explicitly rather than silently falling back to Direct.
  WORKER_TRANSPORT_NOT_IMPLEMENTED: 'WORKER_TRANSPORT_NOT_IMPLEMENTED',
} as const

export type RemoteFetchWorkerErrorCode = (typeof REMOTE_FETCH_WORKER_ERROR_CODES)[keyof typeof REMOTE_FETCH_WORKER_ERROR_CODES]

/** Human-readable (safe) messages for the stable codes. */
export const REMOTE_FETCH_WORKER_ERROR_MESSAGES: Record<RemoteFetchWorkerErrorCode, string> = {
  WORKER_NOT_FOUND: 'The worker does not exist.',
  WORKER_DRIVER_UNSUPPORTED: 'The worker uses a service that is not supported.',
  WORKER_DRIVER_CONFIG_INVALID: 'The worker configuration is invalid.',
  WORKER_ENDPOINT_INVALID: 'The worker endpoint URL is invalid.',
  WORKER_DISABLED: 'The worker is disabled.',
  WORKER_CONNECTION_TIMEOUT: 'The worker did not respond in time.',
  WORKER_CONNECTION_REFUSED: 'The worker refused the connection.',
  WORKER_TLS_ERROR: 'The worker could not be reached securely.',
  WORKER_AUTH_FAILED: 'The worker rejected the authentication.',
  WORKER_PROTOCOL_INVALID: 'The endpoint is reachable but is not a valid 9Drive worker relay.',
  WORKER_PROTOCOL_UNSUPPORTED: 'The worker is reachable but uses an unsupported relay protocol.',
  WORKER_UNHEALTHY: 'The worker did not report a healthy status.',
  WORKER_CREDENTIAL_INVALID: 'The provider credentials are invalid or lack the required permissions.',
  WORKER_PROVISION_FAILED: 'The relay could not be provisioned by the provider.',
  WORKER_PROVISION_CONFLICT: 'A relay with this name already exists at the provider. Choose a different name.',
  WORKER_DEPROVISION_FAILED: 'The remote relay could not be removed. The worker was not deleted — retry or clean it up at the provider.',
  WORKER_RELAY_BUILD_FAILED: 'The relay could not be built locally. No changes were made at the provider.',
  WORKER_SUBDOMAIN_STATE_FAILED: 'The workers.dev subdomain state could not be determined.',
  WORKER_SUBDOMAIN_ENABLE_FAILED: 'The workers.dev route could not be enabled for the deployed script.',
  WORKER_ACCOUNT_SUBDOMAIN_NOT_FOUND: 'No workers.dev subdomain is configured for this account.',
  WORKER_ACCOUNT_SUBDOMAIN_CREATE_FAILED: 'The workers.dev subdomain could not be created for this account.',
  WORKER_ENDPOINT_BUILD_FAILED: 'The relay endpoint could not be constructed.',
  WORKER_HEALTH_CHECK_FAILED: 'The relay endpoint did not respond as a healthy 9Drive relay.',
  WORKER_RELAY_PROTOCOL_ERROR: 'The relay received an invalid request.',
  REMOTE_IMPORT_WORKER_INVALID: 'The selected network worker does not exist.',
  REMOTE_IMPORT_WORKER_DISABLED: 'The selected network worker is disabled.',
  REMOTE_IMPORT_WORKER_DRIVER_UNSUPPORTED: 'The selected network worker uses an unsupported service.',
  REMOTE_IMPORT_WORKER_UNAVAILABLE: 'The selected network worker is no longer available. Choose another worker or Direct and retry.',
  WORKER_TRANSPORT_NOT_IMPLEMENTED: 'Relay transport for this worker is not implemented yet. Switch this import to Direct or choose a different worker.',
}