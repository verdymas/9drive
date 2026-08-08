import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { runSyncAll, runAccountSync, cancelAccountSync } from './sync.service.js'
import { listRecentSyncRuns } from './sync-run.service.js'

/**
 * Sync routes.
 *
 * POST /sync/all           — sync every connected account (bounded concurrency)
 * POST /sync/account/:id   — sync one account
 * GET  /sync/runs?limit=   — recent SyncRun history for the UI
 *
 * All sync is synchronous: the response carries per-account results and the
 * frontend refreshes All Files after it returns. A queued/background Sync All
 * is a documented future follow-up (spec §20).
 */
export const syncRouter = Router()

syncRouter.use(requireAuth)

syncRouter.post('/all', async (req: AuthRequest, res, next) => {
  try {
    const { results } = await runSyncAll(req.user!.id)
    return res.json({ status: 'ok', results })
  } catch (error) {
    return next(error)
  }
})

syncRouter.post('/account/:id', async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const result = await runAccountSync(req.user!.id, accountId)
    return res.json({ status: result.status, result })
  } catch (error) {
    return next(error)
  }
})

syncRouter.post('/account/:id/cancel', async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    cancelAccountSync(accountId)
    return res.json({ status: 'cancelling' })
  } catch (error) {
    return next(error)
  }
})

syncRouter.get('/runs', async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 10), 50)
    const runs = await listRecentSyncRuns(req.user!.id, limit)
    return res.json({ runs })
  } catch (error) {
    return next(error)
  }
})