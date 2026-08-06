import { app } from './app.js'
import { env } from './config/env.js'
import { closeRemoteImportQueue } from './modules/remote-imports/queue.js'

const server = app.listen(env.APP_PORT, () => {
  console.log(`Backend running on http://localhost:${env.APP_PORT}`)
})

// Graceful shutdown: stop accepting connections, then close the BullMQ
// producer connection so the process can exit without hanging.
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} received, shutting down...`)
  server.close(() => {
    void closeRemoteImportQueue()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('[server] failed to close queue:', error)
        process.exit(1)
      })
  })
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
