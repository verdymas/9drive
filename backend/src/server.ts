import { app } from './app.js'
import { env } from './config/env.js'
import { closeRemoteImportQueue } from './modules/remote-imports/queue.js'
import { closeTelegramSyncQueue } from './modules/telegram/telegram-sync.queue.js'
import { startTelegramSyncScheduler, stopTelegramSyncScheduler } from './modules/telegram/telegram-sync.scheduler.js'
import { startTelegramSyncWorker, stopTelegramSyncWorker } from './modules/telegram/telegram-sync.worker.js'

const server = app.listen(env.APP_PORT, () => {
  console.log(`Backend running on http://localhost:${env.APP_PORT}`)
})

// Telegram Synchronization: start the worker (consumes `telegram-sync`
// queue) and the periodic sweeper (enqueues auto sync jobs every
// `TELEGRAM_SYNC_INTERVAL_MINUTES`). Both run in the API process —
// sync is metadata-only and the queue is colocated.
startTelegramSyncWorker()
startTelegramSyncScheduler()

// Graceful shutdown: stop accepting connections, then close the BullMQ
// producer connections + the sweeper so the process can exit cleanly.
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} received, shutting down...`)
  stopTelegramSyncScheduler()
  await stopTelegramSyncWorker()
  server.close(() => {
    Promise.all([closeRemoteImportQueue(), closeTelegramSyncQueue()])
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('[server] failed to close queues:', error)
        process.exit(1)
      })
  })
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))