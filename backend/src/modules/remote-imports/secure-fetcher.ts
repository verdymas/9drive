import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText } from '../../utils/crypto.js'
import { hasDriver, resolveDriver } from '../remote-fetch-workers/driver-registry.js'
import { buildDirectTransport, buildTransportForWorker } from '../remote-fetch-workers/transport.js'
import { urlFingerprintForLog } from '../remote-fetch-workers/relay-protocol.js'
import type { RemoteFetchTransport, RemoteFetchRequest, RemoteFetchResponse } from '../remote-fetch-workers/types.js'
import type { RemoteImportRequestContext } from './request-context.js'

function opOf(traceId: string): string {
  return traceId.includes(':') ? traceId.slice(traceId.lastIndexOf(':') + 1).slice(0, 32) || 'fetch' : 'fetch'
}

function urlFpOf(rawUrl: string): string {
  try {
    return urlFingerprintForLog(rawUrl)
  } catch {
    return 'unknown'
  }
}

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
    const rawTrace: unknown = (input as RemoteFetchRequest).traceId
    const traceId: string = typeof rawTrace === 'string' ? rawTrace : 'none'
    const op = opOf(traceId)
    const urlFp = urlFpOf(typeof input.url === 'string' ? input.url : '')
    if (this.diagnostics.route === 'direct') {
      console.log(`[remote-import:fetcher] route=direct traceId=${traceId} op=${op} targetHost=${targetHost} urlFp=${urlFp} method=${input.method ?? 'GET'}`)
    } else {
      console.log(
        `[remote-import:fetcher] route=worker traceId=${traceId} op=${op} workerId=${this.diagnostics.workerId ?? ''} driver=${this.diagnostics.driver ?? ''} relayHost=${this.diagnostics.relayHost ?? ''} targetHost=${targetHost} urlFp=${urlFp} method=${input.method ?? 'GET'}`,
      )
    }
    const res = await this.transport.request(input)
    // Log safe outcome — upstream answer, not relay health. The transport logs
    // relayHttpStatus vs upstreamStatus separately for worker routes; this line
    // carries the decoded upstream status plus the fingerprint so the fetcher
    // and transport lines join on traceId+urlFp.
    const finalHost = (() => {
      try {
        const f = (res as { finalUrl?: string }).finalUrl
        return f ? new URL(f).hostname : targetHost
      } catch {
        return targetHost
      }
    })()
    const redirectCount = (res as { redirectCount?: number }).redirectCount ?? 0
    const finalUrlFp = (() => {
      try {
        const f = (res as { finalUrl?: string }).finalUrl
        return f ? urlFpOf(f) : urlFp
      } catch {
        return urlFp
      }
    })()
    console.log(`[remote-import:fetcher] response route=${this.diagnostics.route} traceId=${traceId} op=${op} targetHost=${targetHost} urlFp=${urlFp} finalHost=${finalHost} finalUrlFp=${finalUrlFp} redirectCount=${redirectCount} status=${res.status}`)
    return res as RemoteFetchResponse & { finalUrl?: string; redirectCount?: number }
  }

  /** Convenience for HEAD probe */
  async head(url: string, opts: { headers?: Record<string, string>; requestContext?: RemoteImportRequestContext | null; sourceUrl?: string; traceId?: string } = {}): Promise<RemoteFetchResponse & { finalUrl?: string }> {
    return this.fetch({ method: 'HEAD', url, headers: opts.headers, requestContext: opts.requestContext as any, sourceUrl: opts.sourceUrl, maxBytes: 0, traceId: opts.traceId } as any)
  }

  /** Convenience for ranged GET (bytes=0-0) */
  async rangedGet(url: string, opts: { headers?: Record<string, string>; requestContext?: RemoteImportRequestContext | null; sourceUrl?: string; traceId?: string } = {}): Promise<RemoteFetchResponse & { finalUrl?: string }> {
    return this.fetch({ method: 'GET', url, headers: opts.headers, range: 'bytes=0-0', requestContext: opts.requestContext as any, sourceUrl: opts.sourceUrl, traceId: opts.traceId } as any)
  }

  /** Bounded GET for manifests (string body) */
  async boundedGet(url: string, opts: { headers?: Record<string, string>; maxBytes?: number; signal?: AbortSignal; requestContext?: RemoteImportRequestContext | null; sourceUrl?: string; traceId?: string } = {}): Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl: string }> {
    const res = await this.fetch({ method: 'GET', url, headers: opts.headers, maxBytes: opts.maxBytes, requestContext: opts.requestContext as any, sourceUrl: opts.sourceUrl, timeoutMs: opts.signal ? 10000 : undefined, traceId: opts.traceId } as any)
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
  async downloadToFile(url: string, targetPath: string, opts: { maxBytes?: bigint; signal?: AbortSignal; requestContext?: RemoteImportRequestContext | null; sourceUrl?: string; kind?: string; traceId?: string } = {}): Promise<bigint> {
    const res = await this.fetch({ method: 'GET', url, requestContext: opts.requestContext as any, sourceUrl: opts.sourceUrl, traceId: (opts as { traceId?: string }).traceId } as any)
    if (res.status === 401 || res.status === 403) {
      if (opts.requestContext) {
        throw new AppError('REMOTE_SOURCE_ACCESS_EXPIRED', 'The source access has expired. Please capture a fresh request.', res.status)
      }
      throw new AppError('HLS_AUTHENTICATED_SOURCE_UNSUPPORTED', 'Authenticated sources require a request context.', 400)
    }
    if (res.status >= 400) {
      // Final error classification: for worker routes the transport already
      // logged relayHttpStatus vs upstreamStatus — this status IS the decoded
      // upstream answer (a relay-level failure throws WORKER_* instead and
      // never reaches here). The job stays on its selected route; no Direct
      // retry is attempted.
      const traceId = typeof (opts as { traceId?: string }).traceId === 'string' ? String((opts as { traceId?: string }).traceId) : 'none'
      console.error(`[remote-import:fetcher] download_http_error route=${this.diagnostics.route} traceId=${traceId} op=${opOf(traceId)} workerId=${this.diagnostics.workerId ?? ''} upstreamStatus=${res.status} code=DOWNLOAD_HTTP_ERROR`)
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
    // Route decision: explicit Direct selection (workerId null). One line per
    // job/probe so a later Direct request can be attributed to its own job.
    console.log(`[remote-import:route] route=direct workerId=none driver=none relayHost=none`)
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
    anyTransport.opts.sourceUrl = opts.sourceUrl
    anyTransport.opts.requestContext = opts.requestContext
  }
  // Route decision: Worker-selected jobs must remain on Worker for every
  // subsequent probe/download/range/retry of this job. No automatic fallback.
  console.log(`[remote-import:route] route=worker workerId=${worker.id} driver=${worker.driver} relayHost=${relayHost}`)
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
    anyTransport.opts.sourceUrl = opts.sourceUrl
    anyTransport.opts.requestContext = opts.requestContext
  }
  console.log(`[remote-import:route] route=worker workerId=${worker.id} driver=${worker.driver} relayHost=${relayHost}`)
  return new SecureRemoteFetcher(transport, { route: 'worker', workerId: worker.id, driver: worker.driver, relayHost })
}
