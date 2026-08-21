import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import {
  createWorker,
  deleteWorker,
  disableWorker,
  enableWorker,
  forceDeleteWorkerLocal,
  getWorker,
  listWorkers,
  serializeWorker,
  setDefaultWorker,
  testWorkerConnection,
  updateWorker,
} from './workers.service.js'
import { listDriverMetadata } from './workers.driver-metadata.js'

export const remoteFetchWorkerRouter = Router()

const workerSchema = z
  .object({
    // Managed drivers derive the display name from config.workerName; manual
    // drivers (future self-hosted relays) supply it directly.
    name: z.string().min(1).max(191).optional(),
    slug: z.string().max(191).nullable().optional(),
    driver: z.string().min(1).max(64),
    // Manual drivers only — managed drivers reject a user-supplied endpoint.
    endpointUrl: z.string().min(1).max(4096).optional(),
    authType: z.enum(['hmac', 'bearer', 'none']).optional(),
    // Blank secret = keep existing (update only); absent = don't touch.
    secret: z.string().max(4096).nullable().optional(),
    // Managed drivers: provider registration fields (e.g. accountId/apiToken/workerName).
    config: z.record(z.string(), z.string()).nullable().optional(),
    region: z.string().max(64).nullable().optional(),
    description: z.string().max(4096).nullable().optional(),
    priority: z.number().int().min(0).max(100000).nullable().optional(),
    isEnabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()

/**
 * Worker CRUD + operations. Authenticated (requireAuth — there is no RBAC in
 * 9Drive; every dashboard action is user-gated, see SMB dashboard).
 * Literal routes (`/drivers`) registered before `/:id` so they never match
 * as a record id.
 */
remoteFetchWorkerRouter.get('/drivers', requireAuth, async (_req: AuthRequest, res, next) => {
  try {
    return res.json({ drivers: listDriverMetadata() })
  } catch (error) {
    return next(error)
  }
})

remoteFetchWorkerRouter.get('/', requireAuth, async (_req: AuthRequest, res, next) => {
  try {
    const rows = await listWorkers()
    return res.json({ items: rows.map(serializeWorker) })
  } catch (error) {
    return next(error)
  }
})

remoteFetchWorkerRouter.post('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = workerSchema.parse(req.body)
    const created = await createWorker(req.user!.id, {
      name: body.name,
      slug: body.slug,
      driver: body.driver,
      endpointUrl: body.endpointUrl,
      authType: body.authType,
      secret: body.secret ?? null,
      config: body.config,
      region: body.region ?? null,
      description: body.description ?? null,
      priority: body.priority ?? null,
      isEnabled: body.isEnabled,
      isDefault: body.isDefault,
    })
    return res.status(201).json(serializeWorker(created))
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) {
      const correlationId = (error as any).correlationId ?? (error as any).cause?.correlationId
      const payload: Record<string, unknown> = { code: error.code, message: error.message }
      if (correlationId) payload.correlationId = correlationId
      return res.status(error.status).json(payload)
    }
    return next(error)
  }
})

remoteFetchWorkerRouter.get('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await getWorker(String(req.params.id))
    return res.json(serializeWorker(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteFetchWorkerRouter.patch('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = workerSchema.partial().parse(req.body)
    const updated = await updateWorker(req.user!.id, String(req.params.id), {
      name: body.name,
      slug: body.slug,
      driver: body.driver,
      endpointUrl: body.endpointUrl,
      authType: body.authType,
      secret: body.secret,
      config: body.config,
      region: body.region,
      description: body.description,
      priority: body.priority,
      isEnabled: body.isEnabled,
      isDefault: body.isDefault,
    })
    return res.json(serializeWorker(updated))
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteFetchWorkerRouter.delete('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await deleteWorker(req.user!.id, String(req.params.id))
    return res.status(204).end()
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

/**
 * Admin fallback — delete the LOCAL record only, never the provider resource.
 * Explicitly confirmed (`confirm: true`) and audited as
 * `worker.force_deleted_local`; the response warns the remote relay may remain.
 * Never reached automatically: the normal DELETE flow fails with
 * WORKER_DEPROVISION_FAILED instead of falling back here.
 */
remoteFetchWorkerRouter.post('/:id/force-delete', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ confirm: z.literal(true) }).parse(req.body ?? {})
    await forceDeleteWorkerLocal(req.user!.id, String(req.params.id))
    return res.json({
      message: 'Local record deleted. The remote provider resource may still exist — delete it at the provider if needed.',
      confirm: body.confirm,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Explicit confirmation is required to delete the local record only.' })
    }
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteFetchWorkerRouter.post('/:id/test', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const result = await testWorkerConnection(req.user!.id, String(req.params.id))
    return res.json({ result })
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteFetchWorkerRouter.post('/:id/enable', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await enableWorker(req.user!.id, String(req.params.id))
    return res.json(serializeWorker(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteFetchWorkerRouter.post('/:id/disable', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await disableWorker(req.user!.id, String(req.params.id))
    return res.json(serializeWorker(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteFetchWorkerRouter.post('/:id/set-default', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await setDefaultWorker(req.user!.id, String(req.params.id))
    return res.json(serializeWorker(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})