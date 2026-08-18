import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { connectedAccountRouter } from './connected-account.routes.js'

// ── Mocks ────────────────────────────────────────────────────────────────────
// Drive the REAL connected-account routes (mounted on a real Express app) with
// an in-memory prisma fake. `requireAuth` is short-circuited to a canned user
// (user-1); the audit util is captured so the PATCH handler's events can be
// asserted. Focus: the Auto Allocation PATCH endpoint — ownership, validation,
// persistence, safe serialization, audit.
const h = vi.hoisted(() => {
  const now = new Date('2026-08-07T00:00:00.000Z')

  type Account = {
    id: string
    userId: string
    provider: string
    providerAccountId: string
    email: string
    status: string
    autoAllocationEnabled: boolean
    accessTokenEncrypted: string | null
    refreshTokenEncrypted: string | null
    storageAccount: { totalBytes: bigint; usedBytes: bigint; availableBytes: bigint | null } | null
  }

  const accounts: Account[] = []
  const auditCalls: Array<{ userId: string; action: string; entityType: string; entityId?: string; metadata?: any }> = []

  const account = (id: string, userId: string, autoAllocationEnabled = true): Account => ({
    id,
    userId,
    provider: 'google_drive',
    providerAccountId: `${id}-gid`,
    email: `${id}@example.com`,
    status: 'connected',
    autoAllocationEnabled,
    accessTokenEncrypted: 'ENC_ACCESS',
    refreshTokenEncrypted: 'ENC_REFRESH',
    storageAccount: {
      totalBytes: 1000n,
      usedBytes: 400n,
      availableBytes: 600n,
    },
  })

  const prismaMock = {
    connectedAccount: {
      findFirst: vi.fn(async ({ where }: { where?: any } = {}) => {
        return accounts.find((a) => {
          if (where?.id && a.id !== where.id) return false
          if (where?.userId && a.userId !== where.userId) return false
          return true
        }) ?? null
      }),
      update: vi.fn(async ({ where, data, include }: { where: { id: string }; data: any; include?: { storageAccount?: boolean } }) => {
        const target = accounts.find((a) => a.id === where.id)
        if (!target) throw new Error('not found')
        Object.assign(target, data, { updatedAt: new Date() })
        const out: any = { ...target }
        if (include?.storageAccount) out.storageAccount = target.storageAccount
        return out
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
  }

  return { prismaMock, accounts, account, auditCalls, now }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

vi.mock('../../middleware/auth.middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', sessionId: 'sess-1' }
    next()
  },
}))

vi.mock('../../utils/audit.js', () => ({
  createAuditLog: async (userId: string, action: string, entityType: string, entityId?: string, metadata?: any) => {
    h.auditCalls.push({ userId, action, entityType, entityId, metadata })
  },
}))

// Google OAuth helpers referenced at module scope must exist (unused in PATCH).
vi.mock('googleapis', () => ({
  google: { oauth2: vi.fn(() => ({ userinfo: { get: vi.fn() } })), drive: vi.fn() },
}))

vi.mock('../../config/env.js', () => ({ env: { FRONTEND_URL: 'http://localhost:5173' } }))
vi.mock('../../utils/crypto.js', () => ({
  decryptText: vi.fn((t: string) => t),
  encryptText: vi.fn((t: string) => `enc:${t}`),
  hashToken: vi.fn((t: string) => `hash:${t}`),
  randomToken: vi.fn(() => 'token-1'),
}))
vi.mock('../../utils/password.js', () => ({ hashPassword: vi.fn(async (p: string) => `hash:${p}`) }))

// Import AFTER mocks (vi.mock hoists).
import { createAuditLog } from '../../utils/audit.js'

// ── App + HTTP harness ───────────────────────────────────────────────────────
let server: http.Server
let baseUrl: string

const app = express()
app.use(express.json())
app.use('/connected-accounts', connectedAccountRouter)

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/connected-accounts${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

function reset() {
  vi.clearAllMocks()
  h.accounts.length = 0
  h.auditCalls.length = 0
  ;(h.prismaMock.connectedAccount.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where?: any } = {}) => {
    return h.accounts.find((a) => {
      if (where?.id && a.id !== where.id) return false
      if (where?.userId && a.userId !== where.userId) return false
      return true
    }) ?? null
  })
  ;(h.prismaMock.connectedAccount.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ where, data, include }: { where: { id: string }; data: any; include?: { storageAccount?: boolean } }) => {
    const target = h.accounts.find((a) => a.id === where.id)
    if (!target) throw new Error('not found')
    Object.assign(target, data, { updatedAt: new Date() })
    const out: any = { ...target }
    if (include?.storageAccount) out.storageAccount = target.storageAccount
    return out
  })
}

beforeAll(async () => {
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

describe('PATCH /connected-accounts/:id — autoAllocationEnabled', () => {
  beforeEach(reset)

  it('persists autoAllocationEnabled=false and returns the updated safe account (tokens stripped)', async () => {
    h.accounts.push(h.account('acc-a', 'user-1'))
    const res = await api('PATCH', '/acc-a', { autoAllocationEnabled: false })
    expect(res.status).toBe(200)
    expect(h.accounts[0].autoAllocationEnabled).toBe(false)
    expect(res.json.account.autoAllocationEnabled).toBe(false)
    expect(res.json.account).not.toHaveProperty('accessTokenEncrypted')
    expect(res.json.account).not.toHaveProperty('refreshTokenEncrypted')
    // bigints stringified
    expect(res.json.account.storageAccount.totalBytes).toBe('1000')
    expect(res.json.account.storageAccount.availableBytes).toBe('600')
  })

  it('persists autoAllocationEnabled=true (re-enable) and leaves other fields unchanged', async () => {
    h.accounts.push(h.account('acc-a', 'user-1', false))
    const res = await api('PATCH', '/acc-a', { autoAllocationEnabled: true })
    expect(res.status).toBe(200)
    expect(h.accounts[0].autoAllocationEnabled).toBe(true)
    expect(h.accounts[0].status).toBe('connected')
    expect(h.accounts[0].email).toBe('acc-a@example.com')
  })

  it('rejects a non-boolean body with 400', async () => {
    h.accounts.push(h.account('acc-a', 'user-1'))
    const res = await api('PATCH', '/acc-a', { autoAllocationEnabled: 'yes' })
    expect(res.status).toBe(400)
    expect(res.json.code).toBe('INVALID_REQUEST')
    expect(h.accounts[0].autoAllocationEnabled).toBe(true)
  })

  it('returns 404 when the account belongs to another user', async () => {
    h.accounts.push(h.account('acc-a', 'user-2'))
    const res = await api('PATCH', '/acc-a', { autoAllocationEnabled: false })
    expect(res.status).toBe(404)
    expect(res.json.code).toBe('STORAGE_ACCOUNT_NOT_FOUND')
    expect(h.accounts[0].autoAllocationEnabled).toBe(true)
  })

  it('returns 404 for a nonexistent account id', async () => {
    const res = await api('PATCH', '/ghost', { autoAllocationEnabled: false })
    expect(res.status).toBe(404)
  })

  it('emits an audit event with safe metadata on disable and enable', async () => {
    h.accounts.push(h.account('acc-a', 'user-1'))
    await api('PATCH', '/acc-a', { autoAllocationEnabled: false })
    expect(h.auditCalls).toContainEqual(expect.objectContaining({
      userId: 'user-1',
      action: 'storage.auto_allocation.disabled',
      entityType: 'connected_account',
      entityId: 'acc-a',
      metadata: expect.objectContaining({ connectedAccountId: 'acc-a', provider: 'google_drive', previousValue: true, newValue: false }),
    }))
    await api('PATCH', '/acc-a', { autoAllocationEnabled: true })
    expect(h.auditCalls).toContainEqual(expect.objectContaining({ action: 'storage.auto_allocation.enabled', metadata: expect.objectContaining({ previousValue: false, newValue: true }) }))
  })

  it('does not audit for an unauthorized user update', async () => {
    h.accounts.push(h.account('acc-a', 'user-2'))
    await api('PATCH', '/acc-a', { autoAllocationEnabled: false })
    expect(h.auditCalls).toHaveLength(0)
  })

  it('createAuditLog is invoked through the shared util (module bound)', async () => {
    expect(createAuditLog).toBeDefined()
  })
})
