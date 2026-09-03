import { Worker, type Job } from 'bullmq'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { type TelegramSyncJobData } from './telegram-sync.queue.js'
import { runTelegramSync } from './telegram-sync.service.js'

const QUEUE_NAME = 'telegram-sync'

/**
 * Telegram Sync worker — consumes the `telegram-sync` queue and calls
 * `runTelegramSync`. Single-flight guard is enforced by the service
 * (atomic UPDATE on `TelegramSyncState.status`); the worker simply
 * forwards the AppError so BullMQ can retry on transient failures.
 *
 * The worker is registered in the API process alongside the queue;
 * Telegram sync is metadata-only (no file downloads) and runs at a
 * low cadence, so a dedicated worker process would be overkill.
 */

let workerInstance: Worker<TelegramSyncJobData> | null = null

export async function processTelegramSyncJob(job: Job<TelegramSyncJobData>) {
  const { accountId, trigger, full } = job.data
  // `userId` is implicit: the account row owns its userId; the service
  // resolves it and verifies ownership on every call.
  const account = await prisma.connectedAccount.findUnique({
    where: { id: accountId },
    select: { userId: true },
  })
  if (!account) {
    throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The Telegram storage account no longer exists.', 404)
  }
  return runTelegramSync(account.userId, accountId, { trigger, full })
}

export function startTelegramSyncWorker() {
  if (workerInstance) return workerInstance
  workerInstance = new Worker<TelegramSyncJobData>(
    QUEUE_NAME,
    async (job) => processTelegramSyncJob(job),
    { connection: { url: env.REDIS_URL }, concurrency: 1 },
  )
  workerInstance.on('failed', (job, error) => {
    console.error('[telegram-sync-worker]', JSON.stringify({
      event: 'telegram.sync.job_failed',
      jobId: job?.id,
      accountId: job?.data.accountId,
      errorCode: error instanceof AppError ? error.code : 'TELEGRAM_UNKNOWN_ERROR',
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    }))
  })
  workerInstance.on('completed', (job, result) => {
    console.info('[telegram-sync-worker]', JSON.stringify({
      event: 'telegram.sync.job_completed',
      jobId: job.id,
      accountId: job.data.accountId,
      scanned: result?.scannedCount ?? 0,
      imported: result?.importedCount ?? 0,
      missing: result?.missingCount ?? 0,
    }))
  })
  return workerInstance
}

export async function stopTelegramSyncWorker() {
  if (!workerInstance) return
  await workerInstance.close()
  workerInstance = null
}

export function getTelegramSyncWorker() {
  return workerInstance
}