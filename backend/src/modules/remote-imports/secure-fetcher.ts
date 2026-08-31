import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText } from '../../utils/crypto.js'
import { hasDriver, resolveDriver } from '../remote-fetch-workers/driver-registry.js'
import { buildDirectTransport, buildTransportForWorker } from '../remote-fetch-workers/transport.js'
import type { RemoteFetchTransport, RemoteFetchRequest, RemoteFetchResponse } from '../remote-fetch-workers/types.js'
import type { RemoteImportRequestContext } from './request-context.js'

/**
 * SecureRemoteFetcher: generic abstraction over Direct vs relay transports.
 * All Remote Import network traffic goes through this — never raw `fetch` or `followRemoteUrl`.
 * Diagnostics are safe: never logs signed URLs, cookies, tokens, secrets.
 */
export class SecureRemoteFetcher {
  constructor(
    private transport: RemoteFetchTransport,
    private diagnostics: { route: 'direct' | 'worker'; workerId?: string | null; driver?: string | null; relayHost?: string | null },
  ) {}

  /** Safe route diagnostics for probe-level logging (never secrets/URLs). */
  routeInfo(): { route: 'direct' | 'worker'; workerId?: string | null; driver?: string | null; relayHost?: string | null } {
    return this.diagnostics
  }

  async fetch(input: RemoteFetchRequest): Promise<RemoteFetchResponse & { finalUrl?: string; redirectCount?: number }> {
    const targetHost = (() => {
      try {
        return new URL(input.url).hostname
      } catch {
        return ''
      }
    })()
    if (this.diagnostics.route === 'direct') {
      console.log(`[remote-import:fetcher] route=direct targetHost=${targetHost} method=${input.method ?? 'GET'}`)
    } else {
      console.log(
        `[remote-import:fetcher] route=worker workerId=${this.diagnostics.workerId ?? ''} driver=${this.diagnostics.driver ?? ''} relayHost=${this.diagnostics.relayHost ?? ''} targetHost=${targetHost} method=${input.method ?? 'GET'}`,
      )
    }
    const res = await this.transport.request(input)
    // Log safe outcome
    console.log(`[remote-import:fetcher] response route=${this.diagnostics.route} targetHost=${targetHost} status=${res.status}`)
    return res as RemoteFetchResponse & { finalUrl?: string; redirectCount?: number }
  }

  /** Convenience for HEAD probe */
  async head(url: string, opts: { headers?: Record<string, string>; requestContext?: RemoteImportRequestContext | null; sourceUrl?: string } = {}): Promise<RemoteFetchResponse & { finalUrl?: string }> {
    return this.fetch({ method: 'HEAD', url, headers: opts.headers, requestContext: opts.requestContext as any, maxBytes: 0 } as any)
  }

  /** Convenience for ranged GET (bytes=0-0) */
  async rangedGet(url: string, opts: { headers?: Record<string, string>; requestContext?: RemoteImportRequestContext | null; sourceUrl?: string } = {}): Promise<RemoteFetchResponse & { finalUrl?: string }> {
    return this.fetch({ method: 'GET', url, headers: opts.headers, range: 'bytes=0-0', requestContext: opts.requestContext as any } as any)
  }

  /** Bounded GET for manifests (string body) */
  async boundedGet(url: string, opts: { headers?: Record<string, string>; maxBytes?: number; signal?: AbortSignal; requestContext?: RemoteImportRequestContext | null; sourceUrl?: string } = {}): Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl: string }> {
    const res = await this.fetch({ method: 'GET', url, headers: opts.headers, maxBytes: opts.maxBytes, requestContext: opts.requestContext as any, timeoutMs: opts.signal ? 10000 : undefined } as any)
    // Collect body as string (manifests are small)
    let body = ''
    if (typeof res.body === 'string') {
      body = res.body
    } else {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        body += Buffer.from(chunk).toString('utf8')
        if (opts.maxBytes && Buffer.byteLength(body, 'utf8') > opts.maxBytes) {
          throw new AppError('HLS_MANIFEST_TOO_LARGE', 'The HLS manifest exceeds the maximum allowed size.', 413)
        }
        if (opts.signal?.aborted) {
          const err = new AppError('ABORTED', 'The import was cancelled.', 499)
          err.name = 'AbortError'
          throw err
        }
      }
    }
    return { status: res.status, headers: res.headers, body, finalUrl: (res as any).finalUrl ?? url }
  }

  /** Download a resource to a local file via transport */
  async downloadToFile(url: string, targetPath: string, opts: { maxBytes?: bigint; signal?: AbortSignal; requestContext?: RemoteImportRequestContext | null; sourceUrl?: string; kind?: string } = {}): Promise<bigint> {
    const res = await this.fetch({ method: 'GET', url, requestContext: opts.requestContext as any } as any)
    if (res.status === 401 || res.status === 403) {
      if (opts.requestContext) {
        throw new AppError('REMOTE_SOURCE_ACCESS_EXPIRED', 'The source access has expired. Please capture a fresh request.', res.status)
      }
      throw new AppError('HLS_AUTHENTICATED_SOURCE_UNSUPPORTED', 'Authenticated sources require a request context.', 400)
    }
    if (res.status >= 400) {
      throw new AppError('DOWNLOAD_HTTP_ERROR', `Remote server responded ${res.status}.`, 502)
    }
    // Stream to file — handle both string and iterable bodies
    const fsp = await import('node:fs/promises')
    const handle = await fsp.open(targetPath, 'w')
    let written = 0n
    const maxBytes = opts.maxBytes ?? BigInt(5 * 1024 * 1024 * 1024)
    // Truncation guard: only when the body is NOT compressed (the transport may
    // already have decoded; some relays do, some don't — match the source).
    const declared = (() => {
      const cl = res.headers?.['content-length']
      const enc = ((res.headers?.['content-encoding'] ?? '') as string).toLowerCase()
      if (!cl || enc === 'gzip' || enc === 'br' || enc === 'deflate') return null
      const n = Number(cl)
      return Number.isFinite(n) && n >= 0 ? BigInt(n) : null
    })()
    try {
      const iterable = typeof res.body === 'string' ? (async function* () { yield Buffer.from(res.body as string) })() : (res.body as AsyncIterable<Uint8Array>)
      for await (const chunk of iterable) {
        if (opts.signal?.aborted) throw Object.assign(new AppError('ABORTED', 'The import was cancelled.', 499), { name: 'AbortError' })
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        written += BigInt(buf.byteLength)
        if (written > maxBytes) {
          throw new AppError('HLS_SEGMENT_TOO_LARGE', 'The remote file exceeds the maximum allowed size.', 413)
        }
        await handle.write(buf)
      }
      if (declared !== null && written !== declared) {
        throw new AppError('HLS_SEGMENT_DOWNLOAD_FAILED', 'The remote file was truncated.', 502)
      }
    } finally {
      await handle.close()
    }
    return written
  }
}

/**
 * Factory: resolve transport for a workerId (null → Direct) generically via registry.
 * No `if (driver === 'cloudflare')` branching.
 */
export async function createSecureFetcherForWorkerId(
  workerId: string | null | undefined,
  opts: { requestContext?: RemoteImportRequestContext | null; sourceUrl?: string } = {},
): Promise<SecureRemoteFetcher> {
  if (!workerId) {
    const transport = buildDirectTransport({ requestContext: opts.requestContext, sourceUrl: opts.sourceUrl })
    return new SecureRemoteFetcher(transport, { route: 'direct' })
  }

  const worker = await prisma.remoteFetchWorker.findFirst({ where: { id: workerId, deletedAt: null } })
  if (!worker) {
    throw new AppError('REMOTE_IMPORT_WORKER_UNAVAILABLE', 'The selected network worker is no longer available.', 409)
  }
  if (!worker.isEnabled) {
    throw new AppError('REMOTE_IMPORT_WORKER_DISABLED', 'The selected network worker is disabled.', 409)
  }
  if (!worker.endpointUrl) {
    throw new AppError('REMOTE_IMPORT_WORKER_UNAVAILABLE', 'The selected network worker is no longer available.', 409)
  }
  if (!hasDriver(worker.driver)) {
    throw new AppError('REMOTE_IMPORT_WORKER_DRIVER_UNSUPPORTED', 'The selected network worker uses an unsupported service.', 400)
  }
  const transport = buildTransportForWorker(
    {
      driver: worker.driver,
      endpointUrl: worker.endpointUrl,
      authType: worker.authType as any,
      secretEncrypted: worker.secretEncrypted,
    },
    { decryptSecret: (enc) => decryptText(enc) },
  )
  const relayHost = (() => {
    try {
      return new URL(worker.endpointUrl!).hostname
    } catch {
      return worker.endpointUrl ?? ''
    }
  })()
  // Inject workerId/driver into transport opts for safe logging (Cloudflare transport uses it)
  const anyTransport = transport as any
  if (anyTransport.opts) {
    anyTransport.opts.workerId = workerId
    anyTransport.opts.driver = worker.driver
  }
  return new SecureRemoteFetcher(transport, { route: 'worker', workerId: worker.id, driver: worker.driver, relayHost })
}

/** Synchronous factory for cases where worker row is already loaded */
export function createSecureFetcherForWorker(
  worker: { id: string; driver: string; endpointUrl: string; authType: string; secretEncrypted: string | null } | null,
  opts: { requestContext?: RemoteImportRequestContext | null; sourceUrl?: string } = {},
): SecureRemoteFetcher {
  if (!worker) {
    const transport = buildDirectTransport({ requestContext: opts.requestContext, sourceUrl: opts.sourceUrl })
    return new SecureRemoteFetcher(transport, { route: 'direct' })
  }
  if (!hasDriver(worker.driver)) {
    throw new AppError('REMOTE_IMPORT_WORKER_DRIVER_UNSUPPORTED', 'The selected network worker uses an unsupported service.', 400)
  }
  const transport = buildTransportForWorker(
    {
      driver: worker.driver,
      endpointUrl: worker.endpointUrl,
      authType: worker.authType as any,
      secretEncrypted: worker.secretEncrypted,
    },
    { decryptSecret: (enc) => decryptText(enc) },
  )
  const relayHost = (() => {
    try {
      return new URL(worker.endpointUrl).hostname
    } catch {
      return worker.endpointUrl
    }
  })()
  const anyTransport = transport as any
  if (anyTransport.opts) {
    anyTransport.opts.workerId = worker.id
    anyTransport.opts.driver = worker.driver
  }
  return new SecureRemoteFetcher(transport, { route: 'worker', workerId: worker.id, driver: worker.driver, relayHost })
}
