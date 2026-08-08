import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { syncRouter } from './sync.routes.js'
import { emptyStats } from './sync-run.service.js'

/**
 * Sync routes — auth, POST /sync/all, POST /sync/account/:id, GET /sync/runs.
 * The service layer is mocked; the routes are mounted on a real Express app.
 */
const h = vi.hoisted(() => {
  const syncAll = vi.fn()
  const syncAccount = vi.fn()
  const cancelSync = vi.fn()
  const listRuns = vi.fn()
  return { syncAll, syncAccount, cancelSync, listRuns }
})

vi.mock('./sync.service.js', () => ({
  runSyncAll: (...args: unknown[]) => h.syncAll(...args),
  runAccountSync: (...args: unknown[]) => h.syncAccount(...args),
  cancelAccountSync: (...args: unknown[]) => h.cancelSync(...args),
}))

vi.mock('./sync-run.service.js', () => ({
  listRecentSyncRuns: (...args: unknown[]) => h.listRuns(...args),
  emptyStats: () => ({
    foldersDiscovered: 0, filesDiscovered: 0, foldersCreated: 0, mappingsCreated: 0, mappingsReused: 0,
    mappingsDetached: 0, filesCreated: 0, filesUpdated: 0, filesMoved: 0, filesMissing: 0, mappingsMissing: 0, collisionsDetected: 0,
  }),
}))

vi.mock('../../middleware/auth.middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', sessionId: 'sess-1' }
    next()
  },
}))

const app = express()
app.use(express.json())
app.use('/sync', syncRouter)

let server: http.Server
let baseUrl: string

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/sync${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

beforeAll(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  vi.clearAllMocks()
  h.syncAll.mockResolvedValue({ results: [{ accountId: 'a1', provider: 'google_drive', status: 'completed', runId: 'run-1', stats: emptyStats() }] })
  h.syncAccount.mockResolvedValue({ accountId: 'a1', provider: 'google_drive', status: 'completed', runId: 'run-1', stats: emptyStats() })
  h.listRuns.mockResolvedValue([{ id: 'run-1', userId: 'user-1', connectedAccountId: 'a1', provider: 'google_drive', status: 'completed' }])
})

describe('POST /sync/all', () => {
  it('runs sync all and returns per-account results', async () => {
    const { status, json } = await api('POST', '/all')
    expect(status).toBe(200)
    expect(json.status).toBe('ok')
    expect(json.results).toHaveLength(1)
    expect(h.syncAll).toHaveBeenCalledWith('user-1')
  })
})

describe('POST /sync/account/:id', () => {
  it('syncs a single account', async () => {
    const { status, json } = await api('POST', '/account/a2')
    expect(status).toBe(200)
    expect(json.result.accountId).toBe('a1') // service result passed through
    expect(h.syncAccount).toHaveBeenCalledWith('user-1', 'a2')
  })
})

describe('POST /sync/account/:id/cancel', () => {
  it('requests cancellation and returns immediately', async () => {
    const { status, json } = await api('POST', '/account/a2/cancel')
    expect(status).toBe(200)
    expect(json.status).toBe('cancelling')
    expect(h.cancelSync).toHaveBeenCalledWith('a2')
  })
})

describe('GET /sync/runs', () => {
  it('lists recent runs with a bounded limit', async () => {
    const { status, json } = await api('GET', '/runs?limit=5')
    expect(status).toBe(200)
    expect(json.runs).toHaveLength(1)
    expect(h.listRuns).toHaveBeenCalledWith('user-1', 5)
  })

  it('caps the limit at 50', async () => {
    await api('GET', '/runs?limit=999')
    expect(h.listRuns).toHaveBeenCalledWith('user-1', 50)
  })
})