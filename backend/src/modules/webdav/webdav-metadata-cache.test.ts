import { describe, expect, it } from 'vitest'
import { WebDavMetadataCache, type WebDavMetadataKey } from './webdav-metadata-cache.js'

function pathKey(namespace: string, path: string): WebDavMetadataKey {
  return { namespace, kind: 'path', path }
}

describe('WebDavMetadataCache', () => {
  it('keeps identical paths isolated by metadata namespace', async () => {
    const cache = new WebDavMetadataCache({ ttlMs: 1_000, maxEntries: 10, logger: () => undefined })
    let loads = 0

    await expect(cache.get(pathKey('namespace-a', '/same'), async () => `a-${++loads}`)).resolves.toBe('a-1')
    await expect(cache.get(pathKey('namespace-b', '/same'), async () => `b-${++loads}`)).resolves.toBe('b-2')
    await expect(cache.get(pathKey('namespace-a', '/same'), async () => `unexpected-${++loads}`)).resolves.toBe('a-1')

    expect(loads).toBe(2)
    expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 2, entries: 2 })
  })

  it('expires metadata after the configured TTL', async () => {
    let now = 1_000
    const cache = new WebDavMetadataCache({ ttlMs: 100, maxEntries: 10, now: () => now, logger: () => undefined })
    let loads = 0
    const key = pathKey('namespace-a', '/movie.mkv')

    await expect(cache.get(key, async () => `value-${++loads}`)).resolves.toBe('value-1')
    now += 99
    await expect(cache.get(key, async () => `value-${++loads}`)).resolves.toBe('value-1')
    now += 1
    await expect(cache.get(key, async () => `value-${++loads}`)).resolves.toBe('value-2')

    expect(loads).toBe(2)
    expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 2, expired: 1, entries: 1 })
  })

  it('evicts least-recently-used entries to stay bounded', async () => {
    const cache = new WebDavMetadataCache({ ttlMs: 1_000, maxEntries: 2, logger: () => undefined })
    let loads = 0

    await cache.get(pathKey('namespace-a', '/one'), async () => ++loads)
    await cache.get(pathKey('namespace-a', '/two'), async () => ++loads)
    await cache.get(pathKey('namespace-a', '/one'), async () => ++loads)
    await cache.get(pathKey('namespace-a', '/three'), async () => ++loads)
    await expect(cache.get(pathKey('namespace-a', '/two'), async () => ++loads)).resolves.toBe(4)

    expect(cache.snapshot()).toMatchObject({ entries: 2, evictions: 2 })
  })

  it('invalidates all entries for a namespace without touching another namespace', async () => {
    const cache = new WebDavMetadataCache({ ttlMs: 1_000, maxEntries: 10, logger: () => undefined })
    let loads = 0

    await cache.get(pathKey('namespace-a', '/same'), async () => `a-${++loads}`)
    await cache.get(pathKey('namespace-b', '/same'), async () => `b-${++loads}`)
    cache.invalidateNamespace('namespace-a')

    await expect(cache.get(pathKey('namespace-a', '/same'), async () => `a-${++loads}`)).resolves.toBe('a-3')
    await expect(cache.get(pathKey('namespace-b', '/same'), async () => `unexpected-${++loads}`)).resolves.toBe('b-2')
  })

  it('emits structured lookup measurements without including the cache key', async () => {
    const logs: unknown[][] = []
    const cache = new WebDavMetadataCache({ ttlMs: 1_000, maxEntries: 10, logger: (...args) => logs.push(args) })

    await cache.get(pathKey('namespace-a', '/private-name.mkv'), async () => 'metadata')

    expect(logs).toHaveLength(1)
    expect(logs[0]?.[0]).toBe('[webdav-metadata]')
    expect(JSON.parse(String(logs[0]?.[1]))).toMatchObject({
      event: 'webdav.metadata.lookup',
      kind: 'path',
      outcome: 'miss',
      durationMs: expect.any(Number),
    })
    expect(String(logs[0]?.[1])).not.toContain('private-name.mkv')
  })
})
