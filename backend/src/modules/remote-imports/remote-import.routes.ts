import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
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

remoteImportRouter.post('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      url: z.string().min(1).max(4096),
      folderId: z.string().nullable().optional(),
      connectedAccountId: z.string().nullable().optional(),
      fileName: z.string().max(255).nullable().optional(),
      mimeType: z.string().max(191).nullable().optional(),
    }).parse(req.body)

    const created = await createRemoteImport({
      userId: req.user!.id,
      sourceUrl: body.url,
      folderId: body.folderId,
      connectedAccountId: body.connectedAccountId,
      fileName: body.fileName,
      mimeType: body.mimeType,
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