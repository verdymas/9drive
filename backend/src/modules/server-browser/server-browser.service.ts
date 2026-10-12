import crypto from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { BrowserBackend, DockerCliRunner, type ContainerRunner } from './browser-runner.js'

/**
 * Server Browser session lifecycle (Stage 1 MVP).
 *
 * Sessions are persistent rows owned by exactly one user. Every read/stop/
 * token operation re-checks ownership, so one user can never access, control,
 * inspect, or terminate another user's session. Unknown, malformed, or
 * foreign ids all map to the same `BROWSER_SESSION_NOT_FOUND` so ids are not
 * enumerable by error oracle.
 *
 * Never logged: VNC passwords, view tokens, cookies, or proxied URLs.
 */

export const BROWSER_SESSION_STATUSES = ['starting', 'ready', 'stopped', 'expired', 'failed'] as const
export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number]

const ACTIVE_STATUSES = ['starting', 'ready']
const TERMINAL_STATUSES = ['stopped', 'expired', 'failed']

export type SerializedBrowserSession = {
  id: string
  status: BrowserSessionStatus
  createdAt: string
  expiresAt: string
  endedAt: string | null
  lastSeenAt: string | null
}

export function serializeSession(row: {
  id: string
  status: string
  createdAt: Date
  expiresAt: Date
  endedAt: Date | null
  lastSeenAt: Date | null
}): SerializedBrowserSession {
  return {
    id: row.id,
    status: row.status as BrowserSessionStatus,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
  }
}

function opaqueName(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`
}

function backendWith(runner?: ContainerRunner): BrowserBackend {
  return new BrowserBackend(runner ?? new DockerCliRunner())
}

async function refreshStatus(
  row: { id: string; status: string; containerName: string | null; createdAt: Date },
  backend: BrowserBackend,
): Promise<string> {
  if (row.status !== 'starting' || !row.containerName) return row.status
  const running = await backend.isRunning(row.containerName).catch(() => false)
  // `ready` means the display is actually reachable — a merely-started
  // container whose KasmVNC server is still booting stays `starting` so the
  // gateway never 502s on it.
  if (running && (await backend.isDisplayServing(row.containerName, env.SERVER_BROWSER_DISPLAY_PORT).catch(() => false))) {
    await prisma.serverBrowserSession.update({ where: { id: row.id }, data: { status: 'ready' } })
    return 'ready'
  }
  const ageMs = Date.now() - row.createdAt.getTime()
  if (ageMs > env.SERVER_BROWSER_STARTUP_TIMEOUT_SECONDS * 1000) {
    await cleanupContainer(backend, row.containerName)
    await prisma.serverBrowserSession.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        lastError: 'Browser did not start in time.',
        endedAt: new Date(),
        viewTokenHash: null,
        viewTokenExpiresAt: null,
      },
    })
    return 'failed'
  }
  return 'starting'
}

async function cleanupContainer(backend: BrowserBackend, containerName: string | null): Promise<void> {
  if (!containerName) return
  const short = containerName.replace(/^9drive-browser-/, '')
  await backend.stop(containerName).catch(() => false)
  // Profile volumes are derived from the same opaque suffix, so cleanup needs
  // no stored volume name and no user input.
  if (/^[0-9a-f]{16}$/.test(short)) {
    await backend.removeProfileVolume(`9drive-browser-profile-${short}`).catch(() => false)
  }
}

export type CreatedBrowserSession = {
  session: SerializedBrowserSession
  /**
   * The VNC credential for this session's browser, revealed ONCE at creation
   * (same pattern as device tokens). The operator-fixed
   * `SERVER_BROWSER_VNC_PASSWORD` wins when set; otherwise a per-session
   * secret is generated — an empty Kasm password is unusable from browser
   * login dialogs, so sessions must never launch without one. Never stored,
   * never logged: the container holds the only other copy and dies with it.
   */
  vncPassword: string
}

export async function createSession(userId: string, runner?: ContainerRunner): Promise<CreatedBrowserSession> {
  if (!env.SERVER_BROWSER_ENABLED) {
    throw new AppError('BROWSER_UNAVAILABLE', 'Server Browser is not enabled on this deployment.', 503)
  }
  const [mine, total] = await Promise.all([
    prisma.serverBrowserSession.count({ where: { userId, status: { in: [...ACTIVE_STATUSES] } } }),
    prisma.serverBrowserSession.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
  ])
  if (mine >= env.SERVER_BROWSER_MAX_SESSIONS_PER_USER) {
    throw new AppError('BROWSER_SESSION_LIMIT', 'Session limit reached. Stop an existing session first.', 409)
  }
  if (total >= env.SERVER_BROWSER_MAX_SESSIONS_TOTAL) {
    throw new AppError('BROWSER_SESSION_LIMIT', 'The browser service is busy. Try again later.', 409)
  }

  const backend = backendWith(runner)
  if (!(await backend.available().catch(() => false))) {
    throw new AppError('BROWSER_UNAVAILABLE', 'Server Browser is temporarily unavailable.', 503)
  }

  const containerName = opaqueName('9drive-browser')
  const short = containerName.replace(/^9drive-browser-/, '')
  const vncPassword = env.SERVER_BROWSER_VNC_PASSWORD || randomToken(16)
  const row = await prisma.serverBrowserSession.create({
    data: {
      userId,
      status: 'starting',
      containerName,
      expiresAt: new Date(Date.now() + env.SERVER_BROWSER_SESSION_TTL_MINUTES * 60_000),
    },
  })

  try {
    await backend.launch({
      name: containerName,
      image: env.SERVER_BROWSER_IMAGE,
      network: env.SERVER_BROWSER_NETWORK,
      egressProxyUrl: env.SERVER_BROWSER_EGRESS_PROXY_URL,
      vncPassword,
      memory: env.SERVER_BROWSER_CONTAINER_MEMORY,
      cpus: env.SERVER_BROWSER_CONTAINER_CPUS,
      pidsLimit: env.SERVER_BROWSER_CONTAINER_PIDS_LIMIT,
      profileVolume: `9drive-browser-profile-${short}`,
    })
  } catch {
    // `docker run` allocates the named profile volume before the container
    // itself fails, so a failed launch must still release it.
    await cleanupContainer(backend, containerName)
    await prisma.serverBrowserSession.update({
      where: { id: row.id },
      data: { status: 'failed', lastError: 'Browser did not start.', endedAt: new Date() },
    })
    throw new AppError('BROWSER_UNAVAILABLE', 'Server Browser is temporarily unavailable.', 503)
  }
  return { session: serializeSession(row), vncPassword }
}

export async function getSession(userId: string, id: string, runner?: ContainerRunner): Promise<SerializedBrowserSession> {
  const row = await prisma.serverBrowserSession.findFirst({ where: { id, userId } })
  if (!row) throw new AppError('BROWSER_SESSION_NOT_FOUND', 'Browser session not found.', 404)
  if (row.status === 'starting') {
    const status = await refreshStatus(row, backendWith(runner))
    return serializeSession({ ...row, status } as typeof row)
  }
  return serializeSession(row)
}

export async function listSessions(userId: string): Promise<SerializedBrowserSession[]> {
  const rows = await prisma.serverBrowserSession.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  return rows.map(serializeSession)
}

export async function stopSession(userId: string, id: string, runner?: ContainerRunner): Promise<SerializedBrowserSession> {
  const row = await prisma.serverBrowserSession.findFirst({ where: { id, userId } })
  if (!row) throw new AppError('BROWSER_SESSION_NOT_FOUND', 'Browser session not found.', 404)
  if (TERMINAL_STATUSES.includes(row.status)) return serializeSession(row)
  const backend = backendWith(runner)
  await cleanupContainer(backend, row.containerName)
  const updated = await prisma.serverBrowserSession.update({
    where: { id: row.id },
    data: { status: 'stopped', endedAt: new Date(), viewTokenHash: null, viewTokenExpiresAt: null },
  })
  return serializeSession(updated)
}

export async function mintViewToken(
  userId: string,
  id: string,
  runner?: ContainerRunner,
): Promise<{ token: string; expiresAt: string }> {
  const row = await prisma.serverBrowserSession.findFirst({ where: { id, userId } })
  if (!row) throw new AppError('BROWSER_SESSION_NOT_FOUND', 'Browser session not found.', 404)
  let status = row.status
  if (status === 'starting') status = await refreshStatus(row, backendWith(runner))
  if (status === 'expired') throw new AppError('BROWSER_SESSION_EXPIRED', 'Browser session has expired.', 410)
  if (status !== 'starting' && status !== 'ready') {
    throw new AppError('BROWSER_SESSION_NOT_ACTIVE', 'Browser session is not active.', 409)
  }
  if (row.expiresAt < new Date()) {
    throw new AppError('BROWSER_SESSION_EXPIRED', 'Browser session has expired.', 410)
  }
  const token = randomToken(32)
  const expiresAt = new Date(Date.now() + env.SERVER_BROWSER_VIEW_TOKEN_TTL_SECONDS * 1000)
  await prisma.serverBrowserSession.update({
    where: { id: row.id },
    data: { viewTokenHash: hashToken(token), viewTokenExpiresAt: expiresAt, lastSeenAt: new Date() },
  })
  return { token, expiresAt: expiresAt.toISOString() }
}

export type DisplayTarget = { sessionId: string; containerName: string }

/**
 * Resolve a one-time display token to its session's container. Used by the
 * authenticated gateway (HTTP + WebSocket) — never by control routes.
 */
export async function resolveDisplayTarget(sessionId: string, token: string): Promise<DisplayTarget> {
  if (!token) throw new AppError('DISPLAY_TOKEN_REQUIRED', 'Display token required.', 401)
  const row = await prisma.serverBrowserSession.findFirst({ where: { id: sessionId } })
  if (!row || !row.viewTokenHash || !row.containerName) {
    throw new AppError('DISPLAY_TOKEN_INVALID', 'Invalid display token.', 401)
  }
  if (hashToken(token) !== row.viewTokenHash) {
    throw new AppError('DISPLAY_TOKEN_INVALID', 'Invalid display token.', 401)
  }
  if (!row.viewTokenExpiresAt || row.viewTokenExpiresAt < new Date()) {
    throw new AppError('DISPLAY_TOKEN_EXPIRED', 'Display token has expired. Reconnect to continue.', 401)
  }
  if (row.status === 'expired' || row.expiresAt < new Date()) {
    throw new AppError('BROWSER_SESSION_EXPIRED', 'Browser session has expired.', 410)
  }
  if (row.status !== 'starting' && row.status !== 'ready') {
    throw new AppError('BROWSER_SESSION_NOT_ACTIVE', 'Browser session is not active.', 409)
  }
  void prisma.serverBrowserSession.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined)
  return { sessionId: row.id, containerName: row.containerName }
}

/**
 * Expire timed-out sessions, fail hung startups, and reap crashed containers.
 * Idempotent and ownership-aware (cleanup only touches the session's own
 * server-generated container/volume). Never throws — the sweeper must not
 * crash the process. Logs session ids only, never tokens or URLs.
 */
export async function sweepSessions(runner?: ContainerRunner): Promise<{ expired: number; failed: number }> {
  const backend = backendWith(runner)
  const now = new Date()
  let expired = 0
  let failed = 0
  const candidates = await prisma.serverBrowserSession
    .findMany({ where: { status: { in: [...ACTIVE_STATUSES] } }, take: 100 })
    .catch(() => [])
  for (const row of candidates) {
    try {
      if (row.expiresAt < now) {
        await cleanupContainer(backend, row.containerName)
        await prisma.serverBrowserSession.update({
          where: { id: row.id },
          data: { status: 'expired', endedAt: now, viewTokenHash: null, viewTokenExpiresAt: null },
        })
        expired += 1
        continue
      }
      if (row.status === 'starting' && row.containerName) {
        const running = await backend.isRunning(row.containerName).catch(() => false)
        const serving = running
          ? await backend.isDisplayServing(row.containerName, env.SERVER_BROWSER_DISPLAY_PORT).catch(() => false)
          : false
        const ageMs = now.getTime() - row.createdAt.getTime()
        if (serving) {
          await prisma.serverBrowserSession.update({ where: { id: row.id }, data: { status: 'ready' } })
        } else if (ageMs > env.SERVER_BROWSER_STARTUP_TIMEOUT_SECONDS * 1000) {
          await cleanupContainer(backend, row.containerName)
          await prisma.serverBrowserSession.update({
            where: { id: row.id },
            data: { status: 'failed', lastError: 'Browser did not start in time.', endedAt: now },
          })
          failed += 1
        }
        continue
      }
      if (row.status === 'ready' && row.containerName) {
        const running = await backend.isRunning(row.containerName).catch(() => true)
        if (!running) {
          await cleanupContainer(backend, row.containerName)
          await prisma.serverBrowserSession.update({
            where: { id: row.id },
            data: { status: 'failed', lastError: 'Browser container terminated unexpectedly.', endedAt: now },
          })
          failed += 1
        }
      }
    } catch (error) {
      console.error(`[server-browser] sweep failed for session ${row.id}:`, error instanceof Error ? error.message : error)
    }
  }
  if (expired > 0 || failed > 0) {
    console.log(`[server-browser] sweep: expired=${expired} failed=${failed}`)
  }
  // Reap containers with no live session row (e.g. the owning user was removed
  // without stopping sessions). One query backs the whole check, so no extra
  // index is needed; every normal terminal transition already releases its
  // own container. The egress proxy never matches the managed-name pattern
  // and is ignored.
  try {
    const names = await backend.listManagedContainers().catch(() => [] as string[])
    if (names.length > 0) {
      const live = await prisma.serverBrowserSession
        .findMany({ where: { status: { in: [...ACTIVE_STATUSES] } }, select: { containerName: true } })
        .catch(() => [])
      const liveNames = new Set(live.map((row) => row.containerName))
      for (const name of names.slice(0, 100)) {
        if (liveNames.has(name)) continue
        await cleanupContainer(backend, name)
        console.log(`[server-browser] sweep: reaped orphan container ${name}`)
      }
    }
  } catch (error) {
    console.error('[server-browser] orphan reap failed:', error instanceof Error ? error.message : error)
  }
  return { expired, failed }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

export function startServerBrowserSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    void sweepSessions().catch(() => undefined)
  }, env.SERVER_BROWSER_SWEEP_INTERVAL_SECONDS * 1000)
  sweepTimer.unref?.()
}

export function stopServerBrowserSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}
