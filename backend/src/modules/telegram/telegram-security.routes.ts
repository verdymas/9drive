import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import {
  buildEncryptedCaptionForFile,
  convertFileToEncryptedCaption,
  decryptMetadataPayload,
  getTelegramSecurityStatus,
} from './telegram-security.service.js'

/**
 * HTTP surface for Telegram metadata security (spec §44).
 *
 * `requireAuth` only — this codebase has no RBAC; every authenticated user is
 * admin-equivalent, and each route additionally verifies ownership of the
 * target file. The master key is never accepted as input and never returned.
 *
 *   GET  /telegram/security/status         — Configured / Not Configured / Invalid
 *   POST /telegram/security/encrypt        — caption to paste for manual repair
 *   POST /telegram/security/decrypt        — read a 9drive:meta payload back
 *   POST /telegram/security/convert-legacy — rewrite one caption as encrypted
 */
export const telegramSecurityRouter = Router()
telegramSecurityRouter.use(requireAuth)

const fileBody = z.object({ fileId: z.string().min(1) })

telegramSecurityRouter.get('/security/status', (_req: AuthRequest, res) => {
  return res.json(getTelegramSecurityStatus())
})

telegramSecurityRouter.post('/security/encrypt', async (req: AuthRequest, res, next) => {
  try {
    const { fileId } = fileBody.parse(req.body)
    return res.json(await buildEncryptedCaptionForFile(req.user!.id, fileId))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

telegramSecurityRouter.post('/security/decrypt', async (req: AuthRequest, res, next) => {
  try {
    const { payload } = z.object({ payload: z.string().min(1).max(4096) }).parse(req.body)
    return res.json({ metadata: await decryptMetadataPayload(req.user!.id, payload) })
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

telegramSecurityRouter.post('/security/convert-legacy', async (req: AuthRequest, res, next) => {
  try {
    const { fileId } = fileBody.parse(req.body)
    return res.json(await convertFileToEncryptedCaption(req.user!.id, fileId))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})
