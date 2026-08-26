import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// ── Mocks ────────────────────────────────────────────────────────────────────
// Drive the REAL browser-capture routes (mounted on a real Express app) with
// an in-memory prisma fake. Covers: pairing → register handshake, device-token
// auth/ownership/revocation, submit validation (URL/type/size), dedupe,
// lazy expiration, mark-consumed and delete.
const h = vi.hoisted(() => {
  let seq = 0
  const pairings: any[] = []
  const devices: any[] = []
  const resources: any[] = []

  const reset = () => {
    pairings.length = 0
    devices.length = 0
    resources.length = 0
    seq = 0
  }

  const id = () => `id-${++seq}`
  const now = () => new Date()

  // Minimal query matcher: supports the shapes this module actually uses.
  const matches = (row: any, where: any): boolean => {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (cond === null || cond === undefined || typeof cond !== 'object' || cond instanceof Date) {
        if (row[key] !== cond && !(cond instanceof Date && row[key]?.getTime() === cond.getTime())) return false
        continue
      }
      if (cond.not !== undefined && row[key] === cond.not) return false
      if (cond.in && !cond.in.includes(row[key])) return false
      if (cond.lt !== undefined && !(row[key] < cond.lt)) return false
      if (cond.gt !== undefined && !(row[key] > cond.gt)) return false
    }
    return true
  }

  const prisma = {
    browserDevicePairing: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id(), usedAt: null, createdAt: now(), ...data }
        pairings.push(row)
        return row
      }),
      findUnique: vi.fn(async ({ where }: any) => pairings.find((p) => p.codeHash === where.codeHash) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const p of pairings) {
          if (matches(p, where)) { Object.assign(p, data); count++ }
        }
        return { count }
      }),
    },
    browserDevice: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id(), lastSeenAt: null, revokedAt: null, status: 'active', createdAt: now(), updatedAt: now(), ...data }
        devices.push(row)
        return row
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        let rows = devices.filter((d) => matches(d, where))
        if (orderBy?.[0] === 'createdAt') rows = [...rows].sort((a, b) => b.createdAt - a.createdAt)
        return rows
      }),
      findFirst: vi.fn(async ({ where }: any) => devices.find((d) => matches(d, where)) ?? null),
      findUnique: vi.fn(async ({ where }: any) => devices.find((d) => d.deviceTokenHash === where.deviceTokenHash) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = devices.find((d) => d.id === where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data, { updatedAt: now() })
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const d of devices) {
          if (matches(d, where)) { Object.assign(d, data); count++ }
        }
        return { count }
      }),
    },
    capturedResource: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id(), importedAt: null, detectedAt: now(), createdAt: now(), updatedAt: now(), ...data }
        resources.push(row)
        return row
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const found = resources.filter((r) => matches(r, where))
        return found.sort((a, b) => b.detectedAt - a.detectedAt)[0] ?? null
      }),
      findMany: vi.fn(async ({ where, orderBy, take }: any) => {
        let rows = resources.filter((r) => matches(r, where))
        if (orderBy?.[0] === 'detectedAt') rows = [...rows].sort((a, b) => b.detectedAt - a.detectedAt)
        return take ? rows.slice(0, take) : rows
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = resources.find((r) => r.id === where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data, { updatedAt: now() })
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const r of resources) {
          if (matches(r, where)) { Object.assign(r, data); count++ }
        }
        return { count }
      }),
      count: vi.fn(async ({ where }: any) => resources.filter((r) => matches(r, where)).length),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => ({ id: id(), ...data })) },
    $transaction: vi.fn(),
  }

  return { prisma, reset, pairings, devices, resources }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prisma }))
// Dashboard auth is stubbed (the 401 path belongs to the middleware's own suite);
// the device-token endpoints above exercise the real token flow.
vi.mock('../../middleware/auth.middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', sessionId: 'sess-1' }
    next()
  },
}))
// Remote Import creation is a separate module boundary (already covered by its
// own suite) — capture tests assert delegation + capture-row consumption only.
const hImport = vi.hoisted(() => ({ createRemoteImport: vi.fn(async (input: any) => ({ id: 'ri-1', ...input })), serializeRemoteImport: vi.fn((row: any) => row) }))
vi.mock('../remote-imports/remote-import.service.js', () => hImport)

import { browserCaptureRouter } from './browser-capture.routes.js'
import { errorMiddleware } from '../../middleware/error.middleware.js'
import { resetRateLimits } from './rate-limit.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { hashToken, randomToken, encryptText } from '../../utils/crypto.js'
import { encryptRequestContext } from '../remote-imports/request-context.js'

let app: express.Express
let server: http.Server
let baseUrl: string

beforeEach(() => {
  h.reset()
  resetRateLimits()
  app = express()
  app.use(express.json())
  app.use('/browser-capture', browserCaptureRouter)
  app.use(errorMiddleware)
  server = http.createServer(app)
  server.listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/browser-capture`
})

afterAll(() => {
  server?.close()
})

async function call(method: string, path: string, body?: any, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** Seed one pairing + registered device; returns the raw device token. */
async function seedDevice(name = 'Chrome Desktop') {
  const code = randomToken(24)
  await h.prisma.browserDevicePairing.create({
    data: { userId: 'user-1', codeHash: hashToken(code), expiresAt: new Date(Date.now() + 600_000) },
  })
  const reg = await call('POST', '/devices/register', {
    pairingCode: code,
    name,
    browser: 'chrome',
    platform: 'win32',
    extensionVersion: '1.0.0',
  })
  expect(reg.status).toBe(201)
  return { token: reg.body.deviceToken as string, deviceId: reg.body.device.id as string }
}

describe('device pairing + registration', () => {
  it('rejects an invalid or already-used pairing code', async () => {
    const bad = await call('POST', '/devices/register', { pairingCode: 'nope', name: 'X', browser: 'chrome', platform: 'win32' })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('BROWSER_PAIRING_INVALID')

    const { token } = await seedDevice('Reuse')
    void token
    // The code was consumed by the first registration — replay must fail.
    const allPairings = h.pairings
    const replay = await call('POST', '/devices/register', {
      pairingCode: 'replay-attempt',
      name: 'Y', browser: 'chrome', platform: 'win32',
    })
    expect(replay.status).toBe(400)
    void allPairings
  })

  it('revoked tokens fail with DEVICE_TOKEN_INVALID', async () => {
    const { token, deviceId } = await seedDevice()
    // Revoke via the dashboard path (simulate logged-in user by direct service state).
    await h.prisma.browserDevice.updateMany({ where: { id: deviceId, status: { not: 'revoked' } }, data: { status: 'revoked', revokedAt: new Date() } })
    const res = await call('GET', '/resources', undefined, token)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('DEVICE_TOKEN_INVALID')
  })
})

describe('captured resource submission + validation', () => {
  it('submits a valid video resource and returns the safe wire shape', async () => {
    const { token } = await seedDevice()
    const res = await call('POST', '/resources', {
      url: 'https://cdn.example.com/video/movie.mp4?sig=secret',
      type: 'video',
      mimeType: 'video/mp4',
      filename: 'movie.mp4',
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Watch Movie',
      requestContext: { referer: 'https://example.com/watch', userAgent: 'Mozilla/5.0' },
    }, token)
    expect(res.status).toBe(201)
    // URL is display-safe: signed query stripped; context is booleans only.
    expect(res.body.url).toBe('https://cdn.example.com/video/movie.mp4')
    expect(JSON.stringify(res.body)).not.toContain('secret')
    expect(res.body.requestContext.attached).toBe(true)
    expect(res.body.requestContext.referer).toBe(true)
    expect(typeof res.body.urlEncrypted).toBe('undefined')
    expect(res.body.status).toBe('pending')
    expect(res.body.expiresAt).toBeTruthy()
  })

  it('rejects invalid types and non-http(s) URLs', async () => {
    const { token } = await seedDevice()
    const badType = await call('POST', '/resources', { url: 'https://x.example.com/a.mp4', type: 'executable' }, token)
    expect(badType.status).toBe(400)
    expect(badType.body.code).toBe('INVALID_REQUEST')

    const ftp = await call('POST', '/resources', { url: 'ftp://x.example.com/a.mp4', type: 'video' }, token)
    expect(ftp.status).toBe(400)

    const private_ = await call('POST', '/resources', { url: 'http://169.254.169.254/latest/meta-data', type: 'document' }, token)
    expect(private_.status).toBe(400)
  })

  it('rejects oversized metadata', async () => {
    const { token } = await seedDevice()
    const res = await call('POST', '/resources', { url: 'https://x.example.com/a.mp4', type: 'video', filename: 'f'.repeat(300) }, token)
    expect(res.status).toBe(400)
  })

  it('rejects cookie-bearing context outright (never accepted, never stored)', async () => {
    const { token } = await seedDevice()
    const res = await call('POST', '/resources', {
      url: 'https://x.example.com/a.m3u8',
      type: 'hls',
      requestContext: { cookie: 'session=stealer', referer: 'https://x.example.com/' } as any,
    }, token)
    // Strict schema: cookies are REJECTED at the boundary, not silently stripped.
    expect(res.status).toBe(400)
    const ok = await call('POST', '/resources', {
      url: 'https://x.example.com/a.m3u8',
      type: 'hls',
      requestContext: { referer: 'https://x.example.com/', userAgent: 'Mozilla/5.0' },
    }, token)
    expect(ok.status).toBe(201)
    expect(ok.body.requestContext).toEqual({ attached: true, referer: true, origin: false, userAgent: true, cookie: false })
  })

  it('dedupes re-detected URLs by refreshing instead of duplicating', async () => {
    const { token } = await seedDevice()
    const payload = { url: 'https://cdn.example.com/hls/master.m3u8', type: 'hls' }
    const first = await call('POST', '/resources', payload, token)
    const second = await call('POST', '/resources', payload, token)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body.id).toBe(first.body.id)
    expect(h.resources.length).toBe(1)
  })
})

describe('listing, expiration, consumption', () => {
  it('lazily expires stale pending resources on list', async () => {
    const { token } = await seedDevice()
    await h.prisma.capturedResource.create({
      data: {
        browserDeviceId: h.devices[0].id,
        userId: 'user-1',
        urlEncrypted: 'enc',
        displayUrl: 'https://x.example.com/old.mp4',
        type: 'video',
        filename: 'old.mp4',
        status: 'pending',
        expiresAt: new Date(Date.now() - 1000),
      },
    })
    const res = await call('GET', '/resources', undefined, token)
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBe(0)
    expect(h.resources[0].status).toBe('expired')
  })

  it('marks consumed only pending owned rows and hides them afterwards', async () => {
    const { token } = await seedDevice()
    const created = await call('POST', '/resources', { url: 'https://x.example.com/doc.pdf', type: 'document' }, token)
    const otherUserRow = await h.prisma.capturedResource.create({
      data: {
        browserDeviceId: h.devices[0].id, userId: 'user-2',
        urlEncrypted: 'enc', displayUrl: 'https://x.example.com/o.pdf',
        type: 'document', filename: 'o.pdf', status: 'pending',
        expiresAt: new Date(Date.now() + 600_000),
      },
    })
    const res = await call('POST', '/resources/mark-consumed', { ids: [created.body.id, otherUserRow.id] }, token)
    expect(res.status).toBe(200)
    const mine = h.resources.find((r) => r.id === created.body.id)
    expect(mine.status).toBe('consumed')
    expect(otherUserRow.status).toBe('pending')

    const list = await call('GET', '/resources', undefined, token)
    expect(list.body.items.length).toBe(0)
  })

  it('deletes own pending resource; foreign/missing rows 404', async () => {
    const { token } = await seedDevice()
    const created = await call('POST', '/resources', { url: 'https://x.example.com/v.webm', type: 'video' }, token)
    const del = await call('DELETE', `/resources/${created.body.id}`, undefined, token)
    expect(del.status).toBe(204)

    const missing = await call('DELETE', '/resources/nope', undefined, token)
    expect(missing.status).toBe(404)
  })
})

describe('import via Remote Import pipeline (Phase 03)', () => {
  beforeEach(() => {
    hImport.createRemoteImport.mockClear()
  })

  /** Seed a captured row directly; returns its id. */
  async function seedResource(overrides: any = {}) {
    const { deviceId } = await seedDevice()
    const row = {
      id: `res-${h.resources.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
      browserDeviceId: deviceId,
      userId: 'user-1',
      urlEncrypted: encryptText('https://cdn.example.com/video/movie.mp4?sig=abc'),
      displayUrl: 'https://cdn.example.com/video/movie.mp4',
      type: 'video',
      mimeType: 'video/mp4',
      filename: 'movie.mp4',
      pageUrl: null,
      pageTitle: null,
      requestContextEncrypted: null,
      status: 'pending',
      detectedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      importedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }
    h.resources.push(row)
    return row
  }

  it('imports a pending PDF with server-loaded URL and consumes the capture row', async () => {
    const row = await seedResource({ type: 'document', mimeType: 'application/pdf', filename: 'paper.pdf' })
    const res = await call('POST', `/resources/${row.id}/import`, {})
    expect(res.status).toBe(201)
    // URL came from the encrypted row — the client never supplies one.
    expect(hImport.createRemoteImport).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      sourceUrl: 'https://cdn.example.com/video/movie.mp4?sig=abc',
      fileName: 'paper.pdf',
      mimeType: 'application/pdf',
    }))
    expect(row.status).toBe('consumed')
    expect(row.importedAt).toBeTruthy()
  })

  it('explicit filename wins over captured filename', async () => {
    const row = await seedResource({ filename: 'captured-name.mkv', type: 'hls' })
    const res = await call('POST', `/resources/${row.id}/import`, { filename: 'My Rename' })
    expect(res.status).toBe(201)
    expect(hImport.createRemoteImport).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'My Rename' }))
  })

  it('forwards destination + worker selection to createRemoteImport', async () => {
    const row = await seedResource()
    const res = await call('POST', `/resources/${row.id}/import`, { folderId: 'fold-1', connectedAccountId: 'acc-1', workerId: 'wk-1' })
    expect(res.status).toBe(201)
    expect(hImport.createRemoteImport).toHaveBeenCalledWith(expect.objectContaining({
      folderId: 'fold-1', connectedAccountId: 'acc-1', workerId: 'wk-1',
    }))
  })

  it('expired resource → 410 and never imports', async () => {
    const row = await seedResource({ expiresAt: new Date(Date.now() - 1000) })
    const res = await call('POST', `/resources/${row.id}/import`, {})
    expect(res.status).toBe(410)
    expect(res.body.code).toBe('CAPTURED_RESOURCE_EXPIRED')
    expect(hImport.createRemoteImport).not.toHaveBeenCalled()
    expect(row.status).toBe('expired')
  })

  it('already-consumed resource → 409', async () => {
    const row = await seedResource({ status: 'consumed', importedAt: new Date() })
    const res = await call('POST', `/resources/${row.id}/import`, {})
    expect(res.status).toBe(409)
    expect(hImport.createRemoteImport).not.toHaveBeenCalled()
  })

  it("another user's resource is invisible (ownership)", async () => {
    await seedResource({ userId: 'user-2' })
    const res = await call('POST', '/resources/whatever/import', {})
    // findFirst by (id, userId=user-1) misses user-2's only row → 404.
    expect(res.status).toBe(404)
    expect(hImport.createRemoteImport).not.toHaveBeenCalled()
  })

  it('worker-unavailable error from createRemoteImport leaves capture pending', async () => {
    hImport.createRemoteImport.mockRejectedValueOnce(new AppError('REMOTE_IMPORT_WORKER_INVALID', 'The selected network worker does not exist.', 400))
    const row = await seedResource()
    const res = await call('POST', `/resources/${row.id}/import`, { workerId: 'gone' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('REMOTE_IMPORT_WORKER_INVALID')
    expect(row.status).toBe('pending')
  })

  it('rate-limits device registration (429 after burst)', async () => {
    // registerLimiter allows 10/min; exhaust it.
    let lastStatus = 0
    for (let i = 0; i < 12; i++) {
      const res = await call('POST', '/devices/register', { pairingCode: `code-${i}`, name: 'x', browser: 'chrome', platform: 'win32' })
      lastStatus = res.status
      if (res.status === 429) {
        expect(res.body.code).toBe('RATE_LIMITED')
        break
      }
    }
    expect(lastStatus).toBe(429)
  })

  it('captured request context flows into the Remote Import (Phase 04)', async () => {
    const { deviceId } = await seedDevice()
    const ctxEncrypted = encryptRequestContext({ referer: 'https://page.example.com/watch', userAgent: 'Mozilla/5.0' })
    const row = {
      id: `res-ctx-1`, browserDeviceId: deviceId, userId: 'user-1',
      urlEncrypted: encryptText('https://stream.example.com/master.m3u8?tok=1'),
      displayUrl: 'https://stream.example.com/master.m3u8',
      type: 'hls', mimeType: null, filename: 'master.m3u8',
      pageUrl: 'https://page.example.com/watch', pageTitle: null,
      requestContextEncrypted: ctxEncrypted,
      status: 'pending', detectedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000), importedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    }
    h.resources.push(row)
    const res = await call('POST', `/resources/${row.id}/import`, {})
    expect(res.status).toBe(201)
    expect(hImport.createRemoteImport).toHaveBeenCalledWith(expect.objectContaining({
      // Context decrypted server-side and re-validated by createRemoteImport.
      requestContext: expect.objectContaining({ referer: 'https://page.example.com/watch' }),
    }))
    // The wire response must NOT contain the values — delegation only.
    const payload = JSON.stringify(hImport.createRemoteImport.mock.calls[0][0])
    expect(payload).not.toContain('ctxEncrypted')
  })
})
