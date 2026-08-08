import type { Job } from 'bullmq'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { getJobById } from './queue.js'

/**
 * Reconciliation sweep for Remote Import queue state (§35).
 *
 * A queued row must not stay ambiguous forever. Separately, a `processing`
 * row whose worker died (crash, OOM, lost BullMQ lock) must be finalised even
 * though no processor is around to do it.
 *
 * Runs on the worker process (started from `worker-entry.ts`) on an interval.
 * Every write is a CAS (`updateMany` filtered on the current status+stage) so
 * a live transition racing the sweep is never clobbered. Redis being down is
 * silently tolerated: with no queue state to check we simply skip.
 */

const QUEUE_START_TIMEOUT_MS = env.REMOTE_IMPORT_QUEUE_START_TIMEOUT_SECONDS * 1000
const HEARTBEAT_TIMEOUT_MS = env.REMOTE_IMPORT_WORKER_HEARTBEAT_TIMEOUT_SECONDS * 1000

type Row = {
  id: string
  status: string
  stage: string
  jobId: string | null
  attempt: number
  queuedAt: Date | null
  heartbeatAt: Date | null
  fileName: string
}

/** CAS-fail a row from its current (status, stage); returns true when changed. */
async function failRow(row: Row, code: string, message: string): Promise<boolean> {
  try {
    const updated = await prisma.remoteImport.updateMany({
      where: { id: row.id, status: row.status, stage: row.stage },
      data: {
        status: 'failed',
        stage: 'finished',
        errorCode: code,
        errorMessage: message,
        failedAt: new Date(),
      },
    })
    return updated.count === 1
  } catch {
    return false
  }
}

/**
 * Reconcile one `queued` row against its BullMQ job. Returns the action taken
 * (used by tests and the sweep). Redis down → `skipped`.
 */
export async function reconcileQueuedRow(row: Row): Promise<'failed-missing' | 'failed' | 'processing' | 'kept' | 'completed' | 'skipped'> {
  let job: Job | null | undefined
  try {
    // Resolve the execution job, tolerating legacy rows whose jobId is just
    // the bare import id (pre-fix format) instead of `${id}:${attempt}`.
    job = await getJobById(row.jobId ?? `${row.id}:${Math.max(row.attempt, 1)}`)
  } catch {
    // Redis unreachable — can't verify anything; leave the row alone.
    return 'skipped'
  }
  if (job == null) {
    await failRow(row, 'REMOTE_IMPORT_QUEUE_JOB_MISSING', 'The queued execution was lost from the queue; please retry.')
    return 'failed-missing'
  }

  let state: string
  try {
    state = await job.getState()
  } catch {
    return 'skipped'
  }

  switch (state) {
    case 'active':
      // The worker is handling it: mirror to processing so the UI stops
      // showing `queued` (§36: active → ensure processing).
      await prisma.remoteImport
        .updateMany({
          where: { id: row.id, status: 'queued' },
          data: { status: 'processing', heartbeatAt: new Date(), jobId: job.id ?? row.jobId },
        })
        .catch(() => undefined)
      return 'processing'
    case 'waiting':
    case 'delayed':
      // Legitimately waiting behind other work — keep queued (a timeout must
      // never blind-fail a legitimately waiting job).
      return 'kept'
    case 'failed':
      await failRow(row, 'REMOTE_IMPORT_QUEUE_JOB_FAILED', 'The queued execution failed before the worker started.')
      return 'failed'
    case 'completed':
      // Job completed but the DB was never finalised (crash between the
      // worker finishing and the final write) — mirror completed.
      await prisma.remoteImport
        .updateMany({
          where: { id: row.id, status: 'queued' },
          data: { status: 'completed', stage: 'finished', completedAt: new Date() },
        })
        .catch(() => undefined)
      return 'completed'
    case 'unknown':
    default:
      return 'skipped'
  }
}

const rowSelect = {
  id: true,
  status: true,
  stage: true,
  jobId: true,
  attempt: true,
  queuedAt: true,
  heartbeatAt: true,
  fileName: true,
} as const

/**
 * Run one full sweep pass over the `queued` and `processing` rows that are
 * due for reconciliation. Returns a compact summary line. Never throws.
 */
export async function runReconcileSweep(now = Date.now()): Promise<string> {
  const summary: string[] = []
  try {
    const queuedCutoff = new Date(now - QUEUE_START_TIMEOUT_MS)
    const queuedRows = await prisma.remoteImport.findMany({
      where: { status: 'queued' },
      select: rowSelect,
    })
    for (const row of queuedRows) {
      // Only rows queued longer than the start timeout are candidates; a
      // fresh enqueue is never touched.
      if (row.queuedAt == null || row.queuedAt.getTime() > queuedCutoff.getTime()) continue
      const action = await reconcileQueuedRow(row as unknown as Row)
      if (action !== 'kept' && action !== 'skipped') summary.push(`${action}:${row.id.slice(0, 8)}`)
    }

    const heartbeatCutoff = new Date(now - HEARTBEAT_TIMEOUT_MS)
    const processingRows = await prisma.remoteImport.findMany({
      where: { status: 'processing', heartbeatAt: { lt: heartbeatCutoff } },
      orderBy: { heartbeatAt: 'desc' },
      select: rowSelect,
    })
    for (const row of processingRows) {
      const failed = await failStalledProcessing(row as unknown as Row, now)
      if (failed) summary.push(`stalled:${row.id.slice(0, 8)}`)
    }
  } catch (error) {
    // The sweep must never take the worker down (e.g. DB briefly unavailable).
    console.error('[remote-import] reconcile sweep failed:', error instanceof Error ? error.message : String(error))
  }
  return summary.join(', ')
}

/**
 * A `processing` row whose heartbeat is stale means the worker died without a
 * graceful failure. Fail it with a stable error so the user can retry (§37).
 */
export async function failStalledProcessing(row: Row, now = Date.now()): Promise<boolean> {
  if (row.heartbeatAt == null || now - row.heartbeatAt.getTime() >= HEARTBEAT_TIMEOUT_MS) {
    return failRow(row, 'REMOTE_IMPORT_WORKER_STALLED', 'The worker stopped responding; please retry.')
  }
  return false
}

/** Start the periodic sweep in the worker process. Returns the timer. */
export function startReconcileSweep(intervalMs = 60_000) {
  const timer = setInterval(() => {
    void runReconcileSweep().then((summary) => {
      if (summary) console.log(`[remote-import] reconcile sweep: ${summary}`)
    })
  }, intervalMs)
  timer.unref()
  return timer
}