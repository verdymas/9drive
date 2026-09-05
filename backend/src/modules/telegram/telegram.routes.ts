import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { startTelegramAuth, verifyTelegramAuth, getOwnedTelegramAccount } from './telegram-auth.service.js'
import { getTelegramConfig, testTelegramConnection } from './telegram.service.js'
import { createTelegramStorageChannel, listTelegramStorageChannels, selectTelegramStorageChannel } from './telegram-channel.service.js'
import { indexTelegramAccount } from './telegram-index.service.js'
import { ingestTelegramAccount } from './telegram-ingest.service.js'
import { updateTelegramDocumentCaption } from './telegram-caption.service.js'
import { logicalPathForFileId } from '../files/file-logical-path.js'

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
  z.object({ action: z.literal('select'), channelId: z.string().trim().min(1), transfer: z.boolean().optional() }),
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
      : await selectTelegramStorageChannel(req.user!.id, config, { channelId: body.channelId, ...(body.transfer ? { transfer: true } : {}) })

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

/**
 * Index/recover: scan the channel and import unknown documents. Uses
 * caption-driven reconciliation so documents carrying `9drive:id=…` /
 * `9drive:path=…` are routed into the logical filesystem rather than the
 * inbox. Documents without metadata land in the "Recovered from Telegram"
 * inbox folder (preserves the legacy safety net).
 */
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

/**
 * Caption-driven ingest (logical-filesystem aware).
 *
 * Unlike `index` (which is the cheap legacy recovery path), `import` reads
 * each document's caption and reconciles by 9Drive identity:
 *   - `9drive:id=<stableId>` updates the matching `File` row by logical id,
 *     renaming/moving the row to the new logical path.
 *   - `9drive:path=<logicalPath>` reconciles by physical `providerFileId`,
 *     creating missing folders along the way.
 *   - Documents with no metadata are routed to the inbox.
 *
 * Idempotent: re-running with the same channel state yields no DB writes.
 */
telegramRouter.post('/accounts/:accountId/import', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.accountId)
    const body = z.object({ limit: z.number().int().positive().max(10000).optional() }).parse(req.body ?? {})
    const result = await ingestTelegramAccount(req.user!.id, accountId, body.limit)
    return res.json(result)
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

/**
 * Refresh the Telegram caption of a single file from its current logical
 * path (resolved by default, optionally overridden). No-op when the
 * existing caption already matches. Errors when the file is not on a
 * Telegram account or has no stable id.
 */
telegramRouter.post('/files/:fileId/sync-caption', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.fileId)
    const body = z.object({ path: z.string().trim().max(1024).nullable().optional() }).parse(req.body ?? {})
    const file = await prisma.file.findFirst({
      where: { id: fileId, userId: req.user!.id },
      select: { id: true, provider: true, connectedAccountId: true, telegramStableId: true },
    })
    if (!file) return res.status(404).json({ code: 'FILE_NOT_FOUND', message: 'File not found.' })
    if (file.provider !== 'telegram') {
      return res.status(400).json({ code: 'UNSUPPORTED_PROVIDER', message: 'Only Telegram files carry 9Drive metadata in captions.' })
    }
    if (!file.telegramStableId) {
      return res.status(409).json({ code: 'TELEGRAM_STABLE_ID_MISSING', message: 'This Telegram file has no stable id yet — re-upload via the Telegram flow stamps it.' })
    }
    const logicalPath = body.path === undefined ? await logicalPathForFileId(req.user!.id, fileId) : body.path
    const config = await getTelegramConfig(file.connectedAccountId, req.user!.id)
    const result = await updateTelegramDocumentCaption(req.user!.id, { id: file.id, name: '', telegramStableId: file.telegramStableId }, config, logicalPath)
    return res.json(result)
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})