import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { enqueueTelegramSync } from './telegram-sync.queue.js'

/**
 * Telegram Sync scheduler — periodic sweep.
 *
 * Every `TELEGRAM_SYNC_INTERVAL_MINUTES` (default 30, range 15–720),
 * scans connected Telegram accounts and enqueues a sync for each one
 * that is due (last scan older than the interval, or never_synced).
 * Disabled when `TELEGRAM_SYNC_AUTO_ENABLED=false`.
 *
 * The sweeper is `unref()`'d so it never holds the process open; it
 * is bounded to one in-flight iteration via a module-level flag so
 * overlapping ticks never enqueue duplicate jobs.
 */

let timer: NodeJS.Timeout | null = null
let inFlight = false

function intervalMs(): number {
  const minutes = Math.max(15, Math.min(env.TELEGRAM_SYNC_INTERVAL_MINUTES, 720))
  return minutes * 60_000
}

async function sweepOnce(): Promise<{ due: number; enqueued: number }> {
  if (inFlight) return { due: 0, enqueued: 0 }
  inFlight = true
  try {
    const intervalMsValue = intervalMs()
    const cutoff = new Date(Date.now() - intervalMsValue)
    // Cadence for the periodic FULL scan. Pass 2 (deleted-message
    // detection) is full-scan only, so this is what makes background
    // detection work. Must be >= TELEGRAM_SYNC_INTERVAL_MINUTES.
    const fullEveryMs = Math.max(intervalMsValue, env.TELEGRAM_SYNC_FULL_EVERY_MINUTES * 60_000)
    const fullCutoff = new Date(Date.now() - fullEveryMs)

    // Eligible accounts: connected Telegram accounts with a configured
    // storage channel. `last_scan_at` is null (never synced) OR older
    // than the cutoff. Channel-less accounts are excluded: they cannot
    // be synchronized.
    const eligible = await prisma.connectedAccount.findMany({
      where: {
        provider: 'telegram',
        status: { in: ['connected', 'reauth_required'] },
        telegramStorageConfig: {
          channelId: { not: null },
        },
      },
      select: {
        id: true,
        telegramSyncStates: { select: { status: true, lastScanAt: true, lastFullScanAt: true } },
      },
    })

    type Due = { id: string; full: boolean }
    const due: Due[] = []
    for (const account of eligible) {
      const state = account.telegramSyncStates[0]
      if (!state) {
        // No state row yet — never synced; first run is full so Pass 2
        // can pick up any pre-existing deletions from day one.
        due.push({ id: account.id, full: true })
        continue
      }
      if (state.status === 'syncing') continue // actively syncing
      if (!state.lastScanAt || state.lastScanAt < cutoff) {
        // Promote to a full scan when the last full scan is missing or
        // older than the full-cutoff — incremental ticks in between
        // stay cheap and only catch new uploads.
        const full = !state.lastFullScanAt || state.lastFullScanAt < fullCutoff
        due.push({ id: account.id, full })
      }
    }

    let enqueued = 0
    for (const target of due) {
      const result = await enqueueTelegramSync({ accountId: target.id, trigger: 'auto', full: target.full }).catch(() => null)
      if (result?.queued) enqueued += 1
    }

    if (due.length > 0 || enqueued > 0) {
      console.info('[telegram-sync-scheduler]', JSON.stringify({
        event: 'telegram.sync.scheduler_tick',
        due: due.length,
        enqueued,
        intervalMs: intervalMsValue,
      }))
    }

    return { due: due.length, enqueued }
  } finally {
    inFlight = false
  }
}

/** Start the periodic sweeper. No-op when `TELEGRAM_SYNC_AUTO_ENABLED=false`. */
export function startTelegramSyncScheduler() {
  if (timer) return
  if (!env.TELEGRAM_SYNC_AUTO_ENABLED) return
  const ms = intervalMs()
  // Stagger the first tick to avoid the cold-start herd: 30s after
  // boot so a freshly-started API doesn't immediately enqueue scans
  // for every connected account.
  const startDelay = 30_000
  timer = setTimeout(function tick() {
    sweepOnce().catch((error) => {
      console.error('[telegram-sync-scheduler]', JSON.stringify({
        event: 'telegram.sync.scheduler_error',
        errorCode: 'TELEGRAM_SCHEDULER_ERROR',
        errorMessage: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      }))
    }).finally(() => {
      if (timer) {
        timer = setTimeout(tick, intervalMs())
      }
    })
  }, startDelay)
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as { unref: () => void }).unref()
  }
}

/** Stop the periodic sweeper. Safe to call multiple times. */
export function stopTelegramSyncScheduler() {
  if (!timer) return
  clearTimeout(timer)
  timer = null
}

/** Trigger one manual sweep (used by the integration test). / /
   / re-exported for /server.ts tests. */
export async function triggerSweepOnce() {
  return sweepOnce()
}

export function isSchedulerRunning() {
  return timer !== null
}