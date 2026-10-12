import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'

const h = vi.hoisted(() => {
  const prismaMock = {
    serverBrowserSession: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  }
  return { prismaMock }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

import {
  createSession,
  getSession,
  listSessions,
  mintViewToken,
  resolveDisplayTarget,
  stopSession,
  sweepSessions,
} from './server-browser.service.js'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    userId: 'user-1',
    status: 'starting',
    containerName: '9drive-browser-0123456789abcdef',
    containerIp: null,
    viewTokenHash: null,
    viewTokenExpiresAt: null,
    lastError: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    endedAt: null,
    lastSeenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function okRunner() {
  return {
    run: vi.fn(async (args: string[]) => {
      if (args[0] === 'info') return { stdout: '', stderr: '', code: 0 }
      if (args[0] === 'run') return { stdout: 'cid', stderr: '', code: 0 }
      if (args[0] === 'inspect') return { stdout: 'true\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  env.SERVER_BROWSER_ENABLED = true
  env.SERVER_BROWSER_MAX_SESSIONS_PER_USER = 1
  env.SERVER_BROWSER_MAX_SESSIONS_TOTAL = 5
})

describe('createSession', () => {
  it('refuses creation when the feature is disabled', async () => {
    env.SERVER_BROWSER_ENABLED = false
    await expect(createSession('user-1', okRunner())).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE', status: 503 })
  })

  it('enforces the per-user concurrent session limit', async () => {
    h.prismaMock.serverBrowserSession.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1)
    await expect(createSession('user-1', okRunner())).rejects.toMatchObject({ code: 'BROWSER_SESSION_LIMIT', status: 409 })
  })

  it('enforces the global concurrent session limit', async () => {
    h.prismaMock.serverBrowserSession.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5)
    await expect(createSession('user-1', okRunner())).rejects.toMatchObject({ code: 'BROWSER_SESSION_LIMIT', status: 409 })
  })

  it('launches an isolated container with a server-generated name', async () => {
    h.prismaMock.serverBrowserSession.count.mockResolvedValue(0)
    h.prismaMock.serverBrowserSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
    const runner = okRunner()
    const created = await createSession('user-1', runner)
    expect(created.session.status).toBe('starting')
    const runCall = runner.run.mock.calls.find((c) => (c[0] as string[])[0] === 'run')
    expect(runCall).toBeDefined()
    const args = runCall![0] as string[]
    const name = args[args.indexOf('--name') + 1]
    expect(name).toMatch(/^9drive-browser-[0-9a-f]{16}$/)
    expect(args).toContain(env.SERVER_BROWSER_IMAGE)
  })

  it('reveals a per-session VNC password once and injects the same value', async () => {
    env.SERVER_BROWSER_VNC_PASSWORD = ''
    h.prismaMock.serverBrowserSession.count.mockResolvedValue(0)
    h.prismaMock.serverBrowserSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
    const runner = okRunner()
    const created = await createSession('user-1', runner)
    expect(created.vncPassword).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    const runCall = runner.run.mock.calls.find((c) => (c[0] as string[])[0] === 'run')
    const args = runCall![0] as string[]
    expect(args).toContain(`VNC_PW=${created.vncPassword}`)
  })

  it('uses the operator-fixed VNC password when configured', async () => {
    env.SERVER_BROWSER_VNC_PASSWORD = 'operator-secret'
    try {
      h.prismaMock.serverBrowserSession.count.mockResolvedValue(0)
      h.prismaMock.serverBrowserSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
      const created = await createSession('user-1', okRunner())
      expect(created.vncPassword).toBe('operator-secret')
    } finally {
      env.SERVER_BROWSER_VNC_PASSWORD = ''
    }
  })

  it('marks the session failed with a safe error when launch fails', async () => {
    h.prismaMock.serverBrowserSession.count.mockResolvedValue(0)
    h.prismaMock.serverBrowserSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
    h.prismaMock.serverBrowserSession.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
    const runner = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'info') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: 'daemon exploded: /var/lib/docker', code: 125 }
      }),
    }
    const error = await createSession('user-1', runner).catch((e) => e)
    expect(error).toMatchObject({ code: 'BROWSER_UNAVAILABLE', status: 503 })
    expect(String(error.message)).not.toContain('/var/lib/docker')
    expect(h.prismaMock.serverBrowserSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    )
    // The named profile volume is allocated by `docker run` before the
    // container fails, so a failed launch must still release it.
    const commands = runner.run.mock.calls.map((c) => (c[0] as string[]).join(' '))
    expect(commands.some((c) => c.startsWith('volume rm 9drive-browser-profile-'))).toBe(true)
  })
})

describe('ownership and id validation', () => {
  it('rejects unknown ids without leaking existence', async () => {
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(null)
    await expect(getSession('user-1', 'nope')).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND', status: 404 })
    await expect(stopSession('user-1', 'nope', okRunner())).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' })
  })

  it('scopes every lookup to the owning user', async () => {
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(row({ status: 'ready' }))
    await getSession('user-1', 'session-1', okRunner())
    expect(h.prismaMock.serverBrowserSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'session-1', userId: 'user-1' }) }),
    )
  })

  it('another user’s session id is indistinguishable from missing', async () => {
    // The ownership filter finds no row for user-2, so the same 404 applies.
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(null)
    const error = await getSession('user-2', 'session-1', okRunner()).catch((e) => e)
    expect(error).toBeInstanceOf(AppError)
    expect(error.code).toBe('BROWSER_SESSION_NOT_FOUND')
  })

  it('lists only the caller’s sessions', async () => {
    h.prismaMock.serverBrowserSession.findMany.mockResolvedValue([row({ status: 'ready' })])
    const rows = await listSessions('user-1')
    expect(rows).toHaveLength(1)
    expect(h.prismaMock.serverBrowserSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1' }) }),
    )
  })

  it('a timed-out start fails closed and releases its container and volume', async () => {
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(
      row({ status: 'starting', createdAt: new Date(Date.now() - 10_000_000) }),
    )
    h.prismaMock.serverBrowserSession.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
    const runner = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'inspect') return { stdout: 'false\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      }),
    }
    const session = await getSession('user-1', 'session-1', runner)
    expect(session.status).toBe('failed')
    const commands = runner.run.mock.calls.map((c) => (c[0] as string[]).join(' '))
    expect(commands.some((c) => c.startsWith('rm -f 9drive-browser-'))).toBe(true)
    expect(commands.some((c) => c.startsWith('volume rm 9drive-browser-profile-'))).toBe(true)
  })

  it('a running container whose display is not yet serving stays starting', async () => {
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(row({ status: 'starting' }))
    // Container reports running, but nothing answers the display TLS probe
    // (unroutable name fails fast), so the session must NOT promote to ready
    // — otherwise the gateway would 502 on a merely-started container.
    const runner = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'inspect') return { stdout: 'true\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      }),
    }
    const session = await getSession('user-1', 'session-1', runner)
    expect(session.status).toBe('starting')
    expect(h.prismaMock.serverBrowserSession.update).not.toHaveBeenCalled()
  })
})

describe('stopSession', () => {
  it('returns terminal sessions untouched without touching Docker', async () => {
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(row({ status: 'stopped', endedAt: new Date() }))
    const runner = okRunner()
    const stopped = await stopSession('user-1', 'session-1', runner)
    expect(stopped.status).toBe('stopped')
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('removes the container and profile volume, then marks stopped', async () => {
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(row({ status: 'ready' }))
    h.prismaMock.serverBrowserSession.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
    const runner = okRunner()
    const stopped = await stopSession('user-1', 'session-1', runner)
    expect(stopped.status).toBe('stopped')
    const commands = runner.run.mock.calls.map((c) => (c[0] as string[]).join(' '))
    expect(commands.some((c) => c.startsWith('rm -f 9drive-browser-'))).toBe(true)
    expect(commands.some((c) => c.startsWith('volume rm 9drive-browser-profile-'))).toBe(true)
  })
})

describe('view tokens', () => {
  it('refuses tokens for expired sessions', async () => {
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(row({ status: 'expired' }))
    await expect(mintViewToken('user-1', 'session-1', okRunner())).rejects.toMatchObject({ code: 'BROWSER_SESSION_EXPIRED' })
  })

  it('rejects a wrong display token without distinguishing reasons', async () => {
    const { hashToken } = await import('../../utils/crypto.js')
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(
      row({ status: 'ready', viewTokenHash: hashToken('correct'), viewTokenExpiresAt: new Date(Date.now() + 60_000) }),
    )
    await expect(resolveDisplayTarget('session-1', 'wrong')).rejects.toMatchObject({ code: 'DISPLAY_TOKEN_INVALID' })
  })

  it('rejects an expired display token', async () => {
    const { hashToken } = await import('../../utils/crypto.js')
    h.prismaMock.serverBrowserSession.findFirst.mockResolvedValue(
      row({ status: 'ready', viewTokenHash: hashToken('correct'), viewTokenExpiresAt: new Date(Date.now() - 1000) }),
    )
    await expect(resolveDisplayTarget('session-1', 'correct')).rejects.toMatchObject({ code: 'DISPLAY_TOKEN_EXPIRED' })
  })
})

describe('sweepSessions', () => {
  it('expires timed-out sessions and cleans up their containers', async () => {
    h.prismaMock.serverBrowserSession.findMany.mockResolvedValue([row({ expiresAt: new Date(Date.now() - 1000) })])
    h.prismaMock.serverBrowserSession.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
    const runner = okRunner()
    const result = await sweepSessions(runner)
    expect(result).toEqual({ expired: 1, failed: 0 })
    expect(h.prismaMock.serverBrowserSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'expired' }) }),
    )
  })

  it('fails crashed ready sessions whose containers are gone', async () => {
    h.prismaMock.serverBrowserSession.findMany.mockResolvedValue([row({ status: 'ready' })])
    h.prismaMock.serverBrowserSession.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data))
    const runner = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'inspect') return { stdout: 'false\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      }),
    }
    const result = await sweepSessions(runner)
    expect(result.failed).toBe(1)
    expect(h.prismaMock.serverBrowserSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    )
  })

  it('never throws on store failures', async () => {
    h.prismaMock.serverBrowserSession.findMany.mockRejectedValue(new Error('db down'))
    await expect(sweepSessions(okRunner())).resolves.toEqual({ expired: 0, failed: 0 })
  })

  it('reaps containers with no live session row, keeps active ones', async () => {
    h.prismaMock.serverBrowserSession.findMany.mockImplementation(async (args: {
      where?: { status?: { in?: string[] } }
    }) => {
      // Active-set query returns one live container; the sweep-candidate
      // query returns nothing (all handled by the orphan path below).
      if (args?.where?.status?.in) return [{ containerName: '9drive-browser-keepkeepkeepkeep' }]
      return []
    })
    const calls: string[][] = []
    const runner = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args)
        if (args[0] === 'ps') {
          return {
            stdout: '9drive-browser-keepkeepkeepkeep\n9drive-browser-deaddeaddeaddead\n9drive-browser-egress-proxy\n',
            stderr: '',
            code: 0,
          }
        }
        return { stdout: '', stderr: '', code: 0 }
      }),
    }
    await sweepSessions(runner)
    const commands = calls.map((c) => c.join(' '))
    expect(commands.some((c) => c.includes('9drive-browser-deaddeaddeaddead'))).toBe(true)
    expect(commands.some((c) => c.includes('9drive-browser-keepkeepkeepkeep'))).toBe(false)
    expect(commands.some((c) => c.includes('egress-proxy'))).toBe(false)
  })
})
