import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { probeRemoteUrl } from './probe.js'
import {
  cancelRemoteImport,
  createRemoteImport,
  deleteRemoteImport,
  getRemoteImportForUser,
  listRemoteImportsForUser,
  retryRemoteImport,
  serializeRemoteImport,
} from './remote-import.service.js'

export const remoteImportRouter = Router()

/**
 * Probe a remote URL for filename + metadata without downloading the file.
 * Registered BEFORE the `/:id` routes so the literal segment `probe` never
 * matches a record id. Authenticated; the probe is user-scoped by design (no
 * record is touched). The returned URLs have sensitive query params redacted.
 */
remoteImportRouter.post('/probe', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      url: z.string().min(1).max(4096),
    }).parse(req.body)

    const result = await probeRemoteUrl(body.url, req.user!.id)
    return res.json({ data: result })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

const hlsOptionsSchema = z
  .object({
    // SourceType from the probe: 'hls_master' | 'hls_media'.
    sourceType: z.enum(['hls_master', 'hls_media']),
    variantId: z.string().max(64).optional(),
    audioTrackId: z.string().max(64).optional(),
    outputContainer: z.enum(['auto', 'mkv', 'mp4']).optional(),
    // True when the selected media playlist is live/event (no ENDLIST).
    isLive: z.boolean().optional(),
    // Live-only: the RECORDING length the worker should capture; a finite
    // source must reject this. Enforced server-side (§19).
    recordingDurationSeconds: z.number().int().min(60).max(21600).optional(),
  })
  .superRefine((hls, ctx) => {
    if (hls.isLive && hls.recordingDurationSeconds == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['hls', 'recordingDurationSeconds'],
        message: 'A live HLS source requires a recording duration.',
      })
    }
    if (!hls.isLive && hls.recordingDurationSeconds != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['hls', 'recordingDurationSeconds'],
        message: 'A finite HLS source must not carry a recording duration.',
      })
    }
  })
  .optional()

remoteImportRouter.post('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      url: z.string().min(1).max(4096),
      folderId: z.string().nullable().optional(),
      connectedAccountId: z.string().nullable().optional(),
      fileName: z.string().max(255).nullable().optional(),
      // Server-side detected name from the probe; used only when the user did
      // not type one. Never trusted as-is — sanitized again at creation.
      detectedFileName: z.string().max(255).nullable().optional(),
      mimeType: z.string().max(191).nullable().optional(),
      // HLS import knobs (from the probe's `sourceType` classification).
      hls: hlsOptionsSchema,
    }).parse(req.body)

    const created = await createRemoteImport({
      userId: req.user!.id,
      sourceUrl: body.url,
      folderId: body.folderId,
      connectedAccountId: body.connectedAccountId,
      fileName: body.fileName,
      detectedFileName: body.detectedFileName,
      mimeType: body.mimeType,
      hls: body.hls,
    })
    return res.status(201).json(serializeRemoteImport(created))
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteImportRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const limit = Number(req.query.limit) || 50
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
    const rows = await listRemoteImportsForUser(req.user!.id, limit, cursor)
    return res.json({ items: rows.map(serializeRemoteImport), cursor: rows.length ? rows[rows.length - 1].id : null })
  } catch (error) {
    return next(error)
  }
})

remoteImportRouter.get('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await getRemoteImportForUser(String(req.params.id), req.user!.id)
    return res.json(serializeRemoteImport(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteImportRouter.post('/:id/cancel', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await cancelRemoteImport(String(req.params.id), req.user!.id)
    return res.json(serializeRemoteImport(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteImportRouter.post('/:id/retry', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await retryRemoteImport(String(req.params.id), req.user!.id)
    return res.json(serializeRemoteImport(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteImportRouter.delete('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await deleteRemoteImport(String(req.params.id), req.user!.id)
    return res.status(204).end()
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})