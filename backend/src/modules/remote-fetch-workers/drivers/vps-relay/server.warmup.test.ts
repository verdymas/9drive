import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SECRET = 'warmup-test-secret-xyz123'
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

function signWarmup(secret: string, body: string, ts: string, nonce: string): string {
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  return crypto.createHmac('sha256', secret).update(`POST /warmup\n${bodyHash}\n${ts}\n${nonce}`, 'utf8').digest('hex')
}

describe('vps-relay POST /warmup (browser warmup, capability-gated)', () => {
  let port = 0
  let child: ChildProcess | null = null

  beforeAll(async () => {
    port = await freePort()
    child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(port), RELAY_SECRET: SECRET } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    await waitFor(`http://127.0.0.1:${port}/healthz`)
  }, 20000)

  afterAll(async () => {
    child?.kill()
  })

  async function warmup(body: Record<string, unknown>, opts: { secret?: string; ts?: string; nonce?: string } = {}) {
    const raw = JSON.stringify(body)
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000))
    const nonce = opts.nonce ?? crypto.randomBytes(16).toString('hex')
    const sig = signWarmup(opts.secret ?? SECRET, raw, ts, nonce)
    return fetch(`http://127.0.0.1:${port}/warmup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-9drive-signature': sig, 'x-9drive-timestamp': ts, 'x-9drive-nonce': nonce },
      body: raw,
    })
  }

  it('advertises browserWarmup:false on the lean image (501, legacy /fetch intact)', async () => {
    const sig = crypto.createHmac('sha256', SECRET).update('GET /health', 'utf8').digest('hex')
    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-9drive-signature': sig } })
    expect(health.status).toBe(200)
    const payload = (await health.json()) as { capabilities: { browserWarmup: { supported: boolean } } }
    expect(payload.capabilities.browserWarmup.supported).toBe(false)

    const sys = await fetch(`http://127.0.0.1:${port}/system-health`)
    const sysBody = (await sys.json()) as { browserWarmup: { supported: boolean; configured: boolean } }
    expect(sysBody.browserWarmup.supported).toBe(false)

    const res = await warmup({ protocolVersion: '9drive-relay-v1', pageUrl: 'https://example.com/page' })
    expect(res.status).toBe(501)
    const data = (await res.json()) as { code: string; status: string }
    expect(data.code).toBe('WARMUP_NOT_SUPPORTED')
    expect(data.status).toBe('not_supported')
  })

  it('rejects bad HMAC (401) and replays (403) without revealing the page', async () => {
    const bad = await warmup({ protocolVersion: '9drive-relay-v1', pageUrl: 'https://example.com/page' }, { secret: 'wrong-secret' })
    expect(bad.status).toBe(401)

    const ts = String(Math.floor(Date.now() / 1000))
    const nonce = crypto.randomBytes(16).toString('hex')
    const first = await warmup({ protocolVersion: '9drive-relay-v1', pageUrl: 'https://example.com/page' }, { ts, nonce })
    expect([501, 400]).toContain(first.status)
    const replay = await warmup({ protocolVersion: '9drive-relay-v1', pageUrl: 'https://example.com/page' }, { ts, nonce })
    expect(replay.status).toBe(403)
  })

  it('rejects unsafe page URLs (400) and never fetches them', async () => {
    for (const pageUrl of ['javascript:alert(1)', 'http://127.0.0.1/video', 'http://localhost/page', 'ftp://example.com/x']) {
      const res = await warmup({ protocolVersion: '9drive-relay-v1', pageUrl })
      expect(res.status).toBe(400)
    }
  })

  it('separates navigation outcome from media success (never 206 text/html)', async () => {
    // Lean image has no Chromium: the contract is 501, never a fake `warmed`.
    // This guards the spec rule: do not mislabel browser-health as media success.
    const res = await warmup({ protocolVersion: '9drive-relay-v1', pageUrl: 'https://example.com/watch/1' })
    expect(res.status).toBe(501)
    const text = await res.text()
    expect(text).not.toContain('warmed')
  })
})
