import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { Express } from 'express'

const h = vi.hoisted(() => {
  const prisma = {
    file: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findMany: vi.fn() },
    fileShare: { findFirst: vi.fn() },
    filePreviewToken: { findFirst: vi.fn() },
    userSession: { findUnique: vi.fn() },
  }
  return {
    env: {
      FRONTEND_URL: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'test-encryption-key-32bytes!!!',
      JWT_ACCESS_SECRET: 'test-jwt-secret-that-is-long-enough-1234',
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
      S3_DIRECT_DOWNLOAD_ENABLED: false,
      S3_DIRECT_DOWNLOAD_TTL_SECONDS: 300,
      WEBDAV_PASSWORD: '',
    },
    prisma,
    verifyAccessToken: vi.fn(),
    streamProviderFile: vi.fn(),
    webdavRouter: { configured: true },
  }
})

vi.mock('./config/env.js', () => ({ env: h.env }))
vi.mock('./config/prisma.js', () => ({ prisma: h.prisma }))
vi.mock('./utils/jwt.js', () => ({ verifyAccessToken: h.verifyAccessToken }))
vi.mock('./modules/files/stream-file.js', () => ({ streamProviderFile: h.streamProviderFile }))
// The media plane includes /webdav; stub its router so this test does not boot
// the webdav-server machinery (covered by the webdav suites).
vi.mock('./modules/webdav/webdav.routes.js', async () => {
  const { Router } = await import('express')
  const router = Router()
  router.get('/status', (_req: any, res: any) => res.json({ configured: Boolean(h.env.WEBDAV_PASSWORD) }))
  return { webdavRouter: router }
})
// BullMQ must not connect to Redis inside these tests.
vi.mock('./modules/remote-imports/queue.js', () => ({
  remoteImportQueueHealth: vi.fn(async () => ({ redis: 'down', worker: 'unknown' })),
}))

let createControlPlaneApp: () => Promise<Express>
let createMediaPlaneApp: () => Express

beforeAll(async () => {
  const composition = await import('./app-composition.js')
  createControlPlaneApp = composition.createControlPlaneApp
  createMediaPlaneApp = composition.createMediaPlaneApp
})

let server: Server | undefined

async function withApp(app: Express, run: (base: string) => Promise<void>) {
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  await run(`http://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())))
  server = undefined
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())))
    server = undefined
  }
  vi.clearAllMocks()
})

describe('all-in-one composition', () => {
  it('keeps control APIs and every media prefix on one app', async () => {
    await withApp(await createControlPlaneApp(), async (base) => {
      const health = await fetch(`${base}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ status: 'ok', remoteImportQueue: { redis: 'down' } })

      // Auth is identical on the media prefixes.
      const unauthorized = await fetch(`${base}/files/file-1/download`)
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.json()).toMatchObject({ code: 'AUTH_REQUIRED' })

      // Public preview token resolution reaches the stream handler or 404 by
      // token state — never falls through to "cannot GET" (route mounted).
      h.prisma.filePreviewToken.findFirst.mockResolvedValue(null)
      const preview = await fetch(`${base}/files/preview/nosuchtoken`)
      expect(preview.status).toBe(404)
      expect(await preview.json()).toMatchObject({ code: 'PREVIEW_NOT_FOUND' })

      // WebDAV status route remains reachable.
      const webdav = await fetch(`${base}/webdav/status`)
      expect(webdav.status).toBe(200)

      // A control-only JSON route answers (no fall-through to errorMiddleware 404).
      // The route list must therefore be complete.
      h.prisma.file.findMany.mockResolvedValue([])
      h.verifyAccessToken.mockReturnValue({ sub: 'user-1', sid: 'session-1' })
      h.prisma.userSession.findUnique.mockResolvedValue({ id: 'session-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
      const list = await fetch(`${base}/files`, { headers: { Authorization: 'Bearer tok' } })
      expect(list.status).toBe(200)
    })
  })
})

describe('media plane composition', () => {
  it('mounts the byte-heavy prefixes at the SAME external paths', async () => {
    await withApp(createMediaPlaneApp(), async (base) => {
      const health = await fetch(`${base}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ status: 'ok', plane: 'media' })

      const unauthorized = await fetch(`${base}/files/file-1/download`)
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.json()).toMatchObject({ code: 'AUTH_REQUIRED' })

      h.prisma.filePreviewToken.findFirst.mockResolvedValue(null)
      const preview = await fetch(`${base}/files/preview/nosuchtoken`)
      expect(preview.status).toBe(404)
      expect(await preview.json()).toMatchObject({ code: 'PREVIEW_NOT_FOUND' })

      // Public share resolution: the token lookup runs inside the shared
      // handler (an unknown token surfaces through the shared error
      // middleware) — proving the media plane reuses the same router.
      h.prisma.fileShare.findFirst.mockResolvedValue(null)
      const pub = await fetch(`${base}/public/files/deadbeef`)
      expect(pub.status).toBe(500)
      expect(h.prisma.fileShare.findFirst).toHaveBeenCalled()

      // Control-plane APIs are NOT mounted in the media plane.
      h.verifyAccessToken.mockReturnValue({ sub: 'user-1', sid: 'session-1' })
      h.prisma.userSession.findUnique.mockResolvedValue({ id: 'session-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
      const control = await fetch(`${base}/folders`, { headers: { Authorization: 'Bearer tok' } })
      expect(control.status).toBe(404)
      const telegram = await fetch(`${base}/telegram/accounts`, { headers: { Authorization: 'Bearer tok' } })
      expect(telegram.status).toBe(404)
    })
  })

  it('authorized attachment requests stream through the shared handler on both planes', async () => {
    h.verifyAccessToken.mockReturnValue({ sub: 'user-1', sid: 'session-1' })
    h.prisma.userSession.findUnique.mockResolvedValue({ id: 'session-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
    const file = { id: 'file-1', userId: 'user-1', status: 'active', name: 'movie.mkv', mimeType: 'video/x-matroska', sizeBytes: 4n, provider: 'google_drive', connectedAccount: {} }
    h.prisma.file.findFirst.mockResolvedValue(file)
    h.streamProviderFile.mockImplementation(async (_file: unknown, _range: unknown, res: any) => {
      res.status(206)
      res.setHeader('Content-Range', 'bytes 0-3/4')
      res.setHeader('Content-Type', 'video/x-matroska')
      return res.end('data')
    })

    for (const build of [() => Promise.resolve(createMediaPlaneApp()), createControlPlaneApp]) {
      await withApp(await build(), async (base) => {
        const response = await fetch(`${base}/files/file-1/download`, {
          headers: { Authorization: 'Bearer tok', Range: 'bytes=0-3' },
        })
        expect(response.status).toBe(206)
        expect(response.headers.get('content-range')).toBe('bytes 0-3/4')
        await response.text()
      })
    }
    // ONE handler implementation, used by both planes.
    expect(h.streamProviderFile).toHaveBeenCalledTimes(2)
  })
})
