/**
 * WebDAV-friendly Readable variant of the streaming gateway.
 *
 * WebDAV hands the stream back to the webdav-server lib which writes
 * headers itself and only needs a Node Readable. We reuse the same
 * signed-request + abort plumbing as `telegramStreamGateway.streamFile`
 * but skip the header-mutation pass (the WebDAV layer owns the
 * response).
 */
import { Readable } from 'node:stream'

import type { File as FileRecord, ConnectedAccount } from '@prisma/client'

import { env } from '../../config/env.js'
import { parseTelegramRemoteId } from './telegram.service.js'
import { signStreamRequest } from './telegram-stream-auth.js'

type FileWithAccount = FileRecord & { connectedAccount: ConnectedAccount }

export async function fetchTelegramStreamAsReadable(
  file: FileWithAccount,
  range: string | undefined,
): Promise<Readable> {
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

  const headers: Record<string, string> = {
    'X-Stream-Timestamp': String(ts),
    'X-Stream-Signature': signature,
  }
  if (range) headers['Range'] = range

  // Correlation: a short per-request id is forwarded so the streaming
  // service's logs can be cross-referenced with the gateway log line.
  // Never a secret.
  const requestId =
    (file as unknown as { __requestId?: string }).__requestId ?? undefined
  if (requestId) headers['X-Request-Id'] = requestId

  const abort = new AbortController()
  const r = await fetch(url, { method: 'GET', headers, signal: abort.signal })
  if (!r.body) {
    return Readable.from([])
  }
  // When the WebDAV request closes, the returned Readable's `close` fires;
  // bridge that to the AbortController so telegram-stream stops fetching.
  const node = Readable.fromWeb(r.body as never)
  node.on('close', () => abort.abort())
  return node
}
