import { Queue } from 'bullmq'
import { env } from '../../config/env.js'

/**
 * BullMQ queue for Remote Import jobs.
 *
 * The API process enqueues jobs; the dedicated remote-import-worker process
 * consumes them. Jobs are persisted in Redis so a worker crash does not lose
 * work: a job that fails mid-run is retried with `attempts` from env.
 */
const QUEUE_NAME = 'remote-imports'
const JOB_NAME = 'import'

export const remoteImportQueue = new Queue<RemoteImportJobData>(QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: env.REMOTE_IMPORT_DOWNLOAD_ATTEMPTS,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
})

export type RemoteImportJobData = {
  /** Prisma `remote_imports.id` — the domain record that drives progress. */
  importId: string
  /** Monotonic attempt counter; bumped by retry() so the worker can detect it. */
  attempt: number
}

/**
 * Enqueue a fresh Remote Import job for `importId`. Idempotent per row:
 * duplicate calls return the existing jobId without creating a second job.
 */
export async function enqueueRemoteImport(importId: string): Promise<string> {
  const data: RemoteImportJobData = { importId, attempt: 1 }
  const existing = await remoteImportQueue.getJob(importId)
  if (existing) return existing.id ?? importId
  const job = await remoteImportQueue.add(JOB_NAME, data, {
    jobId: importId,
    attempts: env.REMOTE_IMPORT_DOWNLOAD_ATTEMPTS,
    backoff: { type: 'exponential', delay: 5_000 },
  })
  return job.id ?? importId
}

/** Remove a job from the queue entirely (cancel). Returns true if it existed. */
export async function removeRemoteImportJob(importId: string): Promise<boolean> {
  const existing = await remoteImportQueue.getJob(importId)
  if (!existing) return false
  await existing.remove()
  return true
}

/** Gracefully close the producer connection (used on API shutdown). */
export async function closeRemoteImportQueue() {
  await remoteImportQueue.close()
}
