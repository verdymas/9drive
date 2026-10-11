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
      const value = header.value
      if (typeof value !== 'string' || value.length === 0) continue
      // Explicit allowlist only — never transport-controlled, hop-by-hop,
      // Authorization, or Range (a captured Range must never override the
      // generated probe/download Range). Only headers belonging to this exact
      // resource request (matched by requestId downstream) are recorded.
      switch (name) {
        case 'cookie':
          if (value.length <= 16384) context.cookie = value
          break
        case 'user-agent':
          if (value.length <= 2048) context.userAgent = value
          break
        case 'referer':
          if (value.length <= 4096) context.referer = value
          break
        case 'origin':
          if (value.length <= 2048) context.origin = value
          break
        case 'accept':
          if (value.length <= 1024) context.accept = value
          break
        case 'accept-encoding':
          if (value.length <= 512) context.acceptEncoding = value
          break
        case 'accept-language':
          if (value.length <= 1024) context.acceptLanguage = value
          break
        case 'sec-ch-ua':
          if (value.length <= 1024) context.secChUa = value
          break
        case 'sec-ch-ua-mobile':
          if (value.length <= 8) context.secChUaMobile = value
          break
        case 'sec-ch-ua-platform':
          if (value.length <= 128) context.secChUaPlatform = value
          break
        case 'sec-fetch-site':
          if (value.length <= 32) context.secFetchSite = value
          break
        case 'sec-fetch-mode':
          if (value.length <= 32) context.secFetchMode = value
          break
        case 'sec-fetch-dest':
          if (value.length <= 32) context.secFetchDest = value
          break
        case 'sec-fetch-storage-access':
          if (value.length <= 32) context.secFetchStorageAccess = value
          break
        default:
          break
      }
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
