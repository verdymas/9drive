import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks: isolate the credential service from prisma + googleapis ──────────
// Accounts are seeded with a fake token pair (plaintext stands in for the
// encrypted columns; the service round-trips via crypto — the plaintext
// survives because AES-GCM round-trips, so assertions compare plaintext).
const h = vi.hoisted(() => {
  const now = new Date('2026-08-18T00:00:00.000Z')
  const account = (overrides: Record<string, unknown> = {}) => ({
    id: 'acc-a',
    userId: 'user-1',
    providerConfigId: 'cfg-1',
    provider: 'google_drive',
    providerAccountId: 'google-id-1',
    email: 'a@example.com',
    displayName: 'A',
    avatarUrl: null,
    accessTokenEncrypted: 'enc:access-a',
    refreshTokenEncrypted: 'enc:refresh-a',
    tokenExpiresAt: new Date(now.getTime() - 60_000), // expired → refresh path
    scopes: [],
    status: 'connected',
    autoAllocationEnabled: true,
    lastError: null,
    reauthRequiredAt: null,
    lastAuthErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })

  const prismaMock = {
    connectedAccount: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = h.accounts.get(where.id)
        if (!found) throw new Error('not found')
        return found
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        return { ...h.accounts.get(where.id), ...data }
      }),
    },
    providerConfig: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: 'cfg-1',
        clientIdEncrypted: 'enc:client-id',
        clientSecretEncrypted: 'enc:client-secret',
        redirectUri: 'http://localhost:5173/callback',
      })),
    },
    storageAccount: {
      upsert: vi.fn(async () => ({})),
    },
  }

  let refreshImpl: ((options?: unknown) => Promise<{ credentials: Record<string, unknown> }>) | null = null
  const client = {
    setCredentials: vi.fn(),
    refreshAccessToken: vi.fn(async (options?: unknown) => {
      if (!h.refreshImpl) throw new Error('refreshAccessToken not stubbed')
      return h.refreshImpl(options)
    }),
  }

  return {
    account,
    prismaMock,
    client,
    accounts: new Map<string, ReturnType<typeof h.account>>(),
    refreshImpl: null as typeof refreshImpl,
    // OAuth2 subclass whose instances are all the same controllable client.
    // Must live in the hoisted block: vi.mock factories run before class
    // declarations at the top level.
    FakeOAuth2: class {
      setCredentials = h.client.setCredentials
      refreshAccessToken = h.client.refreshAccessToken
    },
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

// Identity crypto: the service decrypts/encrypts token columns; plaintext
// round-trips, so assertions compare plaintext directly. (Crypto itself has
// its own coverage; this isolates the credential logic.)
vi.mock('../../utils/crypto.js', () => ({
  encryptText: (value: string) => value,
  decryptText: (value: string) => value,
  randomToken: (bytes = 32) => 'random-token',
  hashToken: (value: string) => `hash:${value}`,
}))

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: h.FakeOAuth2 },
    drive: vi.fn(() => ({ about: { get: vi.fn() }, files: { list: vi.fn(), create: vi.fn() } })),
    oauth2: vi.fn(() => ({ userinfo: { get: vi.fn() } })),
  },
}))

import { getAuthedGoogleClient, syncGoogleQuota, classifyOAuthRefreshError, markReauthRequired, refreshAccessToken } from './google.service.js'

/** GaxiosError-shaped failure, as the googleapis library throws on a bad refresh. */
function gaxiosError(status: number, errorCode?: string, description?: string) {
  const data: Record<string, string> = {}
  if (errorCode !== undefined) data.error = errorCode
  if (description !== undefined) data.error_description = description
  return Object.assign(new Error(errorCode ? `${errorCode}: ${description ?? ''}`.trim() : `HTTP ${status}`), {
    response: { status, data: Object.keys(data).length ? data : undefined },
    code: status,
  })
}

function seedAccount(overrides: Record<string, unknown> = {}) {
  const acc = h.account(overrides)
  h.accounts.set(acc.id, acc)
  return acc
}

async function refreshOk(options?: unknown) {
  return { credentials: { access_token: 'access-new', expiry_date: Date.now() + 3600_000, ...(options as object) } }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.accounts.clear()
  h.refreshImpl = refreshOk
  ;(h.prismaMock.connectedAccount.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 })
  ;(h.prismaMock.connectedAccount.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where: { id: string } }) => {
    const found = h.accounts.get(where.id)
    if (!found) throw new Error('not found')
    return found
  })
})

describe('classifyOAuthRefreshError', () => {
  it('invalid_grant from the structured error field', () => {
    expect(classifyOAuthRefreshError(gaxiosError(400, 'invalid_grant', 'Token has been expired or revoked.'))).toBe('invalid_grant')
  })
  it('invalid_grant from error_description only', () => {
    expect(classifyOAuthRefreshError(gaxiosError(400, undefined, 'invalid_grant: token revoked'))).toBe('invalid_grant')
  })
  it('transient HTTP classes are retryable, never reauth', () => {
    expect(classifyOAuthRefreshError(gaxiosError(429))).toBe('transient')
    expect(classifyOAuthRefreshError(gaxiosError(503))).toBe('transient')
    expect(classifyOAuthRefreshError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe('transient')
  })
  it('configuration errors (invalid_client) are NOT reauth', () => {
    expect(classifyOAuthRefreshError(gaxiosError(400, 'invalid_client', 'bad'))).toBe('unknown')
  })
})

describe('refreshAccessToken', () => {
  it('persists access token + expiry, keeps stored refresh token when none returned', async () => {
    h.refreshImpl = async () => ({ credentials: { access_token: 'access-new', expiry_date: 999 } })
    seedAccount()
    const updated = await refreshAccessToken(h.accounts.get('acc-a')!)
    expect(updated.accessTokenEncrypted).not.toBe('enc:access-a')
    expect(updated.tokenExpiresAt.getTime()).toBe(999)
    const updateData = (h.prismaMock.connectedAccount.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(updateData).not.toHaveProperty('refreshTokenEncrypted') // never null-overwritten
  })

  it('rotates the refresh token when Google supplies a new one', async () => {
    h.refreshImpl = async () => ({ credentials: { access_token: 'access-new', refresh_token: 'refresh-new', expiry_date: 999 } })
    seedAccount()
    const updated = await refreshAccessToken(h.accounts.get('acc-a')!)
    expect(updated.refreshTokenEncrypted).toBe('refresh-new')
  })

  it('invalid_grant → marks REAUTH_REQUIRED and throws GOOGLE_REAUTH_REQUIRED', async () => {
    h.refreshImpl = async () => { throw gaxiosError(400, 'invalid_grant', 'Token has been expired or revoked.') }
    seedAccount()
    await expect(refreshAccessToken(h.accounts.get('acc-a')!)).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED', status: 401 })
    expect(h.prismaMock.connectedAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 'acc-a', provider: 'google_drive', status: { not: 'reauth_required' } },
      data: expect.objectContaining({ status: 'reauth_required', lastAuthErrorCode: 'GOOGLE_OAUTH_INVALID_GRANT' }),
    })
  })

  it('transient failure → GOOGLE_OAUTH_REFRESH_FAILED, account NOT marked', async () => {
    h.refreshImpl = async () => { throw gaxiosError(503) }
    seedAccount()
    await expect(refreshAccessToken(h.accounts.get('acc-a')!)).rejects.toMatchObject({ code: 'GOOGLE_OAUTH_REFRESH_FAILED', status: 503 })
    expect(h.prismaMock.connectedAccount.updateMany).not.toHaveBeenCalled()
  })

  it('already-reauth account fails fast without calling Google', async () => {
    const acc = seedAccount({ status: 'reauth_required', reauthRequiredAt: new Date() })
    await expect(refreshAccessToken(acc)).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' })
    expect(h.client.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('concurrent refreshes make exactly ONE Google refresh call', async () => {
    seedAccount()
    let resolveGate: (value: unknown) => void
    const gate = new Promise((resolve) => { resolveGate = resolve })
    let calls = 0
    h.refreshImpl = async () => {
      calls += 1
      await gate
      return { credentials: { access_token: 'access-new', expiry_date: Date.now() + 3600_000 } }
    }
    const p1 = refreshAccessToken(h.accounts.get('acc-a')!)
    const p2 = refreshAccessToken(h.accounts.get('acc-a')!)
    await new Promise((r) => setTimeout(r, 10))
    resolveGate!(null)
    await Promise.all([p1, p2])
    expect(calls).toBe(1)
  })

  it('stale account object sees a concurrent invalid_grant transition and fails fast', async () => {
    const stale = seedAccount()
    h.refreshImpl = async () => { throw gaxiosError(400, 'invalid_grant', 'revoked') }
    // First caller marks reauth + throws.
    await expect(refreshAccessToken(stale)).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' })
    // Simulate the CAS actually transitioning the row (the fake returns count 1).
    h.accounts.get('acc-a')!.status = 'reauth_required'
    h.accounts.get('acc-a')!.reauthRequiredAt = new Date()
    // Second caller with the same stale object must not refresh again.
    await expect(refreshAccessToken(stale)).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' })
    expect(h.client.refreshAccessToken).toHaveBeenCalledTimes(1)
  })
})

describe('getAuthedGoogleClient', () => {
  it('throws GOOGLE_REAUTH_REQUIRED for a reauth account without touching Google', async () => {
    const acc = seedAccount({ status: 'reauth_required' })
    await expect(getAuthedGoogleClient(acc)).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' })
    expect(h.client.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('refreshes an expired token and returns a usable client', async () => {
    seedAccount()
    const client = await getAuthedGoogleClient(h.accounts.get('acc-a')!)
    expect(client).toBeDefined()
    expect(h.client.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(h.prismaMock.connectedAccount.update).toHaveBeenCalled()
  })

  it('skips refresh while the token is still fresh', async () => {
    seedAccount({ tokenExpiresAt: new Date(Date.now() + 3600_000) })
    await getAuthedGoogleClient(h.accounts.get('acc-a')!)
    expect(h.client.refreshAccessToken).not.toHaveBeenCalled()
  })
})

describe('syncGoogleQuota', () => {
  it('fails fast on reauth and never touches the quota row', async () => {
    seedAccount({ status: 'reauth_required' })
    await expect(syncGoogleQuota('acc-a')).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' })
    expect(h.prismaMock.storageAccount.upsert).not.toHaveBeenCalled()
  })
})

describe('markReauthRequired', () => {
  it('is Google-only and preserves autoAllocationEnabled + tokens', async () => {
    await markReauthRequired('acc-a', 'invalid_grant: revoked')
    expect(h.prismaMock.connectedAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 'acc-a', provider: 'google_drive', status: { not: 'reauth_required' } },
      data: expect.not.objectContaining({ autoAllocationEnabled: expect.anything() }),
    })
  })
})