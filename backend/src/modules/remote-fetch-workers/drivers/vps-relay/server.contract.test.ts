import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SECRET = 'test-relay-secret-abc123'
const serverDir = dirname(fileURLToPath(import.meta.url))
const serverPath = join(serverDir, 'server.js')

function sign(secret: string, method: string, path: string): string {
  return crypto.createHmac('sha256', secret).update(`${method} ${path}`, 'utf8').digest('hex')
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

function waitFor(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url)
        if (res.ok) return resolve()
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${url}`))
      setTimeout(tick, 100)
    }
    tick()
  })
}

describe('vps-relay server contract (9drive-relay-v1)', () => {
  let upstream: http.Server
  let upstreamPort = 0
  let relay: ChildProcess | null = null
  let relayPort = 0
  let blockedRelay: ChildProcess | null = null
  let blockedPort = 0
  const BYTES = Buffer.from('0123456789abcdef')

  beforeAll(async () => {
    upstreamPort = await freePort()
    relayPort = await freePort()
    blockedPort = await freePort()

    upstream = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://local')
      if (u.pathname === '/video') {
        const range = req.headers.range
        if (typeof range === 'string' && range.startsWith('bytes=0-0')) {
          res.writeHead(206, {
            'content-range': `bytes 0-0/${BYTES.length}`,
            'content-length': '1',
            'accept-ranges': 'bytes',
            'content-type': 'video/mp4',
          })
          res.end(BYTES.subarray(0, 1))
          return
        }
        res.writeHead(200, { 'content-length': String(BYTES.length), 'accept-ranges': 'bytes', 'content-type': 'video/mp4' })
        res.end(BYTES)
        return
      }
      if (u.pathname === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found upstream')
        return
      }
      if (u.pathname === '/redirect') {
        res.writeHead(302, { location: '/video' })
        res.end()
        return
      }
      if (u.pathname === '/slow') {
        setTimeout(() => {
          try {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('slow-ok')
          } catch {}
        }, 800)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))

    const spawnRelay = (port: number, allowPrivate: boolean): ChildProcess => {
      const env: Record<string, string> = { ...process.env as Record<string, string>, PORT: String(port), RELAY_SECRET: SECRET, MAX_CONCURRENT_TRANSFERS: '2' }
      if (allowPrivate) env.ALLOW_PRIVATE_UPSTREAM = 'true'
      else delete env.ALLOW_PRIVATE_UPSTREAM
      return spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    }

    relay = spawnRelay(relayPort, true)
    blockedRelay = spawnRelay(blockedPort, false)
    relay.stdout?.on('data', () => {})
    relay.stderr?.on('data', () => {})
    blockedRelay.stdout?.on('data', () => {})
    blockedRelay.stderr?.on('data', () => {})
    await waitFor(`http://127.0.0.1:${relayPort}/healthz`)
    await waitFor(`http://127.0.0.1:${blockedPort}/healthz`)
  }, 30000)

  afterAll(async () => {
    relay?.kill()
    blockedRelay?.kill()
    await new Promise<void>((resolve) => upstream?.close(() => resolve()))
  })

  it('serves public /healthz without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/healthz`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, string>
    expect(body.status).toBe('ok')
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  it('authenticates /health with HMAC; rejects bad secret', async () => {
    const good = await fetch(`http://127.0.0.1:${relayPort}/health`, { headers: { 'x-9drive-signature': sign(SECRET, 'GET', '/health') } })
    expect(good.status).toBe(200)
    const body = await good.json() as { service: string; protocolVersion: string; status: string }
    expect(body).toMatchObject({ service: '9drive-relay', protocolVersion: '9drive-relay-v1', status: 'ok' })

    const bad = await fetch(`http://127.0.0.1:${relayPort}/health`, { headers: { 'x-9drive-signature': sign('wrong', 'GET', '/health') } })
    expect(bad.status).toBe(401)
    const missing = await fetch(`http://127.0.0.1:${relayPort}/health`)
    expect(missing.status).toBe(401)
  })

  it('rejects unauthenticated /fetch and malformed protocol', async () => {
    const noAuth = await fetch(`http://127.0.0.1:${relayPort}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    expect(noAuth.status).toBe(401)

    const badPayload = await fetch(`http://127.0.0.1:${relayPort}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-9drive-signature': sign(SECRET, 'POST', '/fetch') },
      body: JSON.stringify({ protocolVersion: '9drive-relay-v0', url: 'https://example.com/', method: 'GET', headers: {} }),
    })
    expect(badPayload.status).toBe(400)
    const reason = await badPayload.json() as { reason: string }
    expect(reason.reason).toBe('INVALID_PROTOCOL')

    const jsUrl = await fetch(`http://127.0.0.1:${relayPort}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-9drive-signature': sign(SECRET, 'POST', '/fetch') },
      body: JSON.stringify({ protocolVersion: '9drive-relay-v1', url: 'javascript:alert(1)', method: 'GET', headers: {}, response: 'stream' }),
    })
    expect(jsUrl.status).toBe(400)
  })

  it('blocks loopback upstream when ALLOW_PRIVATE_UPSTREAM is off', async () => {
    const res = await fetch(`http://127.0.0.1:${blockedPort}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-9drive-signature': sign(SECRET, 'POST', '/fetch') },
      body: JSON.stringify({ protocolVersion: '9drive-relay-v1', url: `http://127.0.0.1:${upstreamPort}/video`, method: 'GET', headers: {}, response: 'stream' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { reason: string }
    expect(body.reason).toBe('INVALID_URL')
  })

  async function relayFetch(targetUrl: string, extraHeaders: Record<string, string> = {}, method = 'GET') {
    return fetch(`http://127.0.0.1:${relayPort}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-9drive-signature': sign(SECRET, 'POST', '/fetch') },
      body: JSON.stringify({ protocolVersion: '9drive-relay-v1', url: targetUrl, method, headers: { Accept: '*/*', ...extraHeaders }, response: 'stream', traceId: 'test:fetch' }),
    })
  }

  it('streams GET with upstream 200 preserved', async () => {
    const res = await relayFetch(`http://127.0.0.1:${upstreamPort}/video`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-9drive-streaming')).toBe('1')
    expect(res.headers.get('x-9drive-upstream-status')).toBe('200')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.equals(BYTES)).toBe(true)
  })

  it('preserves Range 206 + Content-Range', async () => {
    const res = await relayFetch(`http://127.0.0.1:${upstreamPort}/video`, { Range: 'bytes=0-0' })
    expect(res.headers.get('x-9drive-upstream-status')).toBe('206')
    expect(res.headers.get('content-range')).toBe(`bytes 0-0/${BYTES.length}`)
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.length).toBe(1)
    expect(buf[0]).toBe(BYTES[0])
  })

  it('preserves upstream 404 separately from relay status', async () => {
    const res = await relayFetch(`http://127.0.0.1:${upstreamPort}/missing`)
    expect(res.status).toBe(200) // relay healthy
    expect(res.headers.get('x-9drive-upstream-status')).toBe('404')
    const text = await res.text()
    expect(text).toContain('not found upstream')
  })

  it('follows same-host redirects and reports final URL', async () => {
    const res = await relayFetch(`http://127.0.0.1:${upstreamPort}/redirect`)
    expect(res.headers.get('x-9drive-upstream-status')).toBe('200')
    expect(res.headers.get('x-9drive-final-url')).toContain('/video')
    await res.arrayBuffer()
  })

  it('maps upstream network exception to 502 (not 404)', async () => {
    const closedPort = await freePort()
    const res = await relayFetch(`http://127.0.0.1:${closedPort}/gone`)
    expect(res.status).toBe(502)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('UPSTREAM_FETCH_EXCEPTION')
  })

  it('enforces concurrency limit with 429 under load', async () => {
    const slow = (i: number) =>
      fetch(`http://127.0.0.1:${relayPort}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-9drive-signature': sign(SECRET, 'POST', '/fetch') },
        body: JSON.stringify({ protocolVersion: '9drive-relay-v1', url: `http://127.0.0.1:${upstreamPort}/slow?i=${i}`, method: 'GET', headers: {}, response: 'stream', traceId: `test:slow-${i}` }),
      })
    const [a, b, c] = await Promise.all([slow(1), slow(2), slow(3)])
    const statuses = [a.status, b.status, c.status].sort()
    // Two concurrent transfers succeed (200), the third is rejected (429).
    expect(statuses).toEqual([200, 200, 429])
    await Promise.all([a.arrayBuffer().catch(() => null), b.arrayBuffer().catch(() => null), c.arrayBuffer().catch(() => null)])
  })
})
