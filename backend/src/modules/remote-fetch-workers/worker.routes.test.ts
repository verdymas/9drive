import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import { createWorker, deleteWorker, disableWorker, getWorker, listWorkers, serializeWorker, setDefaultWorker, updateWorker } from './workers.service.js'

// ── In-memory prisma fake enforcing the real invariants (sync-e2e style) ─────
//   - deletedAt rows are excluded from list/find
//   - exactly one row may be isDefault (create/update enforce)
//   - disable clears the default flag
const h = vi.hoisted(() => {
  const store = new Map<string, any>()
  let seq = 0
  const base = () => ({
    slug: null,
    driver: 'cloudflare',
    endpointUrl: 'https://relay.example.workers.dev',
    isEnabled: true,
    isDefault: false,
    priority: null,
    region: null,
    description: null,
    authType: 'hmac',
    secretEncrypted: null,
    configEncrypted: null,
    capabilitiesJson: null,
    metadataJson: null,
    status: 'unknown',
    lastHealthCheckAt: null,
    lastHealthyAt: null,
    lastFailedAt: null,
    lastErrorCode: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  const enforceSingleDefault = (exceptId?: string) => {
    const defaults = [...store.values()].filter((r) => !r.deletedAt && r.isDefault && r.id !== exceptId)
    for (const r of defaults) r.isDefault = false
  }
  const prismaMock = {
    remoteFetchWorker: {
      findFirst: vi.fn(async ({ where }) => {
        const row = where?.id ? store.get(where?.id) : undefined
        return row && !row.deletedAt ? row : null
      }),
      findMany: vi.fn(async () => [...store.values()].filter((r) => !r.deletedAt)),
      create: vi.fn(async ({ data }) => {
        const id = `w-${++seq}`
        const row = { id, ...base(), ...data }
        if (row.isDefault) enforceSingleDefault()
        store.set(id, row)
        return row
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = store.get(where.id)
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' })
        // Prisma semantics: `undefined` keys are "don't touch", not "set null".
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) row[key] = value
        }
        row.updatedAt = new Date()
        if (data.isDefault === true) enforceSingleDefault(row.id)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0
        for (const r of store.values()) {
          const matchesId = !where?.id || where.id === r.id
          const matchesDefault = !where?.isDefault || where.isDefault === r.isDefault
          const matchesDeleted = !where?.deletedAt || !r.deletedAt
          if (matchesId && matchesDefault && matchesDeleted && !r.deletedAt) {
            Object.assign(r, data)
            count++
          }
        }
        return { count }
      }),
    },
    $transaction: vi.fn(async (fn: (tx: any) => unknown) => fn({ remoteFetchWorker: h.prismaMock.remoteFetchWorker })),
  }
  return { prismaMock, store, auditSpy: vi.fn(), encryptSpy: vi.fn((s: string) => s), decryptSpy: vi.fn((s: string) => 'top-secret') }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: (...args: unknown[]) => h.auditSpy(...args) }))
vi.mock('../../utils/crypto.js', () => ({
  encryptText: (s: string) => h.encryptSpy(s),
  decryptText: (s: string) => h.decryptSpy(s),
}))
vi.mock('./driver-registry.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./driver-registry.js')>()
  return {
    ...original,
    resolveDriver: (key: string) => {
      if (key !== 'cloudflare') throw new AppError('WORKER_DRIVER_UNSUPPORTED', 'The worker uses a service that is not supported.', 400)
      return {
        key: 'cloudflare',
        validateConfig: async ({ endpointUrl }: { endpointUrl?: string | null }) => ({ endpointUrl }),
        getMetadata: () => ({ key: 'cloudflare', displayName: 'Cloudflare Worker', managed: false, authTypes: ['hmac'], fields: [] }),
        testConnection: async () => ({ status: 'healthy' as const, protocolVersion: '9drive-relay-v1' }),
      }
    },
  }
})

beforeEach(() => {
  h.store.clear()
  ;(h.prismaMock.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (fn: (tx: any) => unknown) => fn({ remoteFetchWorker: h.prismaMock.remoteFetchWorker }),
  )
})

describe('worker CRUD invariants', () => {
  it('create encrypts the secret and the wire shape never leaks it', async () => {
    const created = await createWorker('user-1', {
      name: 'Cloudflare SG',
      driver: 'cloudflare',
      endpointUrl: 'https://sg.example.workers.dev',
      secret: 'top-secret',
      region: 'Singapore',
    })
    expect(h.encryptSpy).toHaveBeenCalledWith('top-secret')
    const wire = serializeWorker(created)
    expect(wire.secretEncrypted).toBeUndefined()
    expect(wire.credentialConfigured).toBe(true)
    expect(JSON.stringify(wire)).not.toContain('top-secret')
    expect(wire.region).toBe('Singapore')
  })

  it('list and detail never return the encrypted secret', async () => {
    await createWorker('user-1', { name: 'A', driver: 'cloudflare', endpointUrl: 'https://a.example', secret: 's3cret' })
    const rows = await listWorkers()
    expect(rows).toHaveLength(1)
    expect(serializeWorker(rows[0]).credentialConfigured).toBe(true)
    expect(JSON.stringify(rows.map(serializeWorker))).not.toContain('s3cret')
  })

  it('exactly one default: setting B default unsets A', async () => {
    const a = await createWorker('user-1', { name: 'A', driver: 'cloudflare', endpointUrl: 'https://a.example' })
    const b = await createWorker('user-1', { name: 'B', driver: 'cloudflare', endpointUrl: 'https://b.example' })
    await setDefaultWorker('user-1', a.id)
    await setDefaultWorker('user-1', b.id)
    const rows = await listWorkers()
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1)
    expect(rows.find((r) => r.id === b.id)?.isDefault).toBe(true)
    expect(rows.find((r) => r.id === a.id)?.isDefault).toBe(false)
  })

  it('a disabled worker cannot be set default', async () => {
    const w = await createWorker('user-1', { name: 'W', driver: 'cloudflare', endpointUrl: 'https://w.example' })
    await disableWorker('user-1', w.id)
    await expect(setDefaultWorker('user-1', w.id)).rejects.toMatchObject({ code: 'WORKER_DISABLED' })
  })

  it('disable clears the default flag', async () => {
    const w = await createWorker('user-1', { name: 'W', driver: 'cloudflare', endpointUrl: 'https://w.example', isDefault: true })
    await disableWorker('user-1', w.id)
    const rows = await listWorkers()
    expect(rows.find((r) => r.id === w.id)?.isDefault).toBe(false)
  })

  it('delete is a soft delete — worker disappears from list/detail', async () => {
    const w = await createWorker('user-1', { name: 'W', driver: 'cloudflare', endpointUrl: 'https://w.example' })
    await deleteWorker('user-1', w.id)
    expect(await listWorkers()).toHaveLength(0)
    await expect(getWorker(w.id)).rejects.toMatchObject({ code: 'WORKER_NOT_FOUND', status: 404 })
  })

  it('soft-deleted default is cleared (delete clears default)', async () => {
    const w = await createWorker('user-1', { name: 'W', driver: 'cloudflare', endpointUrl: 'https://w.example', isDefault: true })
    await deleteWorker('user-1', w.id)
    const remaining = await listWorkers()
    expect(remaining.every((r) => !r.isDefault)).toBe(true)
  })

  it('unsupported driver is rejected', async () => {
    await expect(
      createWorker('user-1', { name: 'V', driver: 'vercel', endpointUrl: 'https://v.example' }),
    ).rejects.toMatchObject({ code: 'WORKER_DRIVER_UNSUPPORTED' })
  })

  it('PATCH keeps the existing secret when blank (undefined) and replaces on new value', async () => {
    const w = await createWorker('user-1', { name: 'W', driver: 'cloudflare', endpointUrl: 'https://w.example', secret: 'old-secret' })
    await updateWorker('user-1', w.id, { name: 'Renamed' })
    expect(h.store.get(w.id).secretEncrypted).toBe('old-secret')
    await updateWorker('user-1', w.id, { secret: 'new-secret' })
    expect(h.store.get(w.id).secretEncrypted).toBe('new-secret')
    expect(h.encryptSpy).toHaveBeenLastCalledWith('new-secret')
  })
})