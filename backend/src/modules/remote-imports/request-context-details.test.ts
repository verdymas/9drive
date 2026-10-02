import { beforeEach, describe, expect, it, vi } from 'vitest'
import { maskRequestCookie } from './request-context.js'

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: { remoteImport: { findFirst: (...args: unknown[]) => h.findFirst(...args) } },
}))

vi.mock('../../utils/crypto.js', () => ({
  encryptText: (s: string) => s,
  decryptText: (s: string) => s,
}))

vi.mock('./queue.js', () => ({
  enqueueRemoteImport: vi.fn(async () => 'job'),
  removeRemoteImportJob: vi.fn(async () => undefined),
  remoteImportJobId: (id: string, attempt: number) => `${id}~${attempt}`,
  workloadForRemoteImport: () => 'direct' as const,
}))

vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn(async () => undefined) }))

vi.mock('./hls/job-dir.js', () => ({
  hlsJobDir: vi.fn(() => '/tmp/jobs/u/i'),
  removeJobDir: vi.fn(async () => undefined),
  readResumeMarker: vi.fn(async () => null),
}))

vi.mock('./ssrf.js', () => ({
  validateRemoteUrl: vi.fn(async (rawUrl: string) => new URL(rawUrl)),
}))

vi.mock('./temp-storage.js', () => ({
  removeTempFile: vi.fn(async () => undefined),
  tempFilePath: (id: string) => `/tmp/${id}.part`,
}))

vi.mock('./queue-reconcile.js', () => ({
  reconcileQueuedRow: vi.fn(async () => 'kept'),
}))

vi.mock('../remote-fetch-workers/driver-registry.js', () => ({
  hasDriver: () => true,
}))

vi.mock('node:fs/promises', () => ({
  default: {
    access: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  },
}))

import { getRemoteImportRequestContextForUser, serializeRemoteImport } from './remote-import.service.js'

const MASKED = '••••••••'

function rowWithContext(ownerId: string, ctx: Record<string, string> | null) {
  return {
    id: 'import-1',
    userId: ownerId,
    requestContextEncrypted: ctx ? JSON.stringify(ctx) : null,
    totalBytes: null,
    downloadedBytes: 0n,
    uploadedBytes: 0n,
    uploadTotalBytes: null,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('maskRequestCookie', () => {
  it('masks values while preserving cookie names', () => {
    expect(maskRequestCookie('session=abc123; cf_clearance=xyz789')).toBe(`session=${MASKED}; cf_clearance=${MASKED}`)
  })

  it('returns null for empty input', () => {
    expect(maskRequestCookie(null)).toBeNull()
    expect(maskRequestCookie(undefined)).toBeNull()
    expect(maskRequestCookie('')).toBeNull()
    expect(maskRequestCookie('   ')).toBeNull()
  })

  it('masks nameless segments without leaking structure', () => {
    expect(maskRequestCookie('just-a-value')).toBe(MASKED)
  })
})

describe('getRemoteImportRequestContextForUser', () => {
  it('owner receives details with cookie masked by default (no raw)', async () => {
    h.findFirst.mockResolvedValueOnce(
      rowWithContext('user-1', {
        referer: 'https://example.com/watch/123',
        origin: 'https://example.com',
        userAgent: 'Mozilla/5.0 test',
        cookie: 'session=abc123; cf_clearance=xyz789',
      }),
    )
    const details = await getRemoteImportRequestContextForUser('import-1', 'user-1')
    expect(details.attached).toBe(true)
    expect(details.referer).toBe('https://example.com/watch/123')
    expect(details.origin).toBe('https://example.com')
    expect(details.userAgent).toBe('Mozilla/5.0 test')
    expect(details.cookie.attached).toBe(true)
    expect(details.cookie.masked).toBe(`session=${MASKED}; cf_clearance=${MASKED}`)
    expect(details.cookie.raw).toBeUndefined()
    expect(JSON.stringify(details)).not.toContain('abc123')
    // Encrypted blob is never part of the details payload.
    expect(JSON.stringify(details)).not.toContain('requestContextEncrypted')
  })

  it('raw cookie is returned only with explicit reveal + owner authorization', async () => {
    const ctx = { cookie: 'session=abc123' }
    h.findFirst.mockResolvedValueOnce(rowWithContext('user-1', ctx))
    const masked = await getRemoteImportRequestContextForUser('import-1', 'user-1')
    expect(masked.cookie.raw).toBeUndefined()

    h.findFirst.mockResolvedValueOnce(rowWithContext('user-1', ctx))
    const revealed = await getRemoteImportRequestContextForUser('import-1', 'user-1', { revealCookie: true })
    expect(revealed.cookie.raw).toBe('session=abc123')
  })

  it('another user cannot retrieve details (404)', async () => {
    h.findFirst.mockResolvedValueOnce(null)
    await expect(getRemoteImportRequestContextForUser('import-1', 'user-2')).rejects.toMatchObject({
      code: 'REMOTE_IMPORT_NOT_FOUND',
      status: 404,
    })
  })

  it('no-context import returns the expected empty state', async () => {
    h.findFirst.mockResolvedValueOnce(rowWithContext('user-1', null))
    const details = await getRemoteImportRequestContextForUser('import-1', 'user-1')
    expect(details).toEqual({
      attached: false,
      referer: null,
      origin: null,
      userAgent: null,
      cookie: { attached: false, masked: null },
    })
  })

  it('normal list/detail serialization stays boolean-only with no blobs', async () => {
    const row = {
      ...rowWithContext('user-1', { referer: 'https://example.com/watch/123', cookie: 'session=abc123' }),
      sourceUrlEncrypted: 'encrypted-source',
      resumeSessionEncrypted: 'encrypted-session',
      finalUrlEncrypted: 'encrypted-final',
      internalError: 'secret',
    }
    const serialized = serializeRemoteImport(row)
    expect(serialized.requestContext).toEqual({
      attached: true,
      referer: true,
      origin: false,
      userAgent: false,
      cookie: true,
    })
    const wire = JSON.stringify(serialized)
    expect(wire).not.toContain('abc123')
    expect(wire).not.toContain('https://example.com/watch/123')
    expect(wire).not.toContain('requestContextEncrypted')
    expect(wire).not.toContain('sourceUrlEncrypted')
    expect(wire).not.toContain('resumeSessionEncrypted')
  })
})
