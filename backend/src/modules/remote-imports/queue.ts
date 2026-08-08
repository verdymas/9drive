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
 * Build the deterministic BullMQ job id for a given execution of an import.
 * One job per (importId, attempt): a retry enqueues a new job with the next
 * attempt, so a stale failed job can never shadow a fresh execution (which the
 * old `jobId: importId` scheme did, leaving retries stuck in `queued`).
 */
export function remoteImportJobId(importId: string, attempt: number): string {
  return `${importId}:${attempt}`
}

/**
 * Enqueue a Remote Import execution. Every call creates a distinct job keyed
 * by (importId, attempt); the DB row's status is the single-flight guard, not
 * a Redis lookup, so duplicates cannot silently skip enqueueing.
 */
export async function enqueueRemoteImport(
  importId: string,
  attempt: number,
): Promise<string> {
  const data: RemoteImportJobData = { importId, attempt }
  const jobId = remoteImportJobId(importId, attempt)
  const job = await remoteImportQueue.add(JOB_NAME, data, {
    jobId,
    attempts: env.REMOTE_IMPORT_DOWNLOAD_ATTEMPTS,
    backoff: { type: 'exponential', delay: 5_000 },
  })
  return job.id ?? jobId
}

/** Remove a job for a specific execution (cancel). Returns true if it existed. */
export async function removeRemoteImportJob(
  importId: string,
  attempt: number,
): Promise<boolean> {
  const job = await remoteImportQueue.getJob(remoteImportJobId(importId, attempt))
  if (!job) return false
  await job.remove()
  return true
}

/**
 * Load the BullMQ job for a specific execution, or null when it is missing
 * (used by the reconciliation sweep to distinguish "waiting" from "lost").
 */
export async function getRemoteImportJob(
  importId: string,
  attempt: number,
) {
  return remoteImportQueue.getJob(remoteImportJobId(importId, attempt))
}

/** Load a BullMQ job by its raw stored id (row.jobId). Returns null when gone. */
export async function getJobById(jobId: string) {
  return remoteImportQueue.getJob(jobId)
}

/**
 * Resolve a stored row to its execution job, tolerating legacy rows whose
 * `jobId` was just the import id (pre-fix) instead of `${id}:${attempt}`.
 */
export async function resolveJobForRow(row: { jobId: string | null; id: string; attempt: number }) {
  if (row.jobId) {
    const job = await remoteImportQueue.getJob(row.jobId)
    if (job) return job
  }
  return remoteImportQueue.getJob(remoteImportJobId(row.id, Math.max(row.attempt, 1)))
}

/** Gracefully close the producer connection (used on API shutdown). */
export async function closeRemoteImportQueue() {
  await remoteImportQueue.close()
}

/**
 * Safe Remote Import health probe for the `/health` endpoint (§42).
 *
 * The queue producer lives in the API process and the worker in a separate
 * process, so a single round-trip against Redis (`getWorkersCount` → CLIENT
 * LIST) asserts both that the queue is reachable and whether a worker is
 * currently connected. `worker: "unknown"` covers environments where the
 * CLIENT LIST query is unsupported (e.g. GCP) or where no worker happens to
 * be connected right now — that is a soft signal, never a hard failure. Never
 * throws: a Redis outage yields `{ redis: "down", worker: "unknown" }` instead
 * of breaking the health endpoint, and no sensitive Redis details are exposed.
 */
export async function remoteImportQueueHealth(): Promise<{ redis: 'ok' | 'down'; worker: 'ok' | 'unknown' }> {
  try {
    const workers = await remoteImportQueue.getWorkersCount()
    return { redis: 'ok', worker: workers > 0 ? 'ok' : 'unknown' }
  } catch {
    return { redis: 'down', worker: 'unknown' }
  }
}