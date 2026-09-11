import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import {
  abortDirectS3Upload,
  completeDirectS3Upload,
  initDirectS3Upload,
  signDirectS3UploadPart,
} from './direct-s3-upload.service.js'

export const directS3UploadRouter = Router()

const initSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(191),
  sizeBytes: z.string(),
  folderId: z.string().nullable().optional(),
  targetAccountId: z.string().nullable().optional(),
})

directS3UploadRouter.post('/init', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = initSchema.parse(req.body)
    const sizeBytes = BigInt(body.sizeBytes)
    if (sizeBytes <= 0n) return res.status(400).json({ code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' })
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
    const result = await initDirectS3Upload(req.user!.id, {
      fileName: body.fileName,
      mimeType: body.mimeType,
      sizeBytes,
      folderId: body.folderId ?? null,
      targetAccountId: body.targetAccountId ?? null,
    }, {
      enabled: env.S3_DIRECT_UPLOAD_ENABLED,
      expiresInSeconds: env.S3_DIRECT_UPLOAD_SESSION_TTL_SECONDS,
      partSizeBytes: env.S3_DIRECT_UPLOAD_PART_SIZE_BYTES,
    })
    return res.status(result.mode === 'direct-s3' ? 201 : 200).json(result)
  } catch (error) {
    return next(error)
  }
})

directS3UploadRouter.post('/:sessionId/parts/:partNumber', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { sessionId, partNumber } = z.object({ sessionId: z.string().min(1), partNumber: z.coerce.number().int().min(1).max(10_000) }).parse(req.params)
    return res.json(await signDirectS3UploadPart(req.user!.id, sessionId, partNumber, {
      partSizeBytes: env.S3_DIRECT_UPLOAD_PART_SIZE_BYTES,
      partUrlExpiresInSeconds: env.S3_DIRECT_UPLOAD_PART_URL_TTL_SECONDS,
    }))
  } catch (error) {
    return next(error)
  }
})

directS3UploadRouter.post('/:sessionId/complete', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(req.params)
    const { parts } = z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(512), sizeBytes: z.number().int().min(1).optional() })).min(1).max(10_000) }).parse(req.body)
    const result = await completeDirectS3Upload(req.user!.id, sessionId, parts, { partSizeBytes: env.S3_DIRECT_UPLOAD_PART_SIZE_BYTES })
    return res.status(201).json({ ...result, file: { ...result.file, sizeBytes: result.file.sizeBytes.toString() } })
  } catch (error) {
    return next(error)
  }
})

directS3UploadRouter.post('/:sessionId/abort', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(req.params)
    return res.json(await abortDirectS3Upload(req.user!.id, sessionId))
  } catch (error) {
    return next(error)
  }
})
