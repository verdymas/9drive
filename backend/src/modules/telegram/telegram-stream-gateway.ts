/**
 * Backend -> telegram-stream gateway.
 *
 * One class. No abstract factory. The whole point of this module is to
 * keep the WebDAV / REST streaming code from knowing about HMAC, Abort
 * plumbing, or how to forward a Range header.
 *
 * The header split (audit doc §9) is:
 *   - telegram-stream owns: status, Content-Range, range Content-Length, Accept-Ranges
 *   - 9Drive owns: Content-Type, Content-Disposition, ETag, Last-Modified
 *
 * That split is what lets the streaming service stay generic and keeps
 * the WebDAV semantics in one place.
 */
import { Readable } from 'node:stream'

import { env } from '../../config/env.js'
import type { Response } from 'express'

import { signStreamRequest, isTelegramStreamConfigured } from './telegram-stream-auth.js'
import { parseTelegramRemoteId } from './telegram.service.js'

export interface TelegramStreamGatewayFile {
  providerFileId: string
  connectedAccountId: string
  mimeType?: string | null
  name?: string | null
  sizeBytes?: bigint | number | null
  etag?: string | null
  lastModified?: Date | null
}

export interface StreamOptions {
  disposition?: string
  range?: string | null
}

interface UpstreamResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

export class TelegramStreamGateway {
  async streamFile(
    file: TelegramStreamGatewayFile,
    range: string | undefined,
    res: Response,
    options: StreamOptions = {},
  ): Promise<void> {
    if (!isTelegramStreamConfigured()) {
      // No streaming service configured — surface a clear 503 so the
      // caller can decide whether to fall back to a full GET.
      res.status(503)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({ code: 'STREAM_NOT_CONFIGURED', message: 'telegram-stream is not configured.' }),
      )
      return
    }

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

    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })

    let upstream: UpstreamResponse
    try {
      const r = await fetch(url, { method: 'GET', headers: upstreamHeaders, signal: abort.signal })
      upstream = { status: r.status, headers: r.headers, body: r.body }
    } catch (err) {
      // Network/abort. Don't double-write if the response is already gone.
      if (!res.headersSent) {
        res.status(502)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE', message: 'telegram-stream unreachable.' }))
      }
      return
    }

    res.status(upstream.status)
    // Byte-range mechanics come from upstream; logical metadata from here.
    for (const h of ['content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h)
      if (v) res.setHeader(h, v)
    }
    // Range Content-Length only when the upstream returned 206; full
    // 200 responses set their own Content-Length below.
    if (upstream.status === 206) {
      const cl = upstream.headers.get('content-length')
      if (cl) res.setHeader('Content-Length', cl)
    } else if (upstream.status === 200) {
      const cl = upstream.headers.get('content-length')
      if (cl) res.setHeader('Content-Length', cl)
    }
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
    if (options.disposition && file.name) {
      const safeName = file.name.replaceAll('"', '')
      res.setHeader('Content-Disposition', `${options.disposition}; filename="${safeName}"`)
    }
    if (file.etag) res.setHeader('ETag', file.etag)
    if (file.lastModified) res.setHeader('Last-Modified', file.lastModified.toUTCString())

    if (!upstream.body) {
      res.end()
      return
    }

    // Pipe with no buffering. Node 20+ exposes Readable.fromWeb.
    const node = Readable.fromWeb(upstream.body as never)
    node.on('error', () => {
      abort.abort()
      if (!res.writableEnded) res.destroy()
    })
    node.pipe(res)
  }
}

export const telegramStreamGateway = new TelegramStreamGateway()
