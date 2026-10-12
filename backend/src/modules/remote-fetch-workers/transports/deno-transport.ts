import type { RemoteFetchRequest, RemoteFetchResponse, RemoteFetchTransport } from '../types.js'
import type { RemoteImportRequestContext } from '../../remote-imports/request-context.js'
import { CloudflareRemoteFetchTransport } from './cloudflare-transport.js'

/**
 * Deno relay transport: identical `9drive-relay-v1` wire as Cloudflare
 * (streaming, Range, HMAC, status/error semantics, no Direct fallback).
 * Only the driver label differs so logs/usage attribute to `deno`.
 */
export class DenoRemoteFetchTransport implements RemoteFetchTransport {
  private inner: CloudflareRemoteFetchTransport

  constructor(opts: { endpointUrl: string; secret: string; workerId?: string; sourceUrl?: string; requestContext?: RemoteImportRequestContext | null }) {
    this.inner = new CloudflareRemoteFetchTransport({
      endpointUrl: opts.endpointUrl,
      secret: opts.secret,
      workerId: opts.workerId,
      driver: 'deno',
      sourceUrl: opts.sourceUrl,
      requestContext: opts.requestContext as never,
    })
  }

  request(input: RemoteFetchRequest): Promise<RemoteFetchResponse> {
    return this.inner.request(input)
  }
}
