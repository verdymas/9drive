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
    reauthRequiredAt: Date | null
    lastAuthErrorCode: string | null
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
    reauthRequiredAt: null,
    lastAuthErrorCode: null,
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
          if (where?.provider && a.provider !== where.provider) return false
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
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        return accounts.find((a) => {
          const keys = where?.userId_provider_providerAccountId ?? where?.id ? { id: where.id } : {}
          if (where?.userId_provider_providerAccountId) {
            const composite = where.userId_provider_providerAccountId
            if (a.userId !== composite.userId || a.provider !== composite.provider) return false
            if (a.providerAccountId !== composite.providerAccountId) return false
            return true
          }
          return keys.id ? a.id === keys.id : true
        }) ?? null
      }),
    },
    oauthState: {
      create: vi.fn(async ({ data }: { data: any }) => ({ id: 'state-1', ...data })),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { stateHash: string } }) => {
        const found = h.states.find((s) => s.stateHash === where.stateHash)
        if (!found) throw new Error('no state')
        return { providerConfig: { id: 'cfg-1', scopes: ['drive'], redirectUri: 'http://localhost/cb' }, ...found }
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const target = h.states.find((s) => s.id === where.id)
        if (!target) throw new Error('no state')
        Object.assign(target, data)
        return target
      }),
    },
    providerConfig: {
      findFirstOrThrow: vi.fn(async () => ({ id: 'cfg-1', scopes: ['drive'] })),
    },
    storageAccount: {
      upsert: vi.fn(async () => ({})),
    },
  }

  // Reconnect-flow extras: controllable state store + Google userinfo + OAuth2.
  const states: Array<{ id: string; userId: string; providerConfigId: string; flow: string; stateHash: string; connectedAccountId: string | null; usedAt: Date | null; expiresAt: Date }> = []
  let userinfoImpl: () => Promise<{ data: { id?: string; email?: string; name?: string; picture?: string } }> = async () => ({ data: {} })
  let getTokenImpl: (code: string) => Promise<{ tokens: Record<string, string | number | undefined> }> = async () => ({ tokens: {} })
  let authUrlImpl: string = 'https://accounts.google.com/o/oauth2/auth?state=token-1'
  const FakeOAuth2 = class {
    generateAuthUrl = vi.fn(() => h.authUrlImpl)
    getToken = vi.fn(async (code: string) => h.getTokenImpl(code))
    setCredentials = vi.fn()
  }

  return {
    prismaMock,
    accounts,
    account,
    auditCalls,
    states,
    userinfoImpl: null as unknown as typeof userinfoImpl,
    getTokenImpl,
    authUrlImpl,
    FakeOAuth2,
    now,
  }
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
  google: {
    oauth2: vi.fn(() => ({ userinfo: { get: async () => h.userinfoImpl() } })),
    drive: vi.fn(),
    auth: { OAuth2: h.FakeOAuth2 },
  },
}))

vi.mock('../google/google.service.js', () => ({
  createOAuthClient: () => new h.FakeOAuth2(),
  syncGoogleQuota: vi.fn(async () => { throw new Error('quota not mocked in reconnect tests') }),
  replaceCredentialsAfterReconnect: async (accountId: string, data: Record<string, unknown>) => {
    // Mirrors the real function: atomic credential replacement + ACTIVE state.
    const target = h.accounts.find((a) => a.id === accountId)
    if (!target) throw new Error('not found')
    Object.assign(target, data, { status: 'connected', reauthRequiredAt: null, lastAuthErrorCode: null, lastError: null, updatedAt: new Date() })
    return target
  },
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
// Map AppError-style errors like the production error middleware does, so
// routes that call `next(error)` still return JSON in tests.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.code && err?.status) return res.status(err.status).json({ code: err.code, message: err.message })
  return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: err?.message ?? 'Internal server error' })
})

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
  h.states.length = 0
  h.userinfoImpl = async () => ({ data: {} })
  h.getTokenImpl = async () => ({ tokens: {} })
  ;(h.prismaMock.connectedAccount.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where?: any } = {}) => {
    return h.accounts.find((a) => {
      if (where?.id && a.id !== where.id) return false
      if (where?.userId && a.userId !== where.userId) return false
      if (where?.provider && a.provider !== where.provider) return false
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
  ;(h.prismaMock.oauthState.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => {
    const row = { id: 'state-1', ...data }
    h.states.push(row)
    return row
  })
  ;(h.prismaMock.oauthState.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where: { stateHash: string } }) => {
    const found = h.states.find((s) => s.stateHash === where.stateHash)
    if (!found) throw new Error('no state')
    return { providerConfig: { id: 'cfg-1', scopes: ['drive'], redirectUri: 'http://localhost/cb' }, ...found }
  })
  ;(h.prismaMock.oauthState.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) => {
    const target = h.states.find((s) => s.id === where.id)
    if (!target) throw new Error('no state')
    Object.assign(target, data)
    return target
  })
}

/** Prime a state row + Google profile/response for the reconnect callback. */
function primeReconnectCallback(accountId: string, userId: string, overrides: { usedAt?: Date | null; expiresAt?: Date; profileId?: string; refreshToken?: string | null; accessToken?: string } = {}) {
  h.states.push({
    id: 'state-1',
    userId,
    providerConfigId: 'cfg-1',
    flow: 'reconnect',
    stateHash: 'hash:token-1',
    connectedAccountId: accountId,
    usedAt: overrides.usedAt ?? null,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 10 * 60_000),
  })
  h.userinfoImpl = async () => ({ data: { id: overrides.profileId ?? `${accountId}-gid`, email: `${accountId}@example.com`, name: `${accountId}`, picture: null as unknown as string } })
  h.getTokenImpl = async () => ({
    tokens: {
      access_token: overrides.accessToken ?? 'ACCESS_NEW',
      refresh_token: overrides.refreshToken === undefined ? 'REFRESH_NEW' : overrides.refreshToken,
      expiry_date: Date.now() + 3600_000,
    },
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

describe('GET /connected-accounts — ?includeDisconnected', () => {
  beforeEach(() => {
    reset()
    // Rows already have a synced quota, so the handler does not re-query.
    ;(h.prismaMock.connectedAccount.findMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where: any }) => {
      return h.accounts
        .filter((a) => a.userId === where.userId && where.status.in.includes(a.status))
        .map((a) => ({ ...a, storageAccount: { ...a.storageAccount, lastSyncedAt: h.now, trashBytes: null } }))
    })
  })

  it('hides disconnected accounts by default', async () => {
    const dead = h.account('acc-dead', 'user-1')
    dead.status = 'disconnected'
    h.accounts.push(h.account('acc-live', 'user-1'), dead)

    const res = await api('GET', '')
    expect(res.status).toBe(200)
    expect(res.json.accounts.map((a: any) => a.id)).toEqual(['acc-live'])
  })

  it('lists them with ?includeDisconnected=1 so an abandoned channel can be reconnected', async () => {
    // A disconnected Telegram account still holds its `providerAccountId` (the
    // channel id), so it must be reachable in Settings or the channel is
    // permanently blocked by a 409 with no way to release it.
    const dead = h.account('acc-dead', 'user-1')
    dead.status = 'disconnected'
    h.accounts.push(h.account('acc-live', 'user-1'), dead)

    const res = await api('GET', '?includeDisconnected=1')
    expect(res.status).toBe(200)
    expect(res.json.accounts.map((a: any) => a.id).sort()).toEqual(['acc-dead', 'acc-live'])
  })

  it('ignores any other value for the flag', async () => {
    const dead = h.account('acc-dead', 'user-1')
    dead.status = 'disconnected'
    h.accounts.push(dead)

    expect((await api('GET', '?includeDisconnected=true')).json.accounts).toEqual([])
  })
})

describe('POST /connected-accounts/:id/reconnect', () => {
  beforeEach(reset)

  it('creates a reconnect OAuth state bound to the existing account and returns a URL', async () => {
    h.accounts.push(h.account('acc-a', 'user-1'))
    const res = await api('POST', '/acc-a/reconnect')
    expect(res.status).toBe(200)
    expect(res.json.url).toBe(h.authUrlImpl)
    const state = h.states.find((s) => s.flow === 'reconnect')
    expect(state).toBeDefined()
    expect(state!.connectedAccountId).toBe('acc-a')
    expect(state!.userId).toBe('user-1')
    expect(state!.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000)
  })

  it('returns 404 when the account belongs to another user', async () => {
    h.accounts.push(h.account('acc-a', 'user-2'))
    const res = await api('POST', '/acc-a/reconnect')
    expect(res.status).toBe(404)
    expect(res.json.code).toBe('STORAGE_ACCOUNT_NOT_FOUND')
  })

  it('returns 400 for an S3 account', async () => {
    h.accounts.push({ ...h.account('acc-s3', 'user-1'), provider: 's3' })
    const res = await api('POST', '/acc-s3/reconnect')
    expect(res.status).toBe(400)
    expect(h.states).toHaveLength(0)
  })
})

describe('GET /google/callback — reconnect flow', () => {
  beforeEach(reset)

  it('updates the SAME account (id unchanged), clears reauth, preserves autoAllocationEnabled', async () => {
    const acc = h.account('acc-a', 'user-1', true)
    acc.status = 'reauth_required'
    acc.reauthRequiredAt = new Date()
    acc.lastAuthErrorCode = 'GOOGLE_OAUTH_INVALID_GRANT'
    h.accounts.push(acc)
    primeReconnectCallback('acc-a', 'user-1')

    const res = await fetch(`${baseUrl}/connected-accounts/google/callback?code=c1&state=token-1`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('google-connected?status=success')

    expect(h.accounts).toHaveLength(1) // never a second account
    expect(h.accounts[0].id).toBe('acc-a')
    expect(h.accounts[0].status).toBe('connected')
    expect(h.accounts[0].reauthRequiredAt).toBeNull()
    expect(h.accounts[0].lastAuthErrorCode).toBeNull()
    expect(h.accounts[0].autoAllocationEnabled).toBe(true) // preference preserved
    expect(h.accounts[0].accessTokenEncrypted).toBe('enc:ACCESS_NEW')
    expect(h.accounts[0].refreshTokenEncrypted).toBe('enc:REFRESH_NEW')
    // State consumed (single use).
    expect(h.states.find((s) => s.id === 'state-1')!.usedAt).not.toBeNull()
  })

  it('rejects a different Google account and leaves credentials untouched', async () => {
    const acc = h.account('acc-a', 'user-1')
    acc.status = 'reauth_required'
    h.accounts.push(acc)
    primeReconnectCallback('acc-a', 'user-1', { profileId: 'other-google-id' })

    const res = await fetch(`${baseUrl}/connected-accounts/google/callback?code=c1&state=token-1`)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('GOOGLE_RECONNECT_ACCOUNT_MISMATCH')
    expect(h.accounts[0].status).toBe('reauth_required')
    expect(h.accounts[0].accessTokenEncrypted).toBe('ENC_ACCESS')
    expect(h.accounts[0].refreshTokenEncrypted).toBe('ENC_REFRESH')
  })

  it('fails reconnect when no refresh token is returned (old unusable token kept)', async () => {
    const acc = h.account('acc-a', 'user-1')
    acc.status = 'reauth_required'
    h.accounts.push(acc)
    primeReconnectCallback('acc-a', 'user-1', { refreshToken: null })

    const res = await fetch(`${baseUrl}/connected-accounts/google/callback?code=c1&state=token-1`)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('GOOGLE_OAUTH_REFRESH_TOKEN_MISSING')
    expect(h.accounts[0].status).toBe('reauth_required')
    expect(h.accounts[0].refreshTokenEncrypted).toBe('ENC_REFRESH')
  })

  it('rejects an expired state', async () => {
    const acc = h.account('acc-a', 'user-1')
    h.accounts.push(acc)
    primeReconnectCallback('acc-a', 'user-1', { expiresAt: new Date(Date.now() - 1000) })
    const res = await fetch(`${baseUrl}/connected-accounts/google/callback?code=c1&state=token-1`)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('GOOGLE_OAUTH_STATE_INVALID')
  })

  it('rejects an already-used state (single-use)', async () => {
    const acc = h.account('acc-a', 'user-1')
    h.accounts.push(acc)
    primeReconnectCallback('acc-a', 'user-1', { usedAt: new Date() })
    const res = await fetch(`${baseUrl}/connected-accounts/google/callback?code=c1&state=token-1`)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('GOOGLE_OAUTH_STATE_INVALID')
    expect(h.accounts[0].status).toBe('connected') // untouched
  })

  it('rejects an unknown state (redirects to the error page, existing callback convention)', async () => {
    const res = await fetch(`${baseUrl}/connected-accounts/google/callback?code=c1&state=forged`, { redirect: 'manual' })
    // Unknown state → `findUniqueOrThrow` throws → callback catch redirects to
    // the error page, matching the pre-existing connect-callback behavior.
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('google-connected?status=error')
  })
})
