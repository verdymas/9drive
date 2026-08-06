import { Router, type NextFunction, type Response } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { SambaService, type SambaOptions } from './samba.service.js'
import { assertValidUserName } from './smb-validation.js'

export type SmbModuleOptions = {
  sambaOptions?: SambaOptions
}

/**
 * REST API for the SMB manager.
 *
 * Every operation is gated by `requireAuth` (admin-equivalent dashboard access)
 * and delegates to the Samba service, which runs the real Samba command-line
 * tools with argument arrays — user input never reaches a shell.
 */

const nameField = z.string().trim().min(1).max(80)
const pathField = z.string().trim().min(1).max(4096)
const descriptionField = z.string().trim().max(255).default('')
const userListField = z.array(z.string().trim().min(1).max(64)).max(200).default([])
const hideFilesField = z.string().trim().max(255).default('')

const createShareSchema = z.object({
  name: nameField,
  path: pathField,
  description: descriptionField,
  readOnly: z.boolean().default(true),
  guestAccess: z.boolean().default(false),
  browsable: z.boolean().default(true),
  validUsers: userListField,
  validGroups: userListField,
  hideFiles: hideFilesField,
})

const updateShareSchema = createShareSchema.partial()

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(32),
  password: z.string().min(8).max(64),
})

const updateUserSchema = z
  .object({
    password: z.string().min(8).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.password !== undefined || value.enabled !== undefined, { message: 'At least one of password or enabled is required.' })

export function createSmbRouter(moduleOptions: SmbModuleOptions = {}): Router {
  const service = new SambaService(undefined, moduleOptions.sambaOptions)
  const router = Router()
  router.use(requireAuth)

  const handle = (fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<unknown>) => (req: AuthRequest, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }

  router.get(
    '/',
    handle(async (_req, res) => {
      const shares = await service.listShares()
      res.json({ shares })
    }),
  )

  router.post(
    '/',
    handle(async (req, res) => {
      const body = createShareSchema.parse(req.body)
      const share = await service.createShare(body)
      res.status(201).json({ share })
    }),
  )

  router.put(
    '/:id',
    handle(async (req, res) => {
      const body = updateShareSchema.parse(req.body)
      const share = await service.updateShare(String(req.params.id), body)
      res.json({ share })
    }),
  )

  router.delete(
    '/:id',
    handle(async (req, res) => {
      await service.deleteShare(String(req.params.id))
      res.json({ status: 'ok' })
    }),
  )

  router.post(
    '/reload',
    handle(async (_req, res) => {
      const result = await service.reload()
      if (!result.ok) {
        res.status(409).json({ code: 'SMB_RELOAD_FAILED', message: result.message })
        return
      }
      res.json({ status: 'ok', message: result.message })
    }),
  )

  router.get(
    '/status',
    handle(async (_req, res) => {
      const health = await service.status()
      let connectedUsers: number | null = null
      if (health.available && health.status !== 'config_error') {
        connectedUsers = await service.getConnectedUsers()
      }
      res.json({ ...health, connectedUsers })
    }),
  )

  router.get(
    '/users',
    handle(async (_req, res) => {
      const users = await service.listUsers()
      res.json({ users })
    }),
  )

  router.post(
    '/users',
    handle(async (req, res) => {
      const body = createUserSchema.parse(req.body)
      assertValidUserName(body.name)
      const user = await service.createUser(body.name, body.password)
      res.status(201).json({ user })
    }),
  )

  router.put(
    '/users/:id',
    handle(async (req, res) => {
      const body = updateUserSchema.parse(req.body)
      const user = await service.updateUser(String(req.params.id), body)
      res.json({ user })
    }),
  )

  router.delete(
    '/users/:id',
    handle(async (req, res) => {
      await service.deleteUser(String(req.params.id))
      res.json({ status: 'ok' })
    }),
  )

  router.use((error: unknown, _req: AuthRequest, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ code: error.code, message: error.message })
      return
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: error.issues[0]?.message ?? 'Invalid request.' })
      return
    }
    res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: error instanceof Error ? error.message : 'Internal server error' })
  })

  return router
}
