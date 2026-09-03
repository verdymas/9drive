import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { startTelegramAuth, verifyTelegramAuth, getOwnedTelegramAccount } from './telegram-auth.service.js'
import { getTelegramConfig, testTelegramConnection } from './telegram.service.js'
import { createTelegramStorageChannel, listTelegramStorageChannels, selectTelegramStorageChannel } from './telegram-channel.service.js'
import { indexTelegramAccount } from './telegram-index.service.js'

export const telegramRouter = Router()

const authStartSchema = z.object({
  accountId: z.string().min(1).optional(),
  phone: z.string().trim().min(1),
  apiId: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(),
  apiHash: z.string().trim().min(1).optional(),
})

const authVerifySchema = z.object({
  authId: z.string().min(1),
  code: z.string().trim().optional(),
  password: z.string().optional(),
})

const channelActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), title: z.string().trim().min(1).max(191).optional() }),
  z.object({ action: z.literal('select'), channelId: z.string().trim().min(1) }),
])

telegramRouter.post('/auth/start', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = authStartSchema.parse(req.body)
    const result = await startTelegramAuth({
      userId: req.user!.id,
      accountId: body.accountId,
      phone: body.phone,
      apiId: body.apiId === undefined ? undefined : Number(body.apiId),
      apiHash: body.apiHash,
    })
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

telegramRouter.post('/auth/verify', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = authVerifySchema.parse(req.body)
    const { authId, code, password } = body
    const result = await verifyTelegramAuth(req.user!.id, authId, { code, password })
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

/**
 * List the account's dialogs that are usable private-storage channel
 * candidates (broadcast channels only — never Saved Messages, personal chats,
 * or groups). Populates the "Use existing private channel" picker.
 */
telegramRouter.get('/accounts/:accountId/channels', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.accountId)
    await getOwnedTelegramAccount(req.user!.id, accountId)
    const config = await getTelegramConfig(accountId, req.user!.id)
    const result = await listTelegramStorageChannels(config)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

/**
 * Configure the storage channel for an account: create a new private channel
 * or use an existing one. The channel is capability-probed (read/write/delete)
 * before it is persisted; this endpoint doubles as "Change Channel".
 */
telegramRouter.post('/accounts/:accountId/channel', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.accountId)
    const body = channelActionSchema.parse(req.body)
    await getOwnedTelegramAccount(req.user!.id, accountId)
    const config = await getTelegramConfig(accountId, req.user!.id)

    const result = body.action === 'create'
      ? await createTelegramStorageChannel(req.user!.id, config, { title: body.title })
      : await selectTelegramStorageChannel(req.user!.id, config, { channelId: body.channelId })

    return res.json(result)
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

/** Test a saved Telegram connection (account auth + storage channel capabilities). */
telegramRouter.post('/accounts/:accountId/test', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.accountId)
    await getOwnedTelegramAccount(req.user!.id, accountId)
    const config = await getTelegramConfig(accountId, req.user!.id)
    const result = await testTelegramConnection(config)
    await createAuditLog(req.user!.id, 'telegram.test', 'connected_account', accountId, { ok: result.ok, status: result.status })
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

/** Index/recover: scan the channel and import unknown documents. */
telegramRouter.post('/accounts/:accountId/index', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.accountId)
    const result = await indexTelegramAccount(req.user!.id, accountId)
    return res.json(result)
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})
