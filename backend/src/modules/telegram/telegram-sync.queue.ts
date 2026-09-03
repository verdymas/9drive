import { Queue } from 'bullmq'
import { env } from '../../config/env.js'

/**
 * BullMQ queue for Telegram Synchronization jobs.
 *
 * One job per (connectedAccountId, trigger) pair: the BullMQ job id is
 * `${accountId}` for manual triggers and `${accountId}~auto` for the
 * periodic sweep. The DB-level single-flight guard on
 * `TelegramSyncState.status = 'syncing'` is the authoritative
 * deduplication (spec §20) — this queue is the durable handoff between
 * the HTTP / scheduler path and the worker.
 *
 * The queue lives in the API process; the worker is registered in the
 * same process (sync is metadata-only, no file downloads).
 */
const QUEUE_NAME = 'telegram-sync'
const JOB_NAME = 'sync'

export type TelegramSyncJobData = {
  /** `ConnectedAccount.id` — the per-account sync target. */
  accountId: string
  /** Caller label — surfaces in audit logs. */
  trigger: 'manual' | 'auto' | 'recovery'
  /** When true, ignore the persisted `last_message_id` cursor. */
  full: boolean
}

export const telegramSyncQueue = new Queue<TelegramSyncJobData>(QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 200 },
  },
})

/**
 * Build the BullMQ job id for a per-account sync. `auto` and `manual`
 * triggers are distinct so a manual "Sync Now" can never be shadowed
 * by a concurrent sweep job. `recovery` shares the manual bucket
 * because the user explicitly triggered it via a review action.
 */
export function telegramSyncJobId(accountId: string, trigger: TelegramSyncJobData['trigger']): string {
  const bucket = trigger === 'auto' ? 'auto' : 'manual'
  return `${accountId}~${bucket}`
}

/**
 * Enqueue a Telegram sync for one account. Returns the existing job id
 * when a job for the same `(accountId, trigger)` is already queued
 * (BullMQ dedups on `jobId`), so the HTTP path can answer "Sync
 * Already Running" without racing the queue. Throws only on Redis
 * outage — caller decides whether to surface 503 or fall back to a
 * synchronous in-process run.
 */
export async function enqueueTelegramSync(input: TelegramSyncJobData): Promise<{ jobId: string; queued: boolean }> {
  const jobId = telegramSyncJobId(input.accountId, input.trigger)
  const existing = await telegramSyncQueue.getJob(jobId)
  if (existing) return { jobId, queued: false }

  const job = await telegramSyncQueue.add(JOB_NAME, input, { jobId })
  return { jobId: job.id ?? jobId, queued: true }
}

/** Load the live job for a (accountId, trigger) — null when the job
 *  has been removed or the queue has lost it. */
export async function getTelegramSyncJob(accountId: string, trigger: TelegramSyncJobData['trigger']) {
  return telegramSyncQueue.getJob(telegramSyncJobId(accountId, trigger))
}

/** Remove a queued job. Returns true when the job existed. */
export async function removeTelegramSyncJob(accountId: string, trigger: TelegramSyncJobData['trigger']): Promise<boolean> {
  const job = await telegramSyncQueue.getJob(telegramSyncJobId(accountId, trigger))
  if (!job) return false
  await job.remove()
  return true
}

/** Graceful shutdown — flush the queue's producer connection. */
export async function closeTelegramSyncQueue() {
  await telegramSyncQueue.close()
}