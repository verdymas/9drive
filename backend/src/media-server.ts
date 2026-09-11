import { createMediaPlaneApp } from './app-composition.js'
import { env } from './config/env.js'
import { attachHttpLifecycle } from './server-lifecycle.js'
import { prisma } from './config/prisma.js'

/**
 * Optional standalone media plane. Mounts only the stream-heavy routes created
 * by the SAME factories the all-in-one server uses, so auth (bearer, public
 * tokens, WebDAV Basic), range semantics, and handler code are literally
 * shared, and the reverse proxy can keep public paths unchanged. Run via
 * `npm run start:media`; the control plane keeps serving these paths itself
 * when this process is absent.
 */
if (!env.MEDIA_SERVER_ENABLED) {
  console.log('[media-server] MEDIA_SERVER_ENABLED is false — the media plane exits without running. The all-in-one server already serves every route; set the flag to true to isolate stream traffic behind a reverse proxy.')
  process.exit(0)
}

const app = createMediaPlaneApp()

const server = app.listen(env.MEDIA_SERVER_PORT, '0.0.0.0', () => {
  console.log(`Media plane running on http://localhost:${env.MEDIA_SERVER_PORT}`)
})
const lifecycle = attachHttpLifecycle(server, { drainTimeoutMs: env.MEDIA_SERVER_SHUTDOWN_DRAIN_TIMEOUT_MS })

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[media-server] ${signal} received, draining active streams...`)
  await lifecycle.shutdown()
  await prisma.$disconnect().catch(() => undefined)
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
