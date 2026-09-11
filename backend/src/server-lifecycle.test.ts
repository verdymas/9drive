import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import net from 'node:net'
import { attachHttpLifecycle } from './server-lifecycle.js'

const opened: Server[] = []

function listen(app: Server) {
  opened.push(app)
  app.listen(0, '127.0.0.1')
  return once(app, 'listening')
}

function portOf(app: Server) {
  const address = app.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  return address.port
}

afterEach(async () => {
  for (const app of opened) app.closeAllConnections?.()
  opened.length = 0
})

describe('attachHttpLifecycle', () => {
  it('tracks the active connection count while a stream is in flight', async () => {
    let resolveStream: () => void = () => undefined
    const streamDone = new Promise<void>((resolve) => { resolveStream = resolve })
    const app = createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write('chunk')
      await streamDone
      res.end()
    })
    await listen(app)
    const lifecycle = attachHttpLifecycle(app, { drainTimeoutMs: 5000 })

    const inflight = fetch(`http://127.0.0.1:${portOf(app)}/stream`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(lifecycle.activeConnections()).toBeGreaterThanOrEqual(1)
    expect(lifecycle.isDraining()).toBe(false)

    resolveStream()
    await (await inflight).text()
    await lifecycle.shutdown()
    expect(lifecycle.isDraining()).toBe(true)
    expect(lifecycle.activeConnections()).toBe(0)
  }, 15000)

  it('drains within the bounded budget and force-closes stalled streams', async () => {
    const app = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write('start')
      // Never ends — models a stalled byte stream that must not hold shutdown.
    })
    await listen(app)
    const lifecycle = attachHttpLifecycle(app, { drainTimeoutMs: 200, pollIntervalMs: 10 })
    const port = portOf(app)

    const stalled = fetch(`http://127.0.0.1:${port}/stream`)
      .then(async (response) => response.text())
      .catch(() => 'aborted')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(lifecycle.activeConnections()).toBeGreaterThanOrEqual(1)

    const started = Date.now()
    await lifecycle.shutdown()
    expect(Date.now() - started).toBeLessThan(1500) // BOUNDED drain.
    expect(lifecycle.activeConnections()).toBe(0)
    await stalled
  }, 15000)

  it('refuses new connections once the server has stopped listening', async () => {
    const app = createServer((_req, res) => res.end('ok'))
    await listen(app)
    const lifecycle = attachHttpLifecycle(app, { drainTimeoutMs: 50 })
    const port = portOf(app)

    const keepActive = net.connect(port)
    await once(keepActive, 'connect')
    const shuttingDown = lifecycle.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 25))

    keepActive.destroy()
    await shuttingDown

    await expect(new Promise<void>((resolve, reject) => {
      const probe = net.connect(port)
      probe.once('connect', () => { probe.destroy(); reject(new Error('listener still accepting connections')) })
      probe.once('error', () => resolve())
    })).resolves.toBeUndefined()
  }, 15000)
})
