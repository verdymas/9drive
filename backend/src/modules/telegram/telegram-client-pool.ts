/**
 * Per-key Telegram client pool.
 *
 * 9Drive's Telegram operations used to create a fresh MTProto client per
 * request (full TCP + Diffie-Hellman handshake + 4 RPCs before the first
 * byte). Jellyfin playback issues rapid Range requests, so each seek paid the
 * handshake cost — and rapid fresh connects risk exhausting Telegram's
 * per-account auth-key limit (fresh DH per connection eventually trips it and
 * downloads get dropped).
 *
 * This pool keeps exactly one connected client per key (the encrypted session
 * string hash) and reuses it across requests. teleproto supports concurrent
 * `iterDownload` calls on one client — each routes through `_leaseSender` →
 * `Network.lease` → `SenderSlot`, which reference-counts concurrent leases.
 *
 * The pool is generic over the client shape so it does not import
 * telegram.service.ts (avoids a circular dependency).
 */

/** The client surface the pool needs. Matches teleproto's TelegramClient. */
export interface PooledClient {
  connect(): Promise<unknown>
  disconnect(): Promise<unknown>
  /** teleproto types this `boolean | undefined` — undefined counts as not connected. */
  connected?: boolean
}

type Factory<T> = () => Promise<T>

const clients = new Map<string, Promise<PooledClient>>()

/** Create + connect a client, evicting the map entry if creation/connect fails. */
function buildPromise<T extends PooledClient>(key: string, factory: Factory<T>): Promise<T> {
  let created!: Promise<T>
  created = factory()
    .then(async (client) => {
      await client.connect()
      return client
    })
    .catch((error) => {
      // Only evict if this is still the entry we created (a later evict or
      // replacement may have superseded it).
      if (clients.get(key) === created) clients.delete(key)
      throw error
    })
  return created
}

/**
 * Return the pooled client for `key`, creating + connecting one via `factory`
 * on first use. The get→create→set section is synchronous (no awaits), so
 * concurrent callers share one creation promise. A failed creation is evicted
 * and the next caller retries; a pooled client that has since dropped its
 * connection is replaced by exactly one of the concurrent callers (the others
 * re-read the map and pick up the new entry).
 */
export async function getPooledTelegramClient<T extends PooledClient>(key: string, factory: Factory<T>): Promise<T> {
  for (;;) {
    const existing = clients.get(key)
    if (!existing) {
      const created = buildPromise(key, factory)
      clients.set(key, created)
      return created
    }
    let client: PooledClient | undefined
    try {
      client = await existing
    } catch {
      // Creation failed — the rejection handler may or may not have evicted
      // the entry yet; either way we replace it below.
    }
    if (client?.connected) return client as T
    // Stale (failed or disconnected): replace it, but only if no one else did
    // while we were awaiting.
    if (clients.get(key) !== existing) continue
    const created = buildPromise(key, factory)
    clients.set(key, created)
    return created
  }
}

/** Disconnect and drop the pooled client for `key` (auth failure, disconnect). */
export async function evictTelegramClient(key: string): Promise<void> {
  const entry = clients.get(key)
  clients.delete(key)
  if (!entry) return
  try {
    const client = await entry
    await client.disconnect()
  } catch {
    // Entry already failed or is gone — nothing to disconnect.
  }
}

/** Disconnect every pooled client and clear the pool (shutdown / tests). */
export async function closeTelegramClientPool(): Promise<void> {
  const entries = [...clients.values()]
  clients.clear()
  await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        const client = await entry
        await client.disconnect()
      } catch {
        // Failed or already-disconnected clients are fine to skip.
      }
    }),
  )
}
