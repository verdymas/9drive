/**
 * WebDAV-friendly Readable variant of the streaming gateway.
 *
 * Returns BOTH the Node Readable and the upstream's status + headers
 * so the caller (WebDAV routes layer) can apply them to its own
 * response. This matters: the WebDAV layer was previously
 * pre-committing headers from DB metadata (size, content-type, etc.)
 * and then piping the body — but the upstream's actual response may
 * differ (e.g. 416 for an out-of-range request, or a different
 * Content-Length for a server-side clipped range). We must not
 * pre-commit headers we can't honor.
 */
import { Readable } from 'node:stream'

import type { File as FileRecord, ConnectedAccount } from '@prisma/client'

import { env } from '../../config/env.js'
import { parseTelegramRemoteId } from './telegram.service.js'
import { signStreamRequest } from './telegram-stream-auth.js'

type FileWithAccount = FileRecord & { connectedAccount: ConnectedAccount }

export interface TelegramStreamUpstream {
  status: number
  headers: Record<string, string>
  body: Readable
}

export async function fetchTelegramStreamAsReadable(
  file: FileWithAccount,
  range: string | undefined,
): Promise<TelegramStreamUpstream> {
  const parsed = parseTelegramRemoteId(file.providerFileId)
  const channelId = String(parsed.channelId)
  const messageId = String(parsed.messageId)
  const providerId = file.connectedAccountId
  const knownSize = Number(file.sizeBytes ?? 0)

  const path = '/v1/stream'
  const ts = Math.floor(Date.now() / 1000)
  const signature = signStreamRequest({
    timestamp: ts,
    method: 'GET',
    identity: { providerId, channelId, messageId, range: range ?? null },
  })

  const url = new URL(path, env.TELEGRAM_STREAM_NODE_URL)
  url.searchParams.set('providerId', providerId)
  url.searchParams.set('channelId', channelId)
  url.searchParams.set('messageId', messageId)
  url.searchParams.set('knownSize', String(knownSize))

  const upstreamHeaders: Record<string, string> = {
    'X-Stream-Timestamp': String(ts),
    'X-Stream-Signature': signature,
  }
  if (range) upstreamHeaders['Range'] = range

  // Correlation: a short per-request id is forwarded so the streaming
  // service's logs can be cross-referenced with the gateway log line.
  // Never a secret.
  const requestId =
    (file as unknown as { __requestId?: string }).__requestId ?? undefined
  if (requestId) upstreamHeaders['X-Request-Id'] = requestId

  const abort = new AbortController()
  const r = await fetch(url, { method: 'GET', headers: upstreamHeaders, signal: abort.signal })

  // Translate the upstream Headers into a plain dict. Lowercased keys.
  const headers: Record<string, string> = {}
  r.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (
      lower === 'content-range' ||
      lower === 'content-length' ||
      lower === 'accept-ranges'
    ) {
      headers[lower] = value
    }
  })

  if (!r.body) {
    return { status: r.status, headers, body: Readable.from([]) }
  }
  const node = Readable.fromWeb(r.body as never)
  node.on('close', () => abort.abort())
  return { status: r.status, headers, body: node }
}
