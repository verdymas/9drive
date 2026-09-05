import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelegramClient } from 'teleproto'

/**
 * Tests for the opt-in `TELEGRAM_SYNC_TRASH_MISSING` behavior. The flag is
 * mocked ON for every test; the spec default (flag off) preserves the
 * "sync NEVER deletes" rule and is the case the main test file already
 * covers.
 *
 * We don't reuse the main file's `vi.hoisted` harness because that one
 * stubs `file.update` as a no-op — fine for "row stays active" assertions,
 * hostile to a two-run confirmation flow that needs Pass 2 to read
 * prior-issue state. A small local harness keeps this file independent.
 */

const h = vi.hoisted(() => {
  const state = {
    syncState: null as null | { status: string; lastMessageId: bigint | null; lastScanAt: Date | null; errorCode: string | null; errorMessage: string | null; connectedAccountId: string; userId: string },
    runCount: 0,
    issues: [] as Array<{ id: string; kind: string; runId: string | null; fileId: string | null; resolvedAt: Date | null; metadata: any }>,
    fileRows: [] as Array<{ id: string; providerFileId: string; name: string; mimeType: string; sizeBytes: bigint; folderId: string | null; telegramStableId: string | null; status: string; deletedAt: Date | null }>,
    fileUpdates: [] as Array<{ where: any; data: any }>,
    priorMissingFlags: [] as Array<{ fileId: string }>,
    lockAcquired: true,
    auditEvents: [] as Array<{ action: string; entity: string; entityId: string; meta: any }>,
  }
  const prismaMock = {
    connectedAccount: { findFirst: vi.fn() },
    telegramStorageConfig: { findFirstOrThrow: vi.fn() },
    telegramSyncState: {
      upsert: vi.fn(async ({ create, update }: any) => {
        if (!state.syncState) {
          state.syncState = { status: update?.status ?? create.status, lastMessageId: update?.lastMessageId ?? create.lastMessageId ?? null, lastScanAt: update?.lastScanAt ?? null, errorCode: null, errorMessage: null, connectedAccountId: create.connectedAccountId, userId: create.userId }
        }
        return state.syncState
      }),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => state.syncState),
    },
    telegramSyncRun: {
      create: vi.fn(async () => { state.runCount += 1; return { id: `run-${state.runCount}`, startedAt: new Date() } }),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    telegramSyncIssue: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `iss-${state.issues.length + 1}`, resolvedAt: null, ...data }
        state.issues.push(row); return row
      }),
      count: vi.fn(async () => 0),
      findMany: vi.fn(async (args: any) => {
        if (args?.where?.kind === 'REMOTE_FILE_MISSING' && args?.where?.resolvedAt === null) {
          return state.priorMissingFlags.filter((f) => f.fileId)
        }
        return []
      }),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    file: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => state.fileRows),
      create: vi.fn(async () => ({})),
      update: vi.fn(async ({ where, data }: any) => {
        state.fileUpdates.push({ where, data })
        const row = state.fileRows.find((r) => r.id === where.id)
        if (row) Object.assign(row, data)
        return {}
      }),
      upsert: vi.fn(async () => ({})),
    },
    folder: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: any) => Array.isArray(ops) ? Promise.all(ops) : ops),
  }
  return { state, prismaMock }
})

vi.mock('../../config/env.js', () => ({
  env: {
    TELEGRAM_SYNC_TRASH_MISSING: true,
    TELEGRAM_METADATA_ENCRYPTION_ENABLED: false,
    TELEGRAM_OBFUSCATE_FILENAME_ENABLED: false,
    TELEGRAM_OBFUSCATE_FILE_EXTENSION: false,
  },
}))

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('./telegram-usage.service.js', () => ({ syncTelegramUsage: vi.fn(async () => undefined) }))
vi.mock('../../utils/audit.js', () => ({
  createAuditLog: vi.fn(async (_userId: string, action: string, entity: string, entityId: string, meta: any) => {
    h.state.auditEvents.push({ action, entity, entityId, meta })
    return undefined
  }),
}))
vi.mock('./telegram.service.js', () => ({
  withTelegramClient: vi.fn(),
  getTelegramConfig: vi.fn(async () => ({ channelId: '-1004458806678', phoneEncrypted: null, connectedAccount: { id: 'acc-1' } })),
  isStorageChannelCandidate: () => true,
  normalizeChannelId: (id: unknown) => String(id),
  resolveConfiguredChannel: vi.fn(async () => ({ id: 4458806678, title: 'storage', megagroup: false, broadcast: true })),
  buildTelegramRemoteId: (channelId: string, messageId: number) => `telegram://${channelId}/${messageId}`,
  parseTelegramRemoteId: (id: string) => {
    const m = /telegram:\/\/([^/]+)\/(\d+)/.exec(id)
    return m ? { channelId: m[1], messageId: Number(m[2]) } : { channelId: '', messageId: 0 }
  },
  classifyTelegramError: (e: unknown) => e,
}))
vi.mock('./telegram-ingest.service.js', () => ({ ingestTelegramDocument: vi.fn(async () => 'created' as const) }))

import { runTelegramSync } from './telegram-sync.service.js'
import { withTelegramClient } from './telegram.service.js'

function fakeChannel() {
  return { id: 4458806678, title: 'storage', megagroup: false, broadcast: true } as never
}
function fakeClient(documents: Array<{ messageId: number; name: string; size: number; mimeType: string | null }> = []): TelegramClient {
  return {
    async connect() {}, async disconnect() {},
    async getInputEntity() { return {} as never }, async getEntity() { return fakeChannel() },
    iterMessages() {
      return (async function* () {
        for (const d of documents) {
          yield { id: d.messageId, document: { size: d.size, mimeType: d.mimeType, attributes: [{ fileName: d.name }] } }
        }
      })()
    },
    async getMessages(_channel: unknown, params: { ids: number[] }) {
      return params.ids.map((id) => ({ id, message: '' }))
    },
  } as unknown as TelegramClient
}

const setWithClient = (docs: Array<{ messageId: number; name: string; size: number; mimeType: string | null }> = []) => {
  vi.mocked(withTelegramClient).mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient(docs)))
}

const setAccount = () => {
  ;(h.prismaMock.connectedAccount.findFirst as any).mockImplementation(async () => ({ id: 'acc-1', userId: 'user-1', provider: 'telegram', status: 'connected' }))
  ;(h.prismaMock.telegramStorageConfig.findFirstOrThrow as any).mockImplementation(async () => ({ channelId: '-1004458806678', phoneEncrypted: null }))
}

beforeEach(() => {
  setAccount()
  ;(h.prismaMock.telegramSyncState.updateMany as any).mockImplementation(async () => ({ count: h.state.lockAcquired ? 1 : 0 }))
  ;(h.prismaMock.telegramSyncState.findUnique as any).mockImplementation(async () => h.state.syncState)
  ;(h.prismaMock.telegramSyncRun.create as any).mockImplementation(async () => { h.state.runCount += 1; return { id: `run-${h.state.runCount}`, startedAt: new Date() } })
  ;(h.prismaMock.telegramSyncIssue.create as any).mockImplementation(async ({ data }: any) => { const row = { id: `iss-${h.state.issues.length + 1}`, resolvedAt: null, ...data }; h.state.issues.push(row); return row })
  ;(h.prismaMock.file.findMany as any).mockImplementation(async () => h.state.fileRows)
  ;(h.prismaMock.file.update as any).mockImplementation(async ({ where, data }: any) => { h.state.fileUpdates.push({ where, data }); const row = h.state.fileRows.find((r) => r.id === where.id); if (row) Object.assign(row, data); return {} })
  h.state.syncState = null
  h.state.runCount = 0
  h.state.issues = []
  h.state.fileRows = []
  h.state.fileUpdates = []
  h.state.priorMissingFlags = []
  h.state.lockAcquired = true
  h.state.auditEvents = []
})

describe('runTelegramSync — TELEGRAM_SYNC_TRASH_MISSING (opt-in)', () => {
  it('first full scan: flags the row but does NOT trash it', async () => {
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/42', name: 'gone.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active', deletedAt: null },
    ]
    setWithClient([])

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.missingCount).toBe(1)
    expect(result.trashedCount).toBe(0)
    expect(h.state.fileUpdates.length).toBe(0)
    expect(h.state.issues.length).toBe(1)
    expect(h.state.issues[0].kind).toBe('REMOTE_FILE_MISSING')
    expect(h.state.fileRows[0].status).toBe('active')
  })

  it('second full scan with prior unresolved flag: trashes the row', async () => {
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/42', name: 'gone.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active', deletedAt: null },
    ]
    h.state.priorMissingFlags = [{ fileId: 'f1' }]
    setWithClient([])

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.missingCount).toBe(1)
    expect(result.trashedCount).toBe(1)
    const update = h.state.fileUpdates.find((u) => u.where.id === 'f1')
    expect(update).toBeDefined()
    expect(update!.data.status).toBe('deleted')
    expect(update!.data.deletedAt).toBeInstanceOf(Date)
    expect(h.state.fileRows[0].status).toBe('deleted')
    expect(h.state.auditEvents.some((a) => a.action === 'telegram.sync.trash_missing' && a.entityId === 'f1')).toBe(true)
  })

  it('does NOT trash when the prior issue was already resolved by the user', async () => {
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/42', name: 'gone.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active', deletedAt: null },
    ]
    // priorMissingFlags empty: the prior issue was resolved, so Pass 2's
    // `findMany({ resolvedAt: null })` returns no rows.
    h.state.priorMissingFlags = []
    setWithClient([])

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.missingCount).toBe(1)
    expect(result.trashedCount).toBe(0)
    expect(h.state.fileUpdates.length).toBe(0)
    expect(h.state.fileRows[0].status).toBe('active')
  })

  it('incremental run: Pass 2 skipped, nothing trashed even with prior flag', async () => {
    h.state.syncState = { status: 'up_to_date', lastMessageId: 5n, lastScanAt: new Date(), errorCode: null, errorMessage: null, connectedAccountId: 'acc-1', userId: 'user-1' }
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active', deletedAt: null },
    ]
    h.state.priorMissingFlags = [{ fileId: 'f1' }]
    setWithClient([{ messageId: 6, name: 'new.txt', size: 50, mimeType: 'text/plain' }])

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.missingCount).toBe(0)
    expect(result.trashedCount).toBe(0)
    expect(h.state.fileUpdates.length).toBe(0)
    expect(h.state.fileRows[0].status).toBe('active')
  })

  it('a row already in Trash (status=deleted) is never flagged or trashed again', async () => {
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/42', name: 'trashed.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'deleted', deletedAt: new Date() },
    ]
    h.state.priorMissingFlags = [{ fileId: 'f1' }]
    setWithClient([])

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.missingCount).toBe(0)
    expect(result.trashedCount).toBe(0)
    expect(h.state.fileUpdates.length).toBe(0)
    expect(h.state.issues.length).toBe(0)
  })
})
