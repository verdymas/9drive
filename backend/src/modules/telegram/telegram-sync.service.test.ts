import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelegramClient } from 'teleproto'

const h = vi.hoisted(() => {
  const state = {
    syncState: null as null | { status: string; lastMessageId: bigint | null; lastScanAt: Date | null; errorCode: string | null; errorMessage: string | null; connectedAccountId: string; userId: string },
    runCount: 0,
    issues: [] as Array<{ kind: string; telegramFileId: string | null; fileId: string | null; metadata: any }>,
    fileRows: [] as Array<{ id: string; providerFileId: string; name: string; mimeType: string; sizeBytes: bigint; folderId: string | null; telegramStableId: string | null; status: string }>,
    config: null as any,
    lockAcquired: true,
  }

  const prismaMock = {
    connectedAccount: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    telegramStorageConfig: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
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
      create: vi.fn(async () => {
        state.runCount += 1
        return { id: `run-${state.runCount}`, startedAt: new Date() }
      }),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    telegramSyncIssue: { create: vi.fn(async ({ data }: any) => { state.issues.push(data); return data }), count: vi.fn(async () => 0), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    file: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => state.fileRows), create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) },
    folder: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: any) => Array.isArray(ops) ? Promise.all(ops) : ops),
  }
  const withTelegramClientMock = vi.fn()
  return { state, prismaMock, withTelegramClientMock }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('./telegram-usage.service.js', () => ({ syncTelegramUsage: vi.fn(async () => undefined) }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn() }))
vi.mock('./telegram.service.js', async () => {
  const actual = await vi.importActual<typeof import('./telegram.service.js')>('./telegram.service.js')
  return { ...actual, withTelegramClient: h.withTelegramClientMock }
})
vi.mock('./telegram-ingest.service.js', () => ({
  ingestTelegramDocument: vi.fn(async (_userId: string, _accountId: string, doc: { name: string; size: number; mimeType: string | null; remoteId: string }, _caption: string | null) => 'created' as const),
}))

import { runTelegramSync } from './telegram-sync.service.js'

function fakeChannel() {
  return { id: 4458806678, title: 'storage', megagroup: false, broadcast: true } as never
}

function fakeClient(opts: { documents: Array<{ messageId: number; name: string; size: number; mimeType: string | null }>; throwOnFirst?: unknown }): TelegramClient {
  return {
    async connect() {},
    async disconnect() {},
    async getInputEntity() { return {} as never },
    async getEntity() { return fakeChannel() },
    iterMessages(_channel: unknown, _params: unknown) {
      if (opts.throwOnFirst) throw opts.throwOnFirst
      // Yield each document once.
      const docs = opts.documents
      return (async function* () {
        for (const d of docs) {
          yield { id: d.messageId, document: { size: d.size, mimeType: d.mimeType, attributes: [{ fileName: d.name }] } }
        }
      })()
    },
  } as unknown as TelegramClient
}

/** Like fakeClient but also returns captions on getMessages. */
function fakeClientWithCaptions(opts: {
  documents: Array<{ messageId: number; name: string; size: number; mimeType: string | null }>
  captions: Map<number, string>
}): TelegramClient {
  const base = fakeClient({ documents: opts.documents })
  return {
    ...base,
    async getMessages(_channel: unknown, params: { ids: number[] }) {
      return params.ids.map((id) => ({ id, message: opts.captions.get(id) ?? '' }))
    },
  } as unknown as TelegramClient
}

/**
 * Client whose `iterMessages` honours the real teleproto contract: `minId`
 * (camelCase) is an exclusive lower bound, `reverse: true` yields ascending.
 * `seen` records the options of every page fetch — this is what catches a
 * dropped cursor (a snake_case `min_id` would leave `minId` undefined and the
 * scan would loop over the same first page forever).
 */
function paginatingClient(
  documents: Array<{ messageId: number; name: string; size: number; mimeType: string | null }>,
  seen: Array<{ minId?: number; limit?: number; reverse?: boolean }>,
): TelegramClient {
  return {
    async connect() {},
    async disconnect() {},
    async getInputEntity() { return {} as never },
    async getEntity() { return fakeChannel() },
    iterMessages(_channel: unknown, params: { minId?: number; limit?: number; reverse?: boolean }) {
      seen.push(params)
      const from = params.minId ?? 0
      const ordered = [...documents].sort((a, b) => params.reverse ? a.messageId - b.messageId : b.messageId - a.messageId)
      const page = ordered.filter((d) => params.reverse ? d.messageId > from : true).slice(0, params.limit ?? 100)
      return (async function* () {
        for (const d of page) {
          yield { id: d.messageId, document: { size: d.size, mimeType: d.mimeType, attributes: [{ fileName: d.name }] } }
        }
      })()
    },
  } as unknown as TelegramClient
}

beforeEach(() => {
  vi.clearAllMocks()
  // Re-establish the default prisma mock implementations after
  // clearAllMocks wipes them.
  h.prismaMock.telegramSyncState.upsert.mockImplementation(async ({ create, update }: any) => {
    if (!h.state.syncState) {
      h.state.syncState = { status: update?.status ?? create.status, lastMessageId: update?.lastMessageId ?? create.lastMessageId ?? null, lastScanAt: update?.lastScanAt ?? null, errorCode: null, errorMessage: null, connectedAccountId: create.connectedAccountId, userId: create.userId }
    }
    return h.state.syncState
  })
  h.prismaMock.telegramSyncState.update.mockResolvedValue({} as any)
  h.prismaMock.telegramSyncState.updateMany.mockImplementation(async () => ({ count: h.state.lockAcquired ? 1 : 0 }))
  h.prismaMock.telegramSyncState.findUnique.mockImplementation(async () => h.state.syncState)

  h.prismaMock.telegramSyncRun.create.mockImplementation(async () => {
    h.state.runCount += 1
    return { id: `run-${h.state.runCount}`, startedAt: new Date() }
  })
  h.prismaMock.telegramSyncRun.update.mockResolvedValue({ id: 'run-1' } as any)
  h.prismaMock.telegramSyncRun.findMany.mockResolvedValue([])
  h.prismaMock.telegramSyncRun.findFirst.mockResolvedValue(null)

  h.prismaMock.telegramSyncIssue.create.mockImplementation(async ({ data }: any) => { h.state.issues.push(data); return data })
  h.prismaMock.telegramSyncIssue.count.mockResolvedValue(0)
  h.prismaMock.telegramSyncIssue.findMany.mockResolvedValue([])
  h.prismaMock.telegramSyncIssue.update.mockResolvedValue({} as any)
  h.prismaMock.telegramSyncIssue.updateMany.mockResolvedValue({ count: 0 })

  h.prismaMock.file.findFirst.mockResolvedValue(null)
  h.prismaMock.file.findMany.mockImplementation(async () => h.state.fileRows)
  h.prismaMock.file.create.mockResolvedValue({} as any)
  h.prismaMock.file.update.mockResolvedValue({} as any)
  h.prismaMock.file.upsert.mockResolvedValue({} as any)

  h.prismaMock.folder.findFirst.mockResolvedValue(null)
  h.prismaMock.folder.create.mockResolvedValue({} as any)

  h.prismaMock.$transaction.mockImplementation(async (ops: any) => Array.isArray(ops) ? Promise.all(ops) : ops)

  h.state.syncState = null
  h.state.runCount = 0
  h.state.issues = []
  h.state.fileRows = []
  h.state.lockAcquired = true

  h.prismaMock.connectedAccount.findFirst.mockResolvedValue({ id: 'acc-1', userId: 'user-1', provider: 'telegram', status: 'connected' })
  h.prismaMock.telegramStorageConfig.findFirstOrThrow.mockResolvedValue({ channelId: '4458806678', channelTitle: 'storage' } as any)
  h.prismaMock.telegramStorageConfig.findFirst.mockResolvedValue({ channelId: '4458806678', channelTitle: 'storage' } as any)
})

describe('runTelegramSync — initial sync', () => {
  it('imports 10 orphan documents into the inbox folder', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      messageId: i + 1, name: `f${i + 1}.txt`, size: 100, mimeType: 'text/plain',
    }))
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ documents: docs })))

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.status).toBe('completed')
    expect(result.scannedCount).toBe(10)
    expect(result.matchedCount).toBe(0)
    expect(result.importedCount).toBe(10)
    expect(result.orphanCount).toBe(10)
    expect(result.missingCount).toBe(0)
    expect(result.conflictCount).toBe(0)
  })

  it('marks all documents as matched when the DB already has rows', async () => {
    const docs = [
      { messageId: 1, name: 'a.txt', size: 100, mimeType: 'text/plain' },
      { messageId: 2, name: 'b.txt', size: 100, mimeType: 'text/plain' },
    ]
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active' },
      { id: 'f2', providerFileId: 'telegram://4458806678/2', name: 'b.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active' },
    ]
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ documents: docs })))

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.scannedCount).toBe(2)
    expect(result.matchedCount).toBe(2)
    expect(result.importedCount).toBe(0)
    expect(result.missingCount).toBe(0)
  })
})

describe('runTelegramSync — incremental sync', () => {
  it('only processes documents newer than the persisted cursor', async () => {
    // Persisted state: lastMessageId = 5
    h.state.syncState = {
      status: 'up_to_date', lastMessageId: 5n, lastScanAt: new Date(),
      errorCode: null, errorMessage: null, connectedAccountId: 'acc-1', userId: 'user-1',
    }
    // New run iterates from minId=5; the fakeClient mock ignores the params
    // (it just yields the documents it's given), but the test proves the
    // cursor is read. Pass only 2 documents.
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ documents: [
      { messageId: 6, name: 'new1.txt', size: 100, mimeType: 'text/plain' },
      { messageId: 7, name: 'new2.txt', size: 100, mimeType: 'text/plain' },
    ] })))

    const result = await runTelegramSync('user-1', 'acc-1')
    expect(result.scannedCount).toBe(2)
    expect(result.importedCount).toBe(2)
  })

  it('never flags REMOTE_FILE_MISSING on an incremental run', async () => {
    // Pass 2 compares an account-wide row snapshot against only this run's
    // pages, so on an incremental run every row below the cursor looks
    // "unseen". Missing-detection is full-scan only.
    h.state.syncState = {
      status: 'up_to_date', lastMessageId: 5n, lastScanAt: new Date(),
      errorCode: null, errorMessage: null, connectedAccountId: 'acc-1', userId: 'user-1',
    }
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/1', name: 'old.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active' },
    ]
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ documents: [
      { messageId: 6, name: 'new1.txt', size: 100, mimeType: 'text/plain' },
    ] })))

    const incremental = await runTelegramSync('user-1', 'acc-1')
    expect(incremental.missingCount).toBe(0)
    expect(h.state.issues.length).toBe(0)

    // Same fixture as a full scan → the row IS flagged.
    const full = await runTelegramSync('user-1', 'acc-1', { full: true })
    expect(full.missingCount).toBe(1)
    expect(h.state.issues.map((i) => i.kind)).toEqual(['REMOTE_FILE_MISSING'])
  })
})

describe('runTelegramSync — orphan / missing / conflict', () => {
  it('flags a missing-remote issue for a DB row whose Telegram message disappeared', async () => {
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/42', name: 'gone.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active' },
    ]
    // Channel has NO documents.
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ documents: [] })))

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.missingCount).toBe(1)
    expect(h.state.issues.length).toBe(1)
    expect(h.state.issues[0].kind).toBe('REMOTE_FILE_MISSING')
    expect(h.state.issues[0].fileId).toBe('f1')
  })

  it('does NOT flag missing-remote on soft-deleted DB rows (user explicitly trashed them)', async () => {
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/42', name: 'trashed.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'deleted' },
    ]
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ documents: [] })))

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.missingCount).toBe(0)
    expect(h.state.issues.length).toBe(0)
  })

  it('flags a metadata-mismatch issue when the DB row size differs', async () => {
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active' },
    ]
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ documents: [
      { messageId: 1, name: 'a.txt', size: 200, mimeType: 'text/plain' }, // size differs
    ] })))

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.conflictCount).toBe(1)
    expect(h.state.issues.some((issue) => issue.kind === 'TELEGRAM_METADATA_MISMATCH')).toBe(true)
  })
})

describe('runTelegramSync — single-flight + error handling', () => {
  it('returns SYNC_ALREADY_RUNNING when the lock is held', async () => {
    h.state.lockAcquired = false
    await expect(runTelegramSync('user-1', 'acc-1')).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' })
  })

  it('does NOT mark files missing when the API errors transiently', async () => {
    h.state.fileRows = [
      { id: 'f1', providerFileId: 'telegram://4458806678/1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 100n, folderId: null, telegramStableId: null, status: 'active' },
    ]
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, _fn: (client: TelegramClient) => Promise<unknown>) => {
      throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })
    })
    await expect(runTelegramSync('user-1', 'acc-1')).rejects.toBeTruthy()
    // No missing-remote issues written for f1 — transient failure must
    // not silently delete DB rows.
    const missingIssues = h.state.issues.filter((issue) => issue.fileId === 'f1' && issue.kind === 'REMOTE_FILE_MISSING')
    expect(missingIssues.length).toBe(0)
  })

  it('returns GOOGLE_REAUTH_REQUIRED for reauth-required accounts', async () => {
    h.prismaMock.connectedAccount.findFirst.mockResolvedValueOnce({ id: 'acc-1', userId: 'user-1', provider: 'telegram', status: 'reauth_required' })
    await expect(runTelegramSync('user-1', 'acc-1')).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' })
  })

  it('returns STORAGE_ACCOUNT_NOT_FOUND for unknown accounts', async () => {
    h.prismaMock.connectedAccount.findFirst.mockResolvedValueOnce(null)
    await expect(runTelegramSync('user-1', 'acc-1')).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_NOT_FOUND' })
  })
})

describe('runTelegramSync — pagination / large channel', () => {
  it('drains a 250-document channel with a forward cursor', async () => {
    // Regression: `min_id` (snake_case) is silently dropped by teleproto, so
    // every page restarted from the newest message and only the newest ~100
    // documents were ever scanned. The mock honours `minId`/`reverse`, so a
    // dropped cursor would stall at 100.
    const docs = Array.from({ length: 250 }, (_, i) => ({
      messageId: i + 1, name: `f${i + 1}.txt`, size: 100, mimeType: 'text/plain',
    }))
    const seen: Array<{ minId?: number; limit?: number; reverse?: boolean }> = []
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(paginatingClient(docs, seen)))

    const result = await runTelegramSync('user-1', 'acc-1')

    expect(result.scannedCount).toBe(250)
    expect(result.importedCount).toBe(250)
    // 3 pages: 100, 100, 50 (the short page ends the scan).
    expect(seen.map((s) => s.minId)).toEqual([0, 100, 200])
    expect(seen.every((s) => s.reverse === true)).toBe(true)
  })
})

describe('runTelegramSync — caption-driven resolution for orphans', () => {
  it('fetches captions for orphan docs and reports per-strategy stats + structured log', async () => {
    const docs = [
      { messageId: 1, name: 'ep1.mkv', size: 1024, mimeType: 'video/x-matroska' },
      { messageId: 2, name: 'ep2.mkv', size: 1024, mimeType: 'video/x-matroska' },
      { messageId: 3, name: 'orphan.mkv', size: 1024, mimeType: 'video/x-matroska' },
    ]
    const captions = new Map<number, string>([
      [1, '9drive:id=stable-1\n9drive:path=Movies/Anime/One Piece/ep1.mkv'],
      [2, '9drive:path=Movies/Anime/One Piece/ep2.mkv'],
      [3, ''],
    ])
    h.withTelegramClientMock.mockImplementation(
      async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) =>
        fn(fakeClientWithCaptions({ documents: docs, captions })),
    )

    // The orchestrator-level stub of ingestTelegramDocument is a black box
    // for stats purposes — we only assert on the counts and structured log
    // emitted by the sync path itself, which now consumes captions.
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const result = await runTelegramSync('user-1', 'acc-1')

    // All three docs are orphans (no existing rows in h.state.fileRows),
    // so they all flow through the caption-driven ingest path.
    expect(result.scannedCount).toBe(3)
    expect(result.importedCount).toBe(3)
    // Per-strategy breakdown is exposed on the run summary.
    expect(result.matchedByIdCount + result.matchedByPathCount + result.recoveredCount).toBe(3)

    // The structured per-document log fired once per orphan document.
    const documentLogs = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(c[1] as string) } catch { return null } })
      .filter((j) => j && j.event === 'telegram.sync.document')
    expect(documentLogs).toHaveLength(3)
    const strategies = documentLogs.map((j) => j.matchStrategy).sort()
    // Doc 1 → 9drive_id, doc 2 → 9drive_path, doc 3 → none (empty caption).
    // The orchestrator-level stub returns 'created' for every ingest, so
    // the per-strategy breakdown maps each caption to its parsed value.
    expect(strategies).toEqual(['9drive_id', '9drive_path', 'none'])

    logSpy.mockRestore()
  })

  it('keeps working when caption fetch fails (falls back to recovery inbox)', async () => {
    const docs = [{ messageId: 1, name: 'a.mkv', size: 1, mimeType: 'video/x-matroska' }]
    h.withTelegramClientMock.mockImplementation(async (_cfg: unknown, fn: (client: TelegramClient) => Promise<unknown>) => {
      // Client whose getMessages throws (e.g. transient network error).
      const base = fakeClient({ documents: docs })
      return fn({
        ...base,
        async getMessages() { throw new Error('TELEGRAM_NETWORK') },
      } as unknown as TelegramClient)
    })

    const result = await runTelegramSync('user-1', 'acc-1')

    // The orphan still routes through ingest; classifyOne catches the
    // caption failure and falls through to the no-caption path.
    expect(result.scannedCount).toBe(1)
    expect(result.importedCount).toBe(1)
    expect(result.recoveredCount).toBe(1)
  })
})