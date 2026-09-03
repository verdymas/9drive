import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { getOwnedTelegramAccount } from './telegram-auth.service.js'
import {
  TELEGRAM_SYNC_ISSUE_KINDS,
  TELEGRAM_SYNC_STATUSES,
} from './telegram-sync.service.js'
import { enqueueTelegramSync, getTelegramSyncJob } from './telegram-sync.queue.js'

/**
 * Helper: a tuple of valid `kind` values for zod's `z.enum`.
 * `TELEGRAM_SYNC_ISSUE_KINDS` is a readonly tuple; z.enum needs a
 * mutable [string, ...string[]].
 */
const TELEGRAM_SYNC_ISSUE_KANDS_FOR_ZOD: [string, ...string[]] = [
  TELEGRAM_SYNC_ISSUE_KINDS[0],
  ...TELEGRAM_SYNC_ISSUE_KINDS.slice(1),
]

/**
 * HTTP surface for Telegram Synchronization.
 *
 * All endpoints require authentication. The sync itself runs in the
 * BullMQ worker process; the HTTP surface enqueues a job and returns
 * the job id for the UI to poll (status, runs, issues).
 *
 * Routes:
 *   POST /telegram/sync                                          — Sync Now
 *   GET  /telegram/sync/runs?accountId=&limit=                   — Run history
 *   GET  /telegram/accounts/:accountId/status                    — Status card
 *   GET  /telegram/accounts/:accountId/sync-issues?kind=&limit= — Review panel
 *   POST /telegram/sync-issues/:id/resolve                       — Mark resolved
 *   POST /telegram/sync-issues/bulk-resolve                      — Bulk resolve
 */
export const telegramSyncRouter = Router()
telegramSyncRouter.use(requireAuth)

const syncBodySchema = z.object({
  accountId: z.string().min(1),
  full: z.boolean().optional(),
})

telegramSyncRouter.post('/sync', async (req: AuthRequest, res, next) => {
  try {
    const body = syncBodySchema.parse(req.body)
    await getOwnedTelegramAccount(req.user!.id, body.accountId)
    const { jobId, queued } = await enqueueTelegramSync({
      accountId: body.accountId,
      trigger: 'manual',
      full: body.full === true,
    })
    return res.status(queued ? 202 : 200).json({
      status: queued ? 'queued' : 'already_queued',
      jobId,
      queued,
    })
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

telegramSyncRouter.get('/sync/runs', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({
      accountId: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(10),
    }).parse(req.query)

    const runs = await prisma.telegramSyncRun.findMany({
      where: {
        userId: req.user!.id,
        ...(query.accountId ? { connectedAccountId: query.accountId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    })
    return res.json({
      runs: runs.map((run) => ({
        id: run.id,
        accountId: run.connectedAccountId,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        scannedCount: run.scannedCount,
        matchedCount: run.matchedCount,
        importedCount: run.importedCount,
        missingCount: run.missingCount,
        orphanCount: run.orphanCount,
        conflictCount: run.conflictCount,
        errorCount: run.errorCount,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
        durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

telegramSyncRouter.get('/accounts/:accountId/status', async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.accountId)
    await getOwnedTelegramAccount(req.user!.id, accountId)

    const state = await prisma.telegramSyncState.findUnique({
      where: { connectedAccountId: accountId },
      select: { status: true, lastMessageId: true, lastScanAt: true, errorCode: true, errorMessage: true },
    })
    const lastRun = await prisma.telegramSyncRun.findFirst({
      where: { userId: req.user!.id, connectedAccountId: accountId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, startedAt: true, finishedAt: true, scannedCount: true, matchedCount: true, importedCount: true, missingCount: true, conflictCount: true, errorCount: true },
    })
    const openIssuesCount = await prisma.telegramSyncIssue.count({
      where: { userId: req.user!.id, connectedAccountId: accountId, resolvedAt: null },
    })

    const liveJob = await getTelegramSyncJob(accountId, 'manual').catch(() => null)

    return res.json({
      status: state?.status ?? 'never_synced',
      lastMessageId: state?.lastMessageId?.toString() ?? null,
      lastScanAt: state?.lastScanAt?.toISOString() ?? null,
      errorCode: state?.errorCode ?? null,
      errorMessage: state?.errorMessage ?? null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            startedAt: lastRun.startedAt.toISOString(),
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
            scannedCount: lastRun.scannedCount,
            matchedCount: lastRun.matchedCount,
            importedCount: lastRun.importedCount,
            missingCount: lastRun.missingCount,
            conflictCount: lastRun.conflictCount,
            errorCount: lastRun.errorCount,
          }
        : null,
      openIssuesCount,
      liveJobId: liveJob?.id ?? null,
      knownStatuses: TELEGRAM_SYNC_STATUSES,
    })
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

telegramSyncRouter.get('/accounts/:accountId/sync-issues', async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.accountId)
    await getOwnedTelegramAccount(req.user!.id, accountId)
    const query = z.object({
      kind: z.enum(TELEGRAM_SYNC_ISSUE_KANDS_FOR_ZOD).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query)

    const issues = await prisma.telegramSyncIssue.findMany({
      where: {
        userId: req.user!.id,
        connectedAccountId: accountId,
        resolvedAt: null,
        ...(query.kind ? { kind: query.kind } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take: query.limit,
    })
    return res.json({
      issues: issues.map((issue) => ({
        id: issue.id,
        kind: issue.kind,
        telegramFileId: issue.telegramFileId,
        fileId: issue.fileId,
        detectedAt: issue.detectedAt.toISOString(),
        metadata: issue.metadata,
      })),
    })
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

telegramSyncRouter.post('/sync-issues/:id/resolve', async (req: AuthRequest, res, next) => {
  try {
    const issueId = String(req.params.id)
    const issue = await prisma.telegramSyncIssue.findFirst({
      where: { id: issueId, userId: req.user!.id },
      select: { id: true, resolvedAt: true },
    })
    if (!issue) return res.status(404).json({ code: 'SYNC_ISSUE_NOT_FOUND', message: 'Sync issue not found.' })
    if (issue.resolvedAt) return res.json({ status: 'already_resolved', resolvedAt: issue.resolvedAt.toISOString() })

    const updated = await prisma.telegramSyncIssue.update({
      where: { id: issueId },
      data: { resolvedAt: new Date() },
      select: { id: true, resolvedAt: true },
    })
    return res.json({ status: 'resolved', resolvedAt: updated.resolvedAt?.toISOString() })
  } catch (error) {
    return next(error)
  }
})

const bulkResolveSchema = z.object({
  accountId: z.string().min(1),
  kind: z.enum(TELEGRAM_SYNC_ISSUE_KANDS_FOR_ZOD).optional(),
})

telegramSyncRouter.post('/sync-issues/bulk-resolve', async (req: AuthRequest, res, next) => {
  try {
    const body = bulkResolveSchema.parse(req.body)
    await getOwnedTelegramAccount(req.user!.id, body.accountId)
    const result = await prisma.telegramSyncIssue.updateMany({
      where: {
        userId: req.user!.id,
        connectedAccountId: body.accountId,
        resolvedAt: null,
        ...(body.kind ? { kind: body.kind } : {}),
      },
      data: { resolvedAt: new Date() },
    })
    return res.json({ status: 'ok', resolved: result.count })
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})