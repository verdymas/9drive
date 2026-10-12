import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'

const h = vi.hoisted(() => ({
  prismaMock: {
    serverBrowserSession: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  undiciRequest: vi.fn(),
}))

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

// The gateway streams undici's WHATWG body into Express. Mock the transport
// with a real WHATWG stream so the conversion path is genuinely exercised.
vi.mock('undici', () => ({
  Agent: class {
    constructor(_options?: unknown) {
      void _options
    }
  },
  request: (...args: unknown[]) => h.undiciRequest(...args),
}))

import { handleDisplayRequest, serverBrowserRouter } from './server-browser.routes.js'

type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> }
  matchers?: Array<(pathname: string) => unknown>
}

function controlRoutes(): Array<{ method: string; path: string; firstHandler: string }> {
  return (serverBrowserRouter.stack as unknown as RouteLayer[])
    .filter((layer) => layer.route)
    .map((layer) => ({
      method: Object.keys(layer.route!.methods).find((m) => layer.route!.methods[m])?.toUpperCase() ?? '',
      path: layer.route!.path,
      firstHandler: layer.route!.stack[0]?.name ?? '',
    }))
}

function mockRes() {
  const res: {
    statusCode: number
    body: unknown
    status(code: number): typeof res
    json(payload: unknown): typeof res
    setHeader(): void
    append(): void
    end(): void
  } = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
    setHeader() {},
    append() {},
    end() {},
  }
  return res
}

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    params: { id: 'session-1' },
    query: {},
    ...overrides,
  }
}

/**
 * Authentication gate: every control route is fronted by `requireAuth`, so
 * creating or accessing a session without a bearer token is rejected exactly
 * like every other module router (existing auth behavior unchanged).
 */
describe('server-browser authentication gate', () => {
  it.each([
    ['POST', '/sessions'],
    ['GET', '/sessions'],
    ['GET', '/sessions/:id'],
    ['DELETE', '/sessions/:id'],
    ['POST', '/sessions/:id/view-token'],
  ])('%s %s is fronted by requireAuth', (method, path) => {
    const found = controlRoutes().find((r) => r.method === method && r.path === path)
    expect(found, `${method} ${path} should exist`).toBeDefined()
    expect(found!.firstHandler).toBe('requireAuth')
  })

  it('mounts the token-bound display gateway', () => {
    const mounts = (serverBrowserRouter.stack as unknown as RouteLayer[]).filter((layer) => !layer.route)
    expect(mounts.length).toBeGreaterThan(0)
    // Express 5 layers expose path matchers: the display mount matches
    // session display paths and nothing else.
    const matchesDisplay = mounts.some((layer) =>
      (layer.matchers ?? []).some((match) => {
        try {
          return Boolean(match('/sessions/abc/display/')) && !Boolean(match('/files/abc'))
        } catch {
          return false
        }
      }),
    )
    expect(matchesDisplay).toBe(true)
  })
})

describe('display gateway token checks', () => {
  it('rejects a missing token before any proxying', async () => {
    const res = mockRes()
    await handleDisplayRequest(mockReq() as never, res as never)
    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: 'DISPLAY_TOKEN_REQUIRED' })
  })

  it('rejects an unknown session without distinguishing reasons', async () => {
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(null)
    const res = mockRes()
    await handleDisplayRequest(mockReq({ query: { token: 'garbage' } }) as never, res as never)
    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: 'DISPLAY_TOKEN_INVALID' })
  })

  it('maps an unreachable browser to a safe 502 without internals', async () => {
    const { hashToken } = await import('../../utils/crypto.js')
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue({
      id: 'session-1',
      status: 'ready',
      containerName: '9drive-browser-0123456789abcdef',
      viewTokenHash: hashToken('good-token'),
      viewTokenExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    h.prismaMock.serverBrowserSession.update.mockResolvedValue({})
    h.undiciRequest.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:6901'))
    const res = mockRes()
    await handleDisplayRequest(mockReq({ query: { token: 'good-token' } }) as never, res as never)
    expect(res.statusCode).toBe(502)
    expect(res.body).toMatchObject({ code: 'BROWSER_DISPLAY_UNAVAILABLE' })
  })

  it('streams a reachable browser UI instead of 500ing on its body', async () => {
    const { hashToken } = await import('../../utils/crypto.js')
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue({
      id: 'session-1',
      status: 'ready',
      containerName: '9drive-browser-0123456789abcdef',
      viewTokenHash: hashToken('good-token'),
      viewTokenExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    h.prismaMock.serverBrowserSession.update.mockResolvedValue({})
    // Regression: undici v7 bodies are Node Readables (`BodyReadable`) — the
    // handler once assumed WHATWG-only, called `fromWeb` on it, and every
    // display 500d. Both body kinds must stream.
    const payload = '<html>kasm</html>'
    const nodeBody = new PassThrough()
    nodeBody.end(payload)
    const webBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    for (const body of [nodeBody, webBody]) {
      h.undiciRequest.mockResolvedValueOnce({
        statusCode: 401,
        headers: { 'www-authenticate': 'Basic realm="Websockify"', 'content-type': 'text/html' },
        body,
      })
      const chunks: Buffer[] = []
      const headers: Record<string, unknown> = {}
      const res = new PassThrough() as PassThrough & {
        statusCode: number
        status(code: number): unknown
        setHeader(name: string, value: unknown): void
        append(name: string, value: unknown): void
      }
      res.statusCode = 200
      res.status = (code: number) => {
        res.statusCode = code
        return res
      }
      res.setHeader = (name: string, value: unknown) => {
        headers[name] = value
      }
      res.append = (name: string, value: unknown) => {
        headers[name] = value
      }
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      const done = new Promise<void>((resolve) => res.on('end', () => resolve()))
      await handleDisplayRequest(
        mockReq({ url: '/vnc.html', query: { token: 'good-token' } }) as never,
        res as never,
      )
      await done
      expect(res.statusCode).toBe(401)
      expect(headers['www-authenticate']).toBe('Basic realm="Websockify"')
      expect(Buffer.concat(chunks).toString()).toBe(payload)
    }
  })
})
