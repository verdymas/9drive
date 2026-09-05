/**
 * HMAC auth middleware for the internal control-plane.
 *
 * Symmetric to `app/security/internal_auth.py` on the Python side. A
 * shared secret signs the request (header `X-Stream-Signature` +
 * `X-Stream-Timestamp`); the body is *not* in the canonical string for
 * control-plane calls (they are simple JSON) but a future revision may
 * include it. The Range-bearing call is /v1/stream and is signed there.
 *
 * Used for /telegram/stream/session* and /telegram/stream/control/health
 * only. Rejects with 401 on any mismatch, 503 when the service is not
 * configured (operator must set TELEGRAM_STREAM_INTERNAL_SECRET).
 */
import type { NextFunction, Request, Response } from 'express'
import crypto from 'node:crypto'

import { env } from '../../config/env.js'

export function requireInternalStreamSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = env.TELEGRAM_STREAM_INTERNAL_SECRET
  if (!secret) {
    res.status(503).json({ code: 'STREAM_NOT_CONFIGURED', message: 'Telegram stream service is not configured.' })
    return
  }
  const ts = String(req.header('x-stream-timestamp') ?? '')
  const sig = String(req.header('x-stream-signature') ?? '')
  if (!ts || !sig) {
    res.status(401).json({ code: 'MISSING_SIGNATURE', message: 'Missing signature headers.' })
    return
  }
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) {
    res.status(401).json({ code: 'BAD_TIMESTAMP', message: 'Bad timestamp.' })
    return
  }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - tsNum) > env.TELEGRAM_STREAM_SIGNATURE_MAX_SKEW_SECONDS) {
    res.status(401).json({ code: 'EXPIRED_SIGNATURE', message: 'Signature expired.' })
    return
  }
  const canonical = [ts, req.method.toUpperCase(), req.originalUrl.split('?')[0], req.originalUrl.split('?')[1] ?? ''].join('\n')
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(sig, 'utf8')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ code: 'INVALID_SIGNATURE', message: 'Invalid signature.' })
    return
  }
  next()
}
