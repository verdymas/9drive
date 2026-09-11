import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { directS3UploadRouter } from './direct-s3-upload.routes.js'
import { logUpload } from './upload-logging.js'
import { processMultipartUpload } from './multipart-upload.service.js'
import {
  getResumableStatus,
  initResumableUpload,
  preflightResumableUpload,
  uploadResumableChunk,
} from './resumable-upload.service.js'

export const uploadRouter = Router()
uploadRouter.use('/direct-s3', directS3UploadRouter)

/**
 * Compatibility entry point used by both the dashboard route and the public
 * API. Parsing and provider work live in multipart-upload.service.ts; this
 * wrapper only performs HTTP validation and response translation.
 */
export async function handleUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    logUpload('request started', { userId: req.user!.id, mode: 'multipart', contentLength: req.headers['content-length'] })
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })
    const result = await processMultipartUpload(req, req.user!.id, res)
    if (!result) return
    return res.status(result.status).json(result.body)
  } catch (error) {
    return next(error)
  }
}

type ResumableHandler = (req: AuthRequest) => Promise<{ status: number; body: Record<string, unknown> }>

function resumableRoute(handler: ResumableHandler) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await handler(req)
      return res.status(result.status).json(result.body)
    } catch (error) {
      return next(error)
    }
  }
}

uploadRouter.post('/', requireAuth, handleUpload)
uploadRouter.post('/resumable/init', requireAuth, resumableRoute(initResumableUpload))
uploadRouter.post('/resumable/preflight', requireAuth, resumableRoute(preflightResumableUpload))
uploadRouter.get('/resumable/status/:id', requireAuth, resumableRoute(getResumableStatus))
uploadRouter.put('/resumable/chunk/:id', requireAuth, resumableRoute(uploadResumableChunk))
