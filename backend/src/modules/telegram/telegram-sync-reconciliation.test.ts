import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  createIssue: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('../../config/env.js', () => ({ env: { TELEGRAM_SYNC_TRASH_MISSING: true } }))
vi.mock('../../config/prisma.js', () => ({ prisma: { file: { findMany: h.findMany, update: h.update } } }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: h.audit }))
vi.mock('./telegram-sync-persistence.js', () => ({ createIssueIfOpenNotExists: h.createIssue }))

import { reconcileMissingTelegramFiles } from './telegram-sync-reconciliation.js'
import { emptyTelegramSyncStats } from './telegram-sync-types.js'

describe('Telegram sync reconciliation boundary', () => {
  it('flags and optionally soft-deletes only active rows unseen in a full scan', async () => {
    h.findMany.mockResolvedValueOnce([
      { id: 'file-1', name: 'gone.txt', status: 'active', lastSeenSyncRunId: null },
      { id: 'file-2', name: 'seen.txt', status: 'active', lastSeenSyncRunId: 'run-1' },
    ])
    h.update.mockResolvedValue(undefined)
    h.createIssue.mockResolvedValue(undefined)
    h.audit.mockResolvedValue(undefined)
    const stats = emptyTelegramSyncStats()

    await reconcileMissingTelegramFiles({ userId: 'user-1', accountId: 'acc-1', runId: 'run-1', stats })

    expect(h.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'REMOTE_FILE_MISSING',
      fileId: 'file-1',
    }))
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'file-1', userId: 'user-1' },
      data: expect.objectContaining({ status: 'deleted' }),
    }))
    expect(stats).toMatchObject({ missingCount: 1, scannedCount: 1, trashedCount: 1 })
  })
})
