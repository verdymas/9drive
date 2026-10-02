/** Transient request headers. Never persist or expose this map to the popup. */
export class RequestHeaderTracker {
  constructor({ now = () => Date.now(), ttlMs = 60_000, maxEntries = 500 } = {}) {
    this.entries = new Map()
    this.now = now
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
  }

  record(requestId, url, headers = []) {
    this.prune()
    const context = {}
    for (const header of headers) {
      const name = header.name?.toLowerCase()
      if (name === 'cookie' && typeof header.value === 'string') context.cookie = header.value
      if (name === 'user-agent' && typeof header.value === 'string') context.userAgent = header.value
    }
    const key = JSON.stringify([requestId, url])
    this.entries.delete(key)
    this.entries.set(key, { context, ts: this.now() })
    this.prune()
  }

  snapshot(requestId, url) {
    this.prune()
    const found = this.entries.get(JSON.stringify([requestId, url]))
    return found ? { ...found.context } : null
  }

  clear(requestId) {
    for (const key of this.entries.keys()) {
      if (JSON.parse(key)[0] === requestId) this.entries.delete(key)
    }
  }

  prune() {
    const cutoff = this.now() - this.ttlMs
    for (const [key, entry] of this.entries) {
      if (entry.ts < cutoff) this.entries.delete(key)
    }
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value)
  }
}
