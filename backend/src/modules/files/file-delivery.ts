import type { Response } from 'express'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'

export type FileDeliveryDecision = { kind: 'proxy' } | { kind: 'redirect'; url: string }

export type ProxyHeaders = {
  status: number
  contentType?: string | null
  contentLength?: string | number | null
  contentRange?: string | null
  disposition?: 'inline' | 'attachment'
  fileName?: string
}

export type ProxyStream = ProxyHeaders & {
  body: Readable
  abort?: () => void
}

/**
 * Phase 1 deliberately selects the proxy path for every provider. Later
 * phases may return a redirect decision only after authorization has passed.
 */
export function proxyDeliveryDecision(): FileDeliveryDecision {
  return { kind: 'proxy' }
}

function contentDisposition(type: 'inline' | 'attachment', fileName: string) {
  return `${type}; filename="${fileName.replaceAll('"', '')}"`
}

/** Apply the common subset of HTTP metadata all provider proxy paths own. */
export function setProxyHeaders(res: Response, headers: ProxyHeaders) {
  res.status(headers.status)
  res.setHeader('Content-Type', headers.contentType || 'application/octet-stream')
  res.setHeader('Accept-Ranges', 'bytes')
  if (headers.contentLength !== undefined && headers.contentLength !== null) res.setHeader('Content-Length', String(headers.contentLength))
  if (headers.contentRange) res.setHeader('Content-Range', headers.contentRange)
  if (headers.disposition && headers.fileName) res.setHeader('Content-Disposition', contentDisposition(headers.disposition, headers.fileName))
}

/**
 * Send a provider stream with Node backpressure and tear it down when the
 * downstream connection disappears. Once headers are on the wire, a stream
 * error can only terminate the response; a JSON envelope would corrupt bytes.
 */
export async function streamProxyResponse(res: Response, source: ProxyStream): Promise<void> {
  setProxyHeaders(res, source)
  let downstreamClosed = false
  const close = () => {
    if (res.writableEnded) return
    downstreamClosed = true
    source.abort?.()
    source.body.destroy()
  }
  res.once('close', close)
  try {
    await pipeline(source.body, res)
  } catch (error) {
    if (!downstreamClosed && !res.writableEnded) {
      source.abort?.()
      res.destroy(error as Error)
    }
  } finally {
    res.off('close', close)
  }
}

/** Send a stable API envelope only when provider opening failed pre-response. */
export function writeProxyOpenError(res: Response) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.status(502)
  res.setHeader('Content-Type', 'application/json')
  res.json({ code: 'FILE_STREAM_UNAVAILABLE', message: 'The file stream is temporarily unavailable.' })
}
