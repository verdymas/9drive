import { z } from 'zod'

/**
 * Canonical 9drive-relay-v1 contract — single source of truth for both
 * backend serializer (CloudflareRemoteFetchTransport) and relay parser
 * (cloudflare-relay/worker.mjs). Any drift must be caught by Zod.
 */

export const RELAY_PROTOCOL_VERSION = '9drive-relay-v1' as const
export const RELAY_HEALTH_PATH = '/health' as const
export const RELAY_FETCH_PATH = '/fetch' as const
export const RELAY_SIGNATURE_HEADER = 'x-9drive-signature' as const

export const RelayFetchRequestSchema = z.object({
  protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
  url: z.string().url(),
  method: z.enum(['GET', 'HEAD', 'POST']),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
})

export type RelayFetchRequest = z.infer<typeof RelayFetchRequestSchema>

export const RelayFetchResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  statusText: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  body: z.string(), // base64
  protocolVersion: z.literal('9drive-relay-v1'),
})

export type RelayFetchResponse = z.infer<typeof RelayFetchResponseSchema>

export const RelayHealthResponseSchema = z.object({
  service: z.literal('9drive-relay'),
  protocolVersion: z.literal('9drive-relay-v1'),
  status: z.enum(['ok', 'healthy']),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      rangeRequests: z.boolean().optional(),
      requestContext: z.boolean().optional(),
      hls: z.boolean().optional(),
      maxBodyBytes: z.number().nullable().optional(),
      protocolVersion: z.string().optional(),
    })
    .optional(),
})

/**
 * Safe reason codes for relay payload validation — never contains URL/header/body values.
 * Shared by backend parser and worker.mjs verifier.
 */
export const RELAY_PARSE_REASONS = {
  INVALID_JSON: 'INVALID_JSON',
  MISSING_PROTOCOL: 'MISSING_PROTOCOL',
  INVALID_PROTOCOL: 'INVALID_PROTOCOL',
  MISSING_URL: 'MISSING_URL',
  INVALID_URL: 'INVALID_URL',
  MISSING_METHOD: 'MISSING_METHOD',
  INVALID_METHOD: 'INVALID_METHOD',
  UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD',
  INVALID_HEADERS: 'INVALID_HEADERS',
  INVALID_BODY_TYPE: 'INVALID_BODY_TYPE',
} as const

export type RelayParseReason = (typeof RELAY_PARSE_REASONS)[keyof typeof RELAY_PARSE_REASONS]

/**
 * Serialize a RelayFetchRequest to JSON for the relay.
 * Ensures canonical field names and strips unknown keys. Body is omitted when undefined.
 */
export function serializeRelayRequest(input: RelayFetchRequest): string {
  // Use the schema to validate and strip unknown keys — body undefined is omitted automatically
  const parsed = RelayFetchRequestSchema.parse(input)
  return JSON.stringify(parsed)
}

/**
 * Map a Zod validation failure to a safe reason code.
 */
export function getRelayParseReason(rawJson: unknown, result: ReturnType<typeof RelayFetchRequestSchema.safeParse>): RelayParseReason {
  if (!result.success) {
    const first = result.error.issues[0]
    const path = first?.path?.[0] as string | undefined
    if (path === 'protocolVersion') {
      if ((rawJson as any)?.protocolVersion === undefined) return RELAY_PARSE_REASONS.MISSING_PROTOCOL
      return RELAY_PARSE_REASONS.INVALID_PROTOCOL
    }
    if (path === 'url') {
      if ((rawJson as any)?.url === undefined) return RELAY_PARSE_REASONS.MISSING_URL
      return RELAY_PARSE_REASONS.INVALID_URL
    }
    if (path === 'method') {
      const v = (rawJson as any)?.method
      if (v === undefined) return RELAY_PARSE_REASONS.MISSING_METHOD
      if (!['GET', 'HEAD', 'POST'].includes(v)) return RELAY_PARSE_REASONS.UNSUPPORTED_METHOD
      return RELAY_PARSE_REASONS.INVALID_METHOD
    }
    if (path === 'headers') return RELAY_PARSE_REASONS.INVALID_HEADERS
    if (path === 'body') return RELAY_PARSE_REASONS.INVALID_BODY_TYPE
    return RELAY_PARSE_REASONS.INVALID_BODY_TYPE
  }
  return RELAY_PARSE_REASONS.INVALID_BODY_TYPE
}

/**
 * Parse and validate a raw relay request body.
 * Returns the parsed request or throws with a safe error (including reason).
 */
export function parseRelayRequest(raw: string): RelayFetchRequest {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    const err = new Error('invalid payload') as Error & { reason?: RelayParseReason }
    err.reason = RELAY_PARSE_REASONS.INVALID_JSON
    throw err
  }
  const result = RelayFetchRequestSchema.safeParse(json)
  if (!result.success) {
    const reason = getRelayParseReason(json, result)
    const err = new Error('invalid payload') as Error & { reason?: RelayParseReason; issues?: unknown }
    err.reason = reason
    ;(err as any).issues = result.error.issues
    throw err
  }
  return result.data
}
