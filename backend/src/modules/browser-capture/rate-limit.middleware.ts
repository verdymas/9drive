import type { NextFunction, Request, Response } from 'express'

/**
 * Minimal fixed-window rate limiter for Browser Capture endpoints (Phase 07).
 * In-memory per process — sufficient for a single-API deployment; a Redis
 * backend is the upgrade path for multi-instance (ponytail: 10k entries max,
 * LRU-ish eviction by periodic sweep).
 */
const windows = new Map<string, { count: number; resetAt: number }>()
const MAX_KEYS = 10_000

export function rateLimit(opts: { windowMs: number; max: number; keyPrefix: string }) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.keyPrefix}:${_req.ip ?? 'unknown'}`
    const now = Date.now()
    let entry = windows.get(key)
    if (!entry || entry.resetAt < now) {
      if (windows.size >= MAX_KEYS) windows.clear() // crude bound; resets everyone on overflow
      entry = { count: 0, resetAt: now + opts.windowMs }
      windows.set(key, entry)
    }
    entry.count += 1
    if (entry.count > opts.max) {
      return res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' })
    }
    next()
  }
}

/** Test hook: clear all windows (rate limits are process-global state). */
export function resetRateLimits() {
  windows.clear()
}
