import { prisma } from '../../config/prisma.js'

/**
 * Periodic Browser Capture cleanup (Phase 07): expire pending resources past
 * their TTL and prune pairings that expired long ago. Never deletes consumed
 * rows (they carry import history) and never touches Remote Imports.
 * Runs in the remote-import-worker process next to the queue reconcile sweep.
 */
export async function runCaptureSweep(): Promise<string> {
  const summary: string[] = []
  try {
    const expired = await prisma.capturedResource.updateMany({
      where: { status: 'pending', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    })
    if (expired.count > 0) summary.push(`expired:${expired.count}`)

    // Pairings are one-time codes; anything unclaimed after a day is garbage.
    const stalePairings = await prisma.browserDevicePairing.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
          { usedAt: { not: null, lt: new Date(Date.now() - 24 * 3600_000) } },
        ],
      },
    })
    if (stalePairings.count > 0) summary.push(`pairings:${stalePairings.count}`)
  } catch (error) {
    console.error('[browser-capture] sweep failed:', error instanceof Error ? error.message : String(error))
  }
  return summary.join(', ')
}

/** Start the capture sweep on an interval. Returns the timer. */
export function startCaptureSweep(intervalMs = 300_000) {
  const timer = setInterval(() => {
    void runCaptureSweep().then((summary) => {
      if (summary) console.log(`[browser-capture] sweep: ${summary}`)
    })
  }, intervalMs)
  timer.unref()
  return timer
}
