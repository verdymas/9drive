import { Queue } from 'bullmq'
import { env } from '../../config/env.js'

/**
 * BullMQ queue for Remote Import jobs.
 *
 * The API process enqueues jobs; the dedicated remote-import-worker process
 * consumes them. Jobs are persisted in Redis so a worker crash does not lose
 * work: a job that fails mid-run is retried with `attempts` from env.
 */
const DIRECT_QUEUE_NAME = 'remote-imports-direct'
const HLS_QUEUE_NAME = 'remote-imports-hls'
const JOB_NAME = 'import'

const queueOptions = {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: env.REMOTE_IMPORT_DOWNLOAD_ATTEMPTS,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
}

export const remoteImportDirectQueue = new Queue<RemoteImportJobData>(DIRECT_QUEUE_NAME, queueOptions)
export const remoteImportHlsQueue = new Queue<RemoteImportJobData>(HLS_QUEUE_NAME, queueOptions)
/** Legacy export retained for callers that only need the direct queue. */
export const remoteImportQueue = remoteImportDirectQueue

export type RemoteImportWorkload = 'direct' | 'hls'

export function workloadForRemoteImport(row: { sourceType?: string | null | undefined }): RemoteImportWorkload {
  return row.sourceType === 'hls_master' || row.sourceType === 'hls_media' ? 'hls' : 'direct'
}

function queueFor(workload: RemoteImportWorkload) {
  return workload === 'hls' ? remoteImportHlsQueue : remoteImportDirectQueue
}

function queuesForLookup(workload?: RemoteImportWorkload) {
  return workload ? [queueFor(workload)] : [remoteImportDirectQueue, remoteImportHlsQueue]
}

export type RemoteImportJobData = {
  /** Prisma `remote_imports.id` — the domain record that drives progress. */
  importId: string
  /** Monotonic attempt counter; bumped by retry() so the worker can detect it. */
  attempt: number
  /** Queue class; database sourceType remains the authoritative classifier. */
  workload: RemoteImportWorkload
}

/**
 * Build the deterministic BullMQ job id for a given execution of an import.
 * One job per (importId, attempt): a retry enqueues a new job with the next
 * attempt, so a stale failed job can never shadow a fresh execution (which the
 * old `jobId: importId` scheme did, leaving retries stuck in `queued`).
 *
 * The separator is `~`, NOT `:` — BullMQ v5 rejects custom job ids that
 * contain a colon (only the legacy repeatable-jobs `a:b:c` form is allowed),
 * so `${uuid}:${attempt}` made every enqueue throw "Custom Id cannot contain
 * :". `~` is URL/key-safe and can never appear in a UUID.
 */
export function remoteImportJobId(importId: string, attempt: number): string {
  return `${importId}~${attempt}`
}

/**
 * Enqueue a Remote Import execution. Every call creates a distinct job keyed
 * by (importId, attempt); the DB row's status is the single-flight guard, not
 * a Redis lookup, so duplicates cannot silently skip enqueueing.
 */
export async function enqueueRemoteImport(
  importId: string,
  attempt: number,
  workload: RemoteImportWorkload = 'direct',
): Promise<string> {
  const data: RemoteImportJobData = { importId, attempt, workload }
  const jobId = remoteImportJobId(importId, attempt)
  const job = await queueFor(workload).add(JOB_NAME, data, {
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
  workload?: RemoteImportWorkload,
): Promise<boolean> {
  const jobId = remoteImportJobId(importId, attempt)
  for (const queue of queuesForLookup(workload)) {
    const job = await queue.getJob(jobId)
    if (!job) continue
    await job.remove()
    return true
  }
  return false
}

/**
 * Load the BullMQ job for a specific execution, or null when it is missing
 * (used by the reconciliation sweep to distinguish "waiting" from "lost").
 */
export async function getRemoteImportJob(
  importId: string,
  attempt: number,
  workload?: RemoteImportWorkload,
) {
  const jobId = remoteImportJobId(importId, attempt)
  for (const queue of queuesForLookup(workload)) {
    const job = await queue.getJob(jobId)
    if (job) return job
  }
  return null
}

/** Load a BullMQ job by its raw stored id (row.jobId). Returns null when gone. */
export async function getJobById(jobId: string, workload?: RemoteImportWorkload) {
  for (const queue of queuesForLookup(workload)) {
    const job = await queue.getJob(jobId)
    if (job) return job
  }
  return null
}

/**
 * Resolve a stored row to its execution job, tolerating legacy rows whose
 * `jobId` was just the import id (pre-fix) instead of `${id}:${attempt}`.
 */
export async function resolveJobForRow(row: { jobId: string | null; id: string; attempt: number; sourceType?: string | null }) {
  const workload = workloadForRemoteImport(row)
  if (row.jobId) {
    const job = await getJobById(row.jobId, workload)
    if (job) return job
  }
  return getRemoteImportJob(row.id, Math.max(row.attempt, 1), workload)
}

/** Gracefully close the producer connection (used on API shutdown). */
export async function closeRemoteImportQueue() {
  await Promise.all([remoteImportDirectQueue.close(), remoteImportHlsQueue.close()])
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
    const workers = await Promise.all([remoteImportDirectQueue.getWorkersCount(), remoteImportHlsQueue.getWorkersCount()])
    return { redis: 'ok', worker: workers.some((count) => count > 0) ? 'ok' : 'unknown' }
  } catch {
    return { redis: 'down', worker: 'unknown' }
  }
}
