import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  update: vi.fn(),
  findUnique: vi.fn(),
  acquire: vi.fn(),
  env: {
    REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS: 1000,
    REMOTE_IMPORT_TEMP_FREE_SPACE_RESERVE_BYTES: 0,
  },
}))

vi.mock('../../config/env.js', () => ({ env: h.env }))
vi.mock('../../config/prisma.js', () => ({
  prisma: { remoteImport: { update: h.update, findUnique: h.findUnique } },
}))
vi.mock('./resource-control.js', () => ({
  estimateTempReservation: vi.fn(() => 1n),
  tempStorageReservations: { tryAcquire: h.acquire },
}))

import { createRemoteImportProcessorContext } from './processor-context.js'

describe('RemoteImportProcessorContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.update.mockResolvedValue(undefined)
    h.findUnique.mockResolvedValue({ status: 'processing' })
    h.acquire.mockResolvedValue({ admitted: true, reservation: { release: vi.fn() } })
  })

  it('binds stage and heartbeat updates to one import', async () => {
    const context = createRemoteImportProcessorContext({
      importId: 'import-1',
      record: { id: 'import-1', userId: 'user-1', folderId: null, sourceType: 'direct' },
      userId: 'user-1',
      folderId: null,
      fileName: 'report.txt',
      mimeType: 'text/plain',
      sourceUrl: 'https://example.test/report.txt',
      maxBytes: 100n,
      startedAt: Date.now(),
      jobTimeoutMs: 60_000,
    })

    await context.updateStage('downloading', { downloadedBytes: '3' })
    await context.heartbeat()

    expect(h.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'import-1' },
      data: expect.objectContaining({ stage: 'downloading', downloadedBytes: '3', heartbeatAt: expect.any(Date) }),
    }))
    expect(h.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'import-1' },
      data: { heartbeatAt: expect.any(Date) },
    }))
  })

  it('raises the canonical abort error when the persisted import is cancelled', async () => {
    h.findUnique.mockResolvedValueOnce({ status: 'cancelled' })
    const context = createRemoteImportProcessorContext({
      importId: 'import-1',
      record: { id: 'import-1', userId: 'user-1', folderId: null, sourceType: 'direct' },
      userId: 'user-1',
      folderId: null,
      fileName: 'report.txt',
      mimeType: 'text/plain',
      sourceUrl: 'https://example.test/report.txt',
      maxBytes: 100n,
      startedAt: Date.now(),
      jobTimeoutMs: 60_000,
    })

    await expect(context.assertNotCancelled()).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' })
  })
})
