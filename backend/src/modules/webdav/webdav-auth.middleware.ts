import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { env } from '../../config/env.js'

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest()
}

export function requireWebDavAuth(req: Request, res: Response, next: NextFunction) {
  if (!env.WEBDAV_PASSWORD) {
    return res.status(503).json({ code: 'WEBDAV_NOT_CONFIGURED', message: 'WebDAV is not configured.' })
  }

  const header = req.header('Authorization')
  if (!header?.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="9Drive WebDAV"')
    return res.status(401).json({ code: 'WEBDAV_AUTH_REQUIRED', message: 'WebDAV authentication required.' })
  }

  let password: string
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    password = separator === -1 ? '' : decoded.slice(separator + 1)
  } catch {
    password = ''
  }

  const expected = sha256(env.WEBDAV_PASSWORD)
  const received = sha256(password)
  const matches = expected.length === received.length && crypto.timingSafeEqual(expected, received)

  if (!matches) {
    res.setHeader('WWW-Authenticate', 'Basic realm="9Drive WebDAV"')
    return res.status(401).json({ code: 'WEBDAV_AUTH_INVALID', message: 'Invalid WebDAV password.' })
  }

  return next()
}
