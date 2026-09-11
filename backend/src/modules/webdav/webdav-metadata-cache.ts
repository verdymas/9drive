import { env } from '../../config/env.js'

export type WebDavMetadataKey =
  | { namespace: string; kind: 'path'; path: string }
  | { namespace: string; kind: 'folder-id'; id: string }
  | { namespace: string; kind: 'folder-list'; parentId: string | null }
  | { namespace: string; kind: 'folder-child'; parentId: string | null; name: string }
  | { namespace: string; kind: 'file-list'; folderId: string | null }
  | { namespace: string; kind: 'file-child'; folderId: string | null; name: string }

export type WebDavMetadataCacheOptions = {
  ttlMs: number
  maxEntries: number
  now?: () => number
  logger?: (...args: unknown[]) => void
}

export type WebDavMetadataCacheStats = {
  hits: number
  misses: number
  expired: number
  evictions: number
  loads: number
  loadDurationMs: number
  entries: number
}

type CacheEntry = {
  namespace: string
  value: Promise<unknown>
  expiresAt: number
}

const DEFAULT_TTL_MS = 1_000
const DEFAULT_MAX_ENTRIES = 1_024

export const SHARED_WEBDAV_NAMESPACE = 'shared-webdav'

/** Normalize a WebDAV path for cache keys without changing display-name semantics. */
export function normalizeWebDavPath(path: string): string {
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.normalize('NFC'))
  return `/${segments.join('/')}`
}

function serializeKey(key: WebDavMetadataKey): string {
  switch (key.kind) {
    case 'path':
      return JSON.stringify([key.namespace, key.kind, normalizeWebDavPath(key.path)])
    case 'folder-id':
      return JSON.stringify([key.namespace, key.kind, key.id])
    case 'folder-list':
      return JSON.stringify([key.namespace, key.kind, key.parentId])
    case 'folder-child':
      return JSON.stringify([key.namespace, key.kind, key.parentId, key.name.normalize('NFC')])
    case 'file-list':
      return JSON.stringify([key.namespace, key.kind, key.folderId])
    case 'file-child':
      return JSON.stringify([key.namespace, key.kind, key.folderId, key.name.normalize('NFC')])
  }
}

/**
 * Small process-local metadata cache. Values are promises so concurrent
 * requests for the same key single-flight the DB query. It never stores byte
 * streams or provider-account credentials by itself; callers decide which
 * metadata values are eligible.
 */
export class WebDavMetadataCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly now: () => number
  private readonly logger: (...args: unknown[]) => void
  private readonly ttlMs: number
  private readonly maxEntries: number
  private stats: Omit<WebDavMetadataCacheStats, 'entries'> = {
    hits: 0,
    misses: 0,
    expired: 0,
    evictions: 0,
    loads: 0,
    loadDurationMs: 0,
  }

  constructor(options?: Partial<WebDavMetadataCacheOptions>) {
    this.ttlMs = Math.max(0, options?.ttlMs ?? DEFAULT_TTL_MS)
    this.maxEntries = Math.max(0, options?.maxEntries ?? DEFAULT_MAX_ENTRIES)
    this.now = options?.now ?? Date.now
    this.logger = options?.logger ?? console.info
  }

  async get<T>(key: WebDavMetadataKey, loader: () => Promise<T>): Promise<T> {
    const serializedKey = serializeKey(key)
    const currentTime = this.now()
    const existing = this.entries.get(serializedKey)

    if (existing && existing.expiresAt > currentTime) {
      this.stats.hits += 1
      this.touch(serializedKey, existing)
      this.logLookup(key, 'hit', 0)
      return existing.value as Promise<T>
    }

    if (existing) {
      this.entries.delete(serializedKey)
      this.stats.expired += 1
    }

    this.stats.misses += 1
    this.stats.loads += 1
    const startedAt = currentTime

    // A zero TTL or capacity is an explicit cache bypass. It still records a
    // miss/load so operators can distinguish disabled caching from cache hits.
    if (this.ttlMs === 0 || this.maxEntries === 0) {
      const value = await loader()
      const durationMs = Math.max(0, this.now() - startedAt)
      this.stats.loadDurationMs += durationMs
      this.logLookup(key, 'bypass', durationMs)
      return value
    }

    const value = Promise.resolve().then(loader)
    const entry: CacheEntry = {
      namespace: key.namespace,
      value,
      expiresAt: currentTime + this.ttlMs,
    }
    this.entries.set(serializedKey, entry)
    this.evictIfNeeded()

    void value.then(
      () => {
        const durationMs = Math.max(0, this.now() - startedAt)
        this.stats.loadDurationMs += durationMs
        this.logLookup(key, 'miss', durationMs)
      },
      () => {
        if (this.entries.get(serializedKey) === entry) this.entries.delete(serializedKey)
        const durationMs = Math.max(0, this.now() - startedAt)
        this.stats.loadDurationMs += durationMs
        this.logLookup(key, 'error', durationMs)
      },
    )
    return value as Promise<T>
  }

  invalidateNamespace(namespace: string): void {
    for (const [serializedKey, entry] of this.entries) {
      if (entry.namespace === namespace) this.entries.delete(serializedKey)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  snapshot(): WebDavMetadataCacheStats {
    return { ...this.stats, entries: this.entries.size }
  }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0, expired: 0, evictions: 0, loads: 0, loadDurationMs: 0 }
  }

  private touch(serializedKey: string, entry: CacheEntry): void {
    this.entries.delete(serializedKey)
    this.entries.set(serializedKey, entry)
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (oldestKey === undefined) return
      this.entries.delete(oldestKey)
      this.stats.evictions += 1
    }
  }

  private logLookup(key: WebDavMetadataKey, outcome: 'hit' | 'miss' | 'bypass' | 'error', durationMs: number): void {
    this.logger(
      '[webdav-metadata]',
      JSON.stringify({
        event: 'webdav.metadata.lookup',
        kind: key.kind,
        outcome,
        durationMs,
        cacheEntries: this.entries.size,
      }),
    )
  }
}

const defaultWebDavMetadataCache = new WebDavMetadataCache({
  ttlMs: env.WEBDAV_METADATA_CACHE_TTL_MS,
  maxEntries: env.WEBDAV_METADATA_CACHE_MAX_ENTRIES,
})

export function getDefaultWebDavMetadataCache(): WebDavMetadataCache {
  return defaultWebDavMetadataCache
}

export function invalidateWebDavMetadataCache(namespace = SHARED_WEBDAV_NAMESPACE): void {
  defaultWebDavMetadataCache.invalidateNamespace(namespace)
}

export function clearWebDavMetadataCache(): void {
  defaultWebDavMetadataCache.clear()
}
