/**
 * Relay serializer → deployed worker parser contract test (no network).
 *
 * This is the drift guard the protocol needs: the REAL backend serializer
 * (`serializeRelayRequest`, produced by `CloudflareRemoteFetchTransport`)
 * feeds the REAL deployed artifact (`cloudflare-relay/worker.mjs`, executed via
 * the worker's own `default.fetch`). Neither schema is duplicated here — if
 * backend and Worker protocols drift again, this test fails.
 *
 * Also asserts the artifact embeds the canonical constants
 * (`RELAY_PROTOCOL_VERSION`, signature header, /fetch path) so the deployed
 * source cannot silently diverge from `relay-protocol.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import { loadRelaySource } from '../cloudflare-relay.js'
import {
  RELAY_FETCH_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SIGNATURE_HEADER,
  serializeRelayRequest,
} from '../../relay-protocol.js'

const SECRET = 'contract-test-relay-secret'
const WORKER_URL = 'https://relay.test'
const UPSTREAM_BODY = '#EXTM3U\n'
const UPSTREAM_BODY_LEN = Buffer.byteLength(UPSTREAM_BODY, 'utf8')

async function loadWorker() {
  const source = loadRelaySource()
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
  return mod.default as { fetch: (request: Request, env: { RELAY_SECRET: string }) => Promise<Response> }
}

function sign(method: string, path: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${method} ${path}`, 'utf8').digest('hex')
}

function buildRequest(payload: Record<string, unknown>): Request {
  return new Request(`${WORKER_URL}${RELAY_FETCH_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RELAY_SIGNATURE_HEADER]: sign('POST', RELAY_FETCH_PATH),
    },
    body: serializeRelayRequest(payload as never),
  })
}

/** Raw (bypass serializer) request for negative/shape tests — the parser is
 * what must reject these, not the backend serializer. */
function buildRawRequest(payload: unknown): Request {
  return new Request(`${WORKER_URL}${RELAY_FETCH_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RELAY_SIGNATURE_HEADER]: sign('POST', RELAY_FETCH_PATH),
    },
    body: JSON.stringify(payload),
  })
}

describe('worker.mjs artifact: canonical constants are embedded', () => {
  it('embeds the canonical protocol version, signature header and /fetch path', () => {
    const source = loadRelaySource()
    expect(source).toContain(`'${RELAY_PROTOCOL_VERSION}'`)
    expect(source).toContain(`'${RELAY_SIGNATURE_HEADER}'`)
    expect(source).toContain(`'${RELAY_FETCH_PATH}'`)
  })
})

describe('serializer → worker.mjs parser (real artifact, real serializer)', () => {
  let worker: { fetch: (request: Request, env: { RELAY_SECRET: string }) => Promise<Response> }
  let upstream: http.Server
  let upstreamUrl: string
  const upstreamHits: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = []

  beforeAll(async () => {
    worker = await loadWorker()
    upstream = http.createServer((req, res) => {
      upstreamHits.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers })
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(UPSTREAM_BODY_LEN),
        connection: 'close',
      })
      res.end(UPSTREAM_BODY)
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  it('accepts HEAD (body omitted) and relays it', async () => {
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: `${upstreamUrl}/sample.m3u8`, method: 'HEAD' as const, headers: {} }
    const res = await worker.fetch(buildRequest(payload), { RELAY_SECRET: SECRET })
    expect(res.status).toBe(200)
    const envJson = (await res.json()) as { status: number; body: string; protocolVersion: string }
    expect(envJson.status).toBe(200)
    expect(envJson.protocolVersion).toBe(RELAY_PROTOCOL_VERSION)
    expect(upstreamHits[upstreamHits.length - 1].method).toBe('HEAD')
  })

  it('accepts GET (body omitted) and returns the upstream body', async () => {
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: `${upstreamUrl}/sample.m3u8`, method: 'GET' as const, headers: {} }
    const res = await worker.fetch(buildRequest(payload), { RELAY_SECRET: SECRET })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: number; body: string }
    expect(json.status).toBe(200)
    expect(Buffer.from(json.body, 'base64').toString('utf8')).toBe(UPSTREAM_BODY)
    expect(upstreamHits[upstreamHits.length - 1].method).toBe('GET')
  })

  it('accepts GET + Range and forwards the Range header', async () => {
    const payload = {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      url: `${upstreamUrl}/sample.m3u8`,
      method: 'GET' as const,
      headers: { Range: 'bytes=0-1023' },
    }
    const res = await worker.fetch(buildRequest(payload), { RELAY_SECRET: SECRET })
    expect(res.status).toBe(200)
    expect(upstreamHits[upstreamHits.length - 1].headers.range).toBe('bytes=0-1023')
  })

  it('rejects a wrong protocol version with reason INVALID_PROTOCOL (never the URL/secret)', async () => {
    const payload = { protocolVersion: '9drive-relay-v0', url: `${upstreamUrl}/sample.m3u8`, method: 'GET' as const, headers: {} }
    const res = await worker.fetch(buildRawRequest(payload), { RELAY_SECRET: SECRET })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string; reason?: string }
    expect(json.error).toBe('invalid payload')
    expect(json.reason).toBe('INVALID_PROTOCOL')
    expect(JSON.stringify(json)).not.toContain(upstreamUrl)
    expect(JSON.stringify(json)).not.toContain(SECRET)
  })

  it('rejects an unauthenticated request with 401', async () => {
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: `${upstreamUrl}/sample.m3u8`, method: 'GET' as const, headers: {} }
    const req = new Request(`${WORKER_URL}${RELAY_FETCH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: serializeRelayRequest(payload as never),
    })
    const res = await worker.fetch(req, { RELAY_SECRET: SECRET })
    expect(res.status).toBe(401)
  })

  it('rejects an unsupported method with reason UNSUPPORTED_METHOD', async () => {
    const payload = { protocolVersion: RELAY_PROTOCOL_VERSION, url: `${upstreamUrl}/sample.m3u8`, method: 'DELETE' as const, headers: {} }
    const res = await worker.fetch(buildRawRequest(payload), { RELAY_SECRET: SECRET })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { reason?: string }
    expect(json.reason).toBe('UNSUPPORTED_METHOD')
  })
})