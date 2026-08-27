import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { hashToken } from '../../utils/crypto.js'
import {
  createDevicePairing,
  registerBrowserDevice,
  listDevices,
  renameDevice,
  revokeDevice,
  rotateDeviceCredential,
  countPendingResources,
  heartbeatDevice,
  submitCapturedResource,
  listCapturedResources,
  markResourcesConsumed,
  deleteCapturedResource,
  importCapturedResource,
} from './browser-capture.service.js'
import { serializeRemoteImport } from '../remote-imports/remote-import.service.js'
import { requireDevice, type DeviceRequest } from './device.middleware.js'
import { rateLimit } from './rate-limit.middleware.js'

// Registration is unauthenticated — the tightest limit. Device endpoints get
// a generous-but-bounded allowance (detection bursts are normal).
const registerLimiter = rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'bc-register' })
const deviceLimiter = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'bc-device' })
const pairingLimiter = rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'bc-pairing' })

export const browserCaptureRouter = Router()

// ── Dashboard endpoints (requireAuth) ───────────────────────────────────────

/** Create a one-time pairing code (shown in the Settings → Browser Capture UI). */
browserCaptureRouter.post('/devices/pairing', pairingLimiter, requireAuth, async (req: AuthRequest, res, next) => {
  try {
    return res.status(201).json(await createDevicePairing(req.user!.id))
  } catch (error) {
    return next(error)
  }
})

browserCaptureRouter.get('/devices', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    return res.json({ devices: await listDevices(req.user!.id) })
  } catch (error) {
    return next(error)
  }
})

browserCaptureRouter.patch('/devices/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ name: z.string().trim().min(1).max(191) }).parse(req.body)
    await renameDevice(req.user!.id, String(req.params.id), body.name)
    return res.json({ status: 'ok' })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

browserCaptureRouter.post('/devices/:id/rotate', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    return res.json(await rotateDeviceCredential(req.user!.id, String(req.params.id)))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

browserCaptureRouter.delete('/devices/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await revokeDevice(req.user!.id, String(req.params.id))
    return res.status(204).end()
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

/** Pending-capture count for the dashboard sidebar badge (Phase 07 UI). */
browserCaptureRouter.get('/resources/count', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    return res.json({ count: await countPendingResources(req.user!.id) })
  } catch (error) {
    return next(error)
  }
})

// ── Extension endpoints (device-token auth) ──────────────────────────────────
// `/register` is public; everything below requires a device token.

/** Exchange a dashboard pairing code for a device token. Shown once. */
browserCaptureRouter.post('/devices/register', registerLimiter, async (req, res, next) => {
  try {
    const body = z.object({
      pairingCode: z.string().min(1).max(255),
      name: z.string().trim().min(1).max(191),
      browser: z.string().min(1).max(64),
      platform: z.string().min(1).max(64),
      extensionVersion: z.string().max(32).nullable().optional(),
    }).parse(req.body)
    return res.status(201).json(await registerBrowserDevice(body))
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

browserCaptureRouter.post('/heartbeat', deviceLimiter, requireDevice, async (req: DeviceRequest, res) => {
  const version = typeof req.body?.extensionVersion === 'string' ? req.body.extensionVersion : null
  void heartbeatDevice(req.device!.id, version)
  return res.json({ status: 'ok' })
})

const resourceContextSchema = z.object({
  referer: z.string().max(4096).optional(),
  origin: z.string().max(2048).optional(),
  userAgent: z.string().max(2048).optional(),
}).strict().optional()

const submitSchema = z.object({
  url: z.string().min(1).max(4096),
  type: z.enum(['video', 'hls', 'dash', 'document']),
  mimeType: z.string().max(191).nullable().optional(),
  filename: z.string().max(255).nullable().optional(),
  pageUrl: z.string().max(4096).nullable().optional(),
  pageTitle: z.string().max(512).nullable().optional(),
  requestContext: resourceContextSchema,
}).strict()

browserCaptureRouter.post('/resources', deviceLimiter, requireDevice, async (req: DeviceRequest, res, next) => {
  try {
    const body = submitSchema.parse(req.body)
    const row = await submitCapturedResource({
      deviceId: req.device!.id,
      userId: req.device!.userId,
      ...body,
    })
    return res.status(201).json(row)
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

browserCaptureRouter.get('/resources', deviceLimiter, requireDevice, async (req: DeviceRequest, res, next) => {
  try {
    const limit = Number(req.query.limit) || 100
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
    const rows = await listCapturedResources(req.device!.userId, { limit, cursor })
    return res.json({ items: rows.map(stripOwner), cursor: rows.length ? rows[rows.length - 1].id : null })
  } catch (error) {
    return next(error)
  }
})

function stripOwner(row: any) {
  // The device never needs userId/browserDeviceId back.
  const { userId: _u, browserDeviceId: _b, ...rest } = row
  return rest
}

browserCaptureRouter.post('/resources/mark-consumed', requireDevice, async (req: DeviceRequest, res, next) => {
  try {
    const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(req.body)
    await markResourcesConsumed(req.device!.userId, body.ids)
    return res.json({ status: 'ok' })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    return next(error)
  }
})

browserCaptureRouter.delete('/resources/:id', requireDevice, async (req: DeviceRequest, res, next) => {
  try {
    await deleteCapturedResource(req.device!.userId, String(req.params.id))
    return res.status(204).end()
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

// ── Extension download (authenticated) ───────────────────────────────────────

/** Resolve the extension dir by walking up from __dirname until `extensions`
 *  is found. __dirname depth differs between dev (src/, 4 ups) and compiled
 *  (dist/, 3 ups to the app root) — a fixed hop count breaks one of them. */
function resolveExtensionDir(): string {
  const configured = env.BROWSER_CAPTURE_EXTENSION_DIR
  if (configured) return path.resolve(configured)
  let dir = path.resolve(__dirname)
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extensions', 'browser-capture')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(dir, 'extensions', 'browser-capture')
}

/** Stream the pre-built browser-extension zip for manual installation. */
browserCaptureRouter.get('/extension.zip', requireAuth, async (_req, res, next) => {
  try {
    // The zip is generated at build time by `npm run build` (or
    // `npm run zip:extension`) into extensions/9drive-browser-capture-ext.zip
    // and must exist before serving.
    const extDir = resolveExtensionDir()
    const zipPath = path.resolve(extDir, '..', '9drive-browser-capture-ext.zip')
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ code: 'EXTENSION_NOT_FOUND', message: 'Extension package not built. Run npm run build first.' })
    }
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="9drive-capture.zip"')
    fs.createReadStream(zipPath).pipe(res)
  } catch (error) {
    return next(error)
  }
})

// ── Import (device-token OR dashboard user session — the extension's popup
// authenticates with its device token; the dashboard reuses requireAuth) ─────

/**
 * Accept EITHER a device token (extension) or a user bearer token (dashboard).
 * Both resolve to the same `userId` — ownership checks are identical either way.
 */
function requireAnyIdentity(req: any, res: Response, next: NextFunction) {
  const header = req.header('Authorization') ?? ''
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (raw.startsWith('bd_')) {
    prisma.browserDevice.findUnique({ where: { deviceTokenHash: hashToken(raw) } }).then((device) => {
      if (!device || device.status !== 'active' || device.revokedAt) {
        return res.status(401).json({ code: 'DEVICE_TOKEN_INVALID', message: 'Invalid or revoked device token.' })
      }
      req.user = { id: device.userId, sessionId: `device:${device.id}` }
      next()
    }).catch(() => res.status(401).json({ code: 'DEVICE_TOKEN_INVALID', message: 'Invalid device token.' }))
    return
  }
  requireAuth(req, res, next)
}

/** Popup bootstrap: destination folders + workers for the import dialog. */
browserCaptureRouter.get('/import-options', requireAnyIdentity, async (req: any, res, next) => {
  try {
    const [folders, accounts, workers] = await Promise.all([
      prisma.folder.findMany({
        where: { userId: req.user.id, deletedAt: null },
        select: { id: true, name: true, parentId: true },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.connectedAccount.findMany({
        where: { userId: req.user.id, status: 'connected' },
        select: { id: true, provider: true, email: true, displayName: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.remoteFetchWorker.findMany({
        where: { deletedAt: null, isEnabled: true },
        select: { id: true, name: true, driver: true, status: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
    ])
    return res.json({ folders, storageAccounts: accounts, workers })
  } catch (error) {
    return next(error)
  }
})

/**
 * Import a captured resource via the EXISTING Remote Import pipeline. The URL
 * is loaded server-side from the captured row — never taken from the client.
 * Returns the created Remote Import so the UI can track its progress.
 */
browserCaptureRouter.post('/resources/:id/import', requireAnyIdentity, async (req: any, res, next) => {
  try {
    const body = z.object({
      filename: z.string().max(255).nullable().optional(),
      folderId: z.string().nullable().optional(),
      connectedAccountId: z.string().nullable().optional(),
      workerId: z.string().nullable().optional(),
    }).strict().parse(req.body ?? {})
    const { remoteImport } = await importCapturedResource(req.user.id, String(req.params.id), body)
    return res.status(201).json({ remoteImport: serializeRemoteImport(remoteImport as any) })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})
