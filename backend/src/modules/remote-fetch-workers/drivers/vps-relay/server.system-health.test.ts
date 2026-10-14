import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SECRET = 'k7Q2m9Zx4v8Bn3-relay-secret'
const DECOY_ENV_VALUE = 'decoy-unrelated-value-000'
const serverDir = dirname(fileURLToPath(import.meta.url))
const serverPath = join(serverDir, 'server.js')

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
        if (res.ok || res.status === 503) return resolve()
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${url}`))
      setTimeout(tick, 100)
    }
    tick()
  })
}

type HealthBody = {
  service: string
  provider: string
  protocol: string
  status: string
  timestamp: string
  uptimeSeconds: number
  publicBaseUrl: string | null
  endpoints: { health: string; relay: string }
  setup: {
    relaySecret: { configured: boolean }
    authentication: { mode: string; configured: boolean }
    httpServer: { listening: boolean }
    relayHandler: { registered: boolean }
    publicUrl: { configured: boolean }
  }
  capabilities: { rangeRequests: string; responseStreaming: string }
  warnings: string[]
  message: string
}

describe('vps-relay GET /system-health', () => {
  let readyPort = 0
  let noPublicPort = 0
  let noSecretPort = 0
  let invalidPublicPort = 0
  const children: ChildProcess[] = []
  const logs: string[] = []

  function spawnRelay(port: number, env: Record<string, string>): ChildProcess {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(port), UNRELATED_DECOY_VAR: DECOY_ENV_VALUE, ...env } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (c) => logs.push(String(c)))
    child.stderr?.on('data', (c) => logs.push(String(c)))
    children.push(child)
    return child
  }

  beforeAll(async () => {
    readyPort = await freePort()
    noPublicPort = await freePort()
    noSecretPort = await freePort()
    invalidPublicPort = await freePort()
    spawnRelay(readyPort, { RELAY_SECRET: SECRET, RELAY_PUBLIC_URL: 'https://relay.example.com' })
    spawnRelay(noPublicPort, { RELAY_SECRET: SECRET })
    spawnRelay(noSecretPort, { RELAY_PUBLIC_URL: 'https://relay.example.com' })
    spawnRelay(invalidPublicPort, { RELAY_SECRET: SECRET, RELAY_PUBLIC_URL: 'http://insecure.example.com/?token=abc' })
    // /system-health answers 503 when unconfigured, so wait on /healthz (always 200).
    await waitFor(`http://127.0.0.1:${readyPort}/healthz`)
    await waitFor(`http://127.0.0.1:${noPublicPort}/healthz`)
    await waitFor(`http://127.0.0.1:${noSecretPort}/healthz`)
    await waitFor(`http://127.0.0.1:${invalidPublicPort}/healthz`)
  }, 30000)

  afterAll(() => {
    for (const child of children) child.kill()
  })

  async function getSystemHealth(port: number, headers: Record<string, string> = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/system-health`, { headers })
    const text = await res.text()
    return { res, text, body: JSON.parse(text) as HealthBody }
  }

  it('returns valid JSON with the documented schema, correct Content-Type, and no-store', async () => {
    const { res, body } = await getSystemHealth(readyPort)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(body.service).toBe('9drive-vps-relay')
    expect(body.provider).toBe('Virtual Private Server')
    expect(body.protocol).toBe('9drive-relay-v1')
    expect(body.status).toBe('ready')
    expect(typeof body.timestamp).toBe('string')
    expect(typeof body.uptimeSeconds).toBe('number')
    expect(body.publicBaseUrl).toBe('https://relay.example.com')
    expect(body.endpoints).toEqual({ health: '/system-health', relay: '/fetch' })
    expect(body.setup).toEqual({
      relaySecret: { configured: true },
      authentication: { mode: 'hmac', configured: true },
      httpServer: { listening: true },
      relayHandler: { registered: true },
      publicUrl: { configured: true },
    })
    expect(body.capabilities).toEqual({ rangeRequests: 'implemented', responseStreaming: 'implemented' })
    expect(body.warnings).toEqual([])
    expect(typeof body.message).toBe('string')
  })

  it('reports 503 + not_configured when RELAY_SECRET is missing, with relay fail-closed', async () => {
    const { res, body } = await getSystemHealth(noSecretPort)
    expect(res.status).toBe(503)
    expect(body.status).toBe('not_configured')
    expect(body.setup.relaySecret).toEqual({ configured: false })
    expect(body.setup.authentication).toEqual({ mode: 'hmac', configured: false })
    expect(body.warnings.some((w) => w.includes('RELAY_SECRET'))).toBe(true)
    // Relay operations fail closed without a secret: HMAC /health rejects.
    const sig = crypto.createHmac('sha256', SECRET).update('GET /health', 'utf8').digest('hex')
    const health = await fetch(`http://127.0.0.1:${noSecretPort}/health`, { headers: { 'x-9drive-signature': sig } })
    expect(health.status).toBe(401)
  })

  it('never leaks secrets, hashes, env values, signed URLs, or internal IPs', async () => {
    for (const port of [readyPort, noPublicPort, noSecretPort]) {
      const { text } = await getSystemHealth(port)
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(SECRET.slice(0, 8))
      expect(text).not.toContain(DECOY_ENV_VALUE)
      expect(text).not.toContain('127.0.0.1')
      expect(text).not.toContain('::1')
      expect(text).not.toContain('token=')
    }
    const { body } = await getSystemHealth(readyPort)
    const keys = JSON.stringify(body).toLowerCase()
    expect(keys).not.toContain('hash')
    expect(keys).not.toContain('fingerprint')
    // Allowlisted shape only: no secret values anywhere in the payload.
    expect(Object.keys(body)).toEqual(['service', 'provider', 'protocol', 'status', 'timestamp', 'uptimeSeconds', 'publicBaseUrl', 'endpoints', 'setup', 'capabilities', 'browserWarmup', 'warnings', 'message'])
    // Warmup diagnostics are booleans/enums only (never internals/secrets).
    expect(body.browserWarmup).toMatchObject({ supported: expect.any(Boolean), configured: expect.any(Boolean) })
    // Process logs never carry the secret either.
    await new Promise((r) => setTimeout(r, 200))
    expect(logs.join('\n')).not.toContain(SECRET)
  })

  it('ignores attacker-controlled Host / forwarded-host headers for the public URL', async () => {
    const evil: Record<string, string> = { host: 'evil.example', 'x-forwarded-host': 'evil.example', forwarded: 'for=1.2.3.4;host=evil.example' }
    const { body } = await getSystemHealth(readyPort, evil)
    expect(body.publicBaseUrl).toBe('https://relay.example.com')
    expect(JSON.stringify(body)).not.toContain('evil.example')
    const { body: missing } = await getSystemHealth(noPublicPort, evil)
    expect(missing.publicBaseUrl).toBeNull()
    expect(JSON.stringify(missing)).not.toContain('evil.example')
  })

  it('returns null + a safe warning for a missing or invalid public URL', async () => {
    const { body: missing } = await getSystemHealth(noPublicPort)
    expect(missing.publicBaseUrl).toBeNull()
    expect(missing.setup.publicUrl).toEqual({ configured: false })
    expect(missing.warnings.some((w) => w.includes('RELAY_PUBLIC_URL'))).toBe(true)
    expect(missing.status).toBe('ready')

    const { res, body: invalid } = await getSystemHealth(invalidPublicPort)
    expect(invalid.publicBaseUrl).toBeNull()
    expect(invalid.setup.publicUrl).toEqual({ configured: false })
    expect(invalid.warnings.some((w) => w.includes('RELAY_PUBLIC_URL'))).toBe(true)
    // Invalid URL never echoes the rejected value.
    expect(JSON.stringify(invalid)).not.toContain('insecure.example.com')
    expect(invalid.status).toBe('degraded')
    expect(res.status).toBe(200)
  })

  it('never claims HMAC compatibility or external connectivity from local config', async () => {
    const { body } = await getSystemHealth(readyPort)
    const flat = JSON.stringify(body).toLowerCase()
    expect(flat).not.toContain('verified')
    expect(flat).not.toContain('reachable')
    expect(flat).not.toContain('connected')
    expect(body.message).toMatch(/authenticated connection test/)
  })

  it('cannot proxy content or accept an upstream destination', async () => {
    // Only GET is served; other methods fall through to the safe 404.
    const post = await fetch(`http://127.0.0.1:${readyPort}/system-health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/' }) })
    expect(post.status).toBe(404)
    // Health routes answer locally with no upstream fetch involved.
    const start = Date.now()
    const { res } = await getSystemHealth(readyPort)
    expect(res.status).toBe(200)
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('leaves existing authenticated relay behavior unchanged', async () => {
    const sig = crypto.createHmac('sha256', SECRET).update('GET /health', 'utf8').digest('hex')
    const health = await fetch(`http://127.0.0.1:${readyPort}/health`, { headers: { 'x-9drive-signature': sig } })
    expect(health.status).toBe(200)
    const payload = (await health.json()) as { service: string; protocolVersion: string }
    expect(payload).toMatchObject({ service: '9drive-relay', protocolVersion: '9drive-relay-v1' })
    const liveness = await fetch(`http://127.0.0.1:${readyPort}/healthz`)
    expect(liveness.status).toBe(200)
  })
})
