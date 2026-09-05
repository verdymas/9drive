/**
 * HMAC-SHA256 signing for backend -> telegram-stream requests.
 *
 * Wire shape (must match the Python service in
 * services/telegram-stream/app/security/internal_auth.py):
 *
 *   X-Stream-Timestamp: <unix-seconds>
 *   X-Stream-Signature: <hex-hmac-sha256>
 *
 * Canonical string (newline-joined, ASCII):
 *   <timestamp>\n<method>\n<path>\n<providerId>\n<channelId>\n<messageId>\n<Range-or-empty>
 *
 * The Range header is in the canonical string on purpose: a MITM (or a buggy
 * caller) must not be able to swap the requested range after the request was
 * signed. Constant-time compare via crypto.timingSafeEqual.
 */
import crypto from 'node:crypto'

import { env } from '../../config/env.js'

const CANONICAL_PATH_DEFAULT = '/v1/stream'

export interface StreamRequestIdentity {
  providerId: string
  channelId: string
  messageId: string | number
  range?: string | null
}

export function canonicalString(input: {
  timestamp: number
  method: string
  path?: string
  identity: StreamRequestIdentity
}): string {
  const parts = [
    String(input.timestamp),
    input.method.toUpperCase(),
    input.path ?? CANONICAL_PATH_DEFAULT,
    String(input.identity.providerId),
    String(input.identity.channelId),
    String(input.identity.messageId),
    input.identity.range ?? '',
  ]
  return parts.join('\n')
}

export function signStreamRequest(input: {
  timestamp: number
  method: string
  identity: StreamRequestIdentity
  path?: string
  secret?: string
}): string {
  const secret = input.secret ?? env.TELEGRAM_STREAM_INTERNAL_SECRET
  if (!secret) {
    throw new Error('TELEGRAM_STREAM_INTERNAL_SECRET is not configured')
  }
  const canonical = canonicalString({
    timestamp: input.timestamp,
    method: input.method,
    path: input.path,
    identity: input.identity,
  })
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex')
}

export function isTelegramStreamConfigured(): boolean {
  return Boolean(env.TELEGRAM_STREAM_NODE_URL) && Boolean(env.TELEGRAM_STREAM_INTERNAL_SECRET)
}
