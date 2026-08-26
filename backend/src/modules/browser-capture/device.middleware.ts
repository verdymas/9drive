import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../../config/prisma.js'
import { hashToken } from '../../utils/crypto.js'

export type DeviceRequest = Request & {
  device?: { id: string; userId: string }
}

/**
 * Bearer auth for extension endpoints using a hashed browser-device token
 * (same lookup pattern as the API-key middleware). Revoked devices fail with
 * 401 — the extension then re-pairs.
 */
export async function requireDevice(req: DeviceRequest, res: Response, next: NextFunction) {
  try {
    const header = req.header('Authorization')
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ code: 'DEVICE_TOKEN_REQUIRED', message: 'Device token required.' })
    const raw = header.slice(7).trim()
    const device = await prisma.browserDevice.findUnique({ where: { deviceTokenHash: hashToken(raw) } })
    if (!device || device.status !== 'active' || device.revokedAt) {
      return res.status(401).json({ code: 'DEVICE_TOKEN_INVALID', message: 'Invalid or revoked device token.' })
    }
    req.device = { id: device.id, userId: device.userId }
    return next()
  } catch {
    return res.status(401).json({ code: 'DEVICE_TOKEN_INVALID', message: 'Invalid device token.' })
  }
}
