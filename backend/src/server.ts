import { appReady } from './app.js'
import { env } from './config/env.js'
import { closeRemoteImportQueue } from './modules/remote-imports/queue.js'
import { closeTelegramSyncQueue } from './modules/telegram/telegram-sync.queue.js'
import { startTelegramSyncScheduler, stopTelegramSyncScheduler } from './modules/telegram/telegram-sync.scheduler.js'
import { startTelegramSyncWorker, stopTelegramSyncWorker } from './modules/telegram/telegram-sync.worker.js'
import { startDirectS3UploadSweeper } from './modules/uploads/direct-s3-upload.service.js'
import { attachServerBrowserUpgrade } from './modules/server-browser/server-browser.routes.js'
import { startServerBrowserSweeper, stopServerBrowserSweeper } from './modules/server-browser/server-browser.service.js'
import { attachHttpLifecycle, type HttpLifecycle } from './server-lifecycle.js'

async function main() {
  const app = await appReady

  const server = app.listen(env.APP_PORT, () => {
    console.log(`Backend running on http://localhost:${env.APP_PORT}`)
  })
  // Stops the listener, lets in-flight requests (including long file streams)
  // finish within the bounded drain window, then force-closes the rest.
  const lifecycle: HttpLifecycle = attachHttpLifecycle(server, { drainTimeoutMs: env.MEDIA_SERVER_SHUTDOWN_DRAIN_TIMEOUT_MS })

  // Server Browser display gateway needs raw `upgrade` events for the KasmVNC
  // WebSocket relay (Express routers never see them).
  attachServerBrowserUpgrade(server)

  // Telegram Synchronization: start the worker (consumes `telegram-sync`
  // queue) and the periodic sweeper (enqueues auto sync jobs every
  // `TELEGRAM_SYNC_INTERVAL_MINUTES`). Both run in the API process —
  // sync is metadata-only and the queue is colocated.
  startTelegramSyncWorker()
  startTelegramSyncScheduler()
  startDirectS3UploadSweeper()
  // Reap expired/crashed remote-browser sessions (no-op unless enabled).
  startServerBrowserSweeper()

  // Graceful shutdown: stop accepting new connections and let in-flight
  // requests drain (bounded), then close the BullMQ producer connections so
  // the process can exit cleanly.
  let shuttingDown = false
  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] ${signal} received, shutting down...`)
    stopTelegramSyncScheduler()
    stopServerBrowserSweeper()
    await stopTelegramSyncWorker()
    await lifecycle.shutdown()
    try {
      await Promise.all([closeRemoteImportQueue(), closeTelegramSyncQueue()])
      process.exit(0)
    } catch (error) {
      console.error('[server] failed to close queues:', error)
      process.exit(1)
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

void main()
