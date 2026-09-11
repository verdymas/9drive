import type { Server } from 'node:http'

/**
 * Connection accounting + bounded drain for the HTTP processes (all-in-one API
 * server and the optional media plane). During shutdown the server stops
 * accepting new connections, in-flight streams get a bounded window to
 * finish, and only then are remaining sockets destroyed — so a killed process
 * never hangs on a stalled client and never leaves half-written provider
 * state behind (streams finalize or the request simply never completes; DB
 * state is only written by completed requests).
 */
export type HttpLifecycleOptions = {
  /** Maximum time to let active connections finish before forcing close. */
  drainTimeoutMs?: number
  /** How often to re-check the connection count while draining. */
  pollIntervalMs?: number
}

export type HttpLifecycle = {
  isDraining: () => boolean
  activeConnections: () => number
  /** Resolves once the listener is closed and tracked sockets are gone. */
  shutdown: () => Promise<void>
}

export function attachHttpLifecycle(server: Server, options: HttpLifecycleOptions = {}): HttpLifecycle {
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const sockets = new Set<{ destroy: () => void }>()
  let draining = false

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    isDraining: () => draining,
    activeConnections: () => sockets.size,
    async shutdown() {
      draining = true
      const closed = new Promise<void>((resolve) => { server.close(() => resolve()) })
      // Idle keep-alive sockets are not worth draining; release them first.
      server.closeIdleConnections?.()
      const deadline = Date.now() + drainTimeoutMs
      while (sockets.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      }
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await closed
    },
  }
}
