import '../remote-fetch-workers/index.js'
import { Worker, type Job } from 'bullmq'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import type { RemoteImportJobData } from './queue.js'
import { processRemoteImportJob } from './processor.js'

/**
 * Per-user concurrency gate.
 *
 * BullMQ's `concurrency` option limits total parallel jobs across all users.
 * The product requirement is a per-user cap as well, so each user may only
 * have `REMOTE_IMPORT_PER_USER_CONCURRENCY` jobs actively processing. Jobs
 * that exceed the cap are moved back to the waiting state with an internal
 * delay (this worker re-processes them after a short backoff).
 */
const activePerUser = new Map<string, number>()
const perUserGate = env.REMOTE_IMPORT_PER_USER_CONCURRENCY

function acquirePerUserSlot(userId: string): boolean {
  const current = activePerUser.get(userId) ?? 0
  if (current >= perUserGate) return false
  activePerUser.set(userId, current + 1)
  return true
}

function releasePerUserSlot(userId: string) {
  const current = activePerUser.get(userId) ?? 0
  if (current <= 1) activePerUser.delete(userId)
  else activePerUser.set(userId, current - 1)
}

export function createRemoteImportWorker(): Worker<RemoteImportJobData> {
  const worker = new Worker<RemoteImportJobData>('remote-imports', async (job: Job<RemoteImportJobData>) => {
    const importId = job.data.importId
    const remoteImport = await prisma.remoteImport.findUnique({ where: { id: importId } })
    if (!remoteImport) return
    const userId = remoteImport.userId

    // Per-user concurrency gate: re-delay rather than queue-jump. The DB row
    // stays `queued` here — nothing visible to the user changes while the job
    // waits for a slot.
    if (!acquirePerUserSlot(userId)) {
      throw new (await import('bullmq')).DelayedError()
    }
    try {
      // The moment the worker actually begins this execution, persist an
      // explicit started transition (§31) — status processing + startedAt +
      // heartbeatAt — BEFORE any expensive work, so a retry picked up by the
      // worker never stays visible as `queued`.
      await prisma.remoteImport.update({
        where: { id: importId },
        data: { status: 'processing', startedAt: new Date(), heartbeatAt: new Date(), jobId: job.id },
      }).catch((err) => {
        // A DB blip here must not silently drop the job; surface it so the
        // processor's failure path finalizes the row.
        console.error('[remote-import] failed to mark execution started for', importId, err instanceof Error ? err.message : String(err))
      })
      await processRemoteImportJob(job)
    } finally {
      releasePerUserSlot(userId)
    }
  }, {
    connection: { url: env.REDIS_URL },
    concurrency: env.REMOTE_IMPORT_GLOBAL_CONCURRENCY,
  })

  worker.on('failed', (job, err) => {
    const reason = err?.message || String(err)
    console.error(`[remote-import] job ${job?.id} failed: ${reason}`)
    // The domain status is finalized inside the processor (for terminal
    // errors) or by the API's retry/cancel endpoints. This listener only logs
    // BullMQ-level failures so we never double-finalize a job.
  })

  worker.on('stalled', (jobId) => {
    // A stalled job means BullMQ lost the lock (process crash mid-job). BullMQ
    // will retry up to `maxStalledCount`; the reconciliation sweep catches rows
    // that stay processing without a fresh heartbeat (§37).
    console.error(`[remote-import] job ${jobId} stalled — worker lock was not renewed`)
  })

  worker.on('error', (err) => {
    console.error('[remote-import] worker error:', err)
  })

  return worker
}

let shutdownHandler: (() => Promise<void>) | null = null

/**
 * Start the worker and register a graceful shutdown hook. The worker is
 * closed on SIGINT/SIGTERM so in-flight jobs can settle before the process
 * exits (Redis-backed jobs are safe to resume).
 */
export function startRemoteImportWorker() {
  const worker = createRemoteImportWorker()
  console.log(`[remote-import] worker started queue=remote-imports concurrency=${worker.concurrency}`)
  const shutdown = async () => {
    console.log('[remote-import] shutting down worker...')
    await worker.close()
    await prisma.$disconnect()
  }
  shutdownHandler = shutdown
  const signalHandler = () => {
    void shutdown().then(() => process.exit(0)).catch((err) => {
      console.error('[remote-import] shutdown failed:', err)
      process.exit(1)
    })
  }
  process.once('SIGINT', signalHandler)
  process.once('SIGTERM', signalHandler)
  return worker
}