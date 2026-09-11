import { describe, expect, it, vi } from 'vitest'

vi.mock('./telegram-metadata-cache.js', () => ({
  inspectCaptionMeta: vi.fn(() => null),
}))

import { applyOutcomeStats, classifyTelegramDocument } from './telegram-sync-classification.js'
import type { TelegramDocument, TelegramFileRow, TelegramSyncRunStats } from './telegram-sync-types.js'

const document: TelegramDocument = {
  remoteId: 'telegram://-1001/7',
  channelId: '-1001',
  messageId: 7,
  name: 'report.txt',
  size: 12,
  mimeType: 'text/plain',
  caption: null,
}

const existing = (overrides: Partial<TelegramFileRow> = {}): TelegramFileRow => ({
  id: 'file-1',
  providerFileId: document.remoteId,
  name: document.name,
  mimeType: 'text/plain',
  sizeBytes: 12n,
  folderId: null,
  telegramStableId: null,
  status: 'active',
  encryptedMetadata: null,
  ...overrides,
})

const stats = (): TelegramSyncRunStats => ({
  scannedCount: 0,
  matchedCount: 0,
  importedCount: 0,
  missingCount: 0,
  orphanCount: 0,
  conflictCount: 0,
  errorCount: 0,
  matchedByIdCount: 0,
  matchedByPathCount: 0,
  recoveredCount: 0,
  trashedCount: 0,
})

describe('Telegram sync classification boundary', () => {
  it('matches a physical provider row before consulting caption or ingest', async () => {
    const ingest = vi.fn()
    const result = await classifyTelegramDocument({
      document,
      existing: existing(),
      fetchedCaption: null,
      ingest,
      findPlacedFile: vi.fn(),
    })

    expect(result).toEqual({ outcome: { kind: 'matched' }, fileIdToStamp: 'file-1' })
    expect(ingest).not.toHaveBeenCalled()
  })

  it('reports a size conflict without trying to repair the row', async () => {
    const ingest = vi.fn()
    const result = await classifyTelegramDocument({
      document,
      existing: existing({ sizeBytes: 99n }),
      fetchedCaption: '9drive:id=file-1',
      ingest,
      findPlacedFile: vi.fn(),
    })

    expect(result.outcome).toMatchObject({ kind: 'conflict', telegramFileId: document.remoteId, file: { id: 'file-1' } })
    expect(ingest).not.toHaveBeenCalled()
  })

  it('uses id, path, then recovery as explicit orphan strategies', async () => {
    const ingest = vi.fn().mockResolvedValue('created')
    const findPlacedFile = vi.fn().mockResolvedValue({ id: 'file-new', folderId: 'folder-1' })

    await expect(classifyTelegramDocument({
      document,
      existing: null,
      fetchedCaption: '9drive:id=stable-1\n9drive:path=Reports/report.txt',
      ingest,
      findPlacedFile,
    })).resolves.toMatchObject({ outcome: { kind: 'imported', strategy: '9drive_id', action: 'created' } })

    await expect(classifyTelegramDocument({
      document,
      existing: null,
      fetchedCaption: '9drive:path=Reports/report.txt',
      ingest,
      findPlacedFile,
    })).resolves.toMatchObject({ outcome: { kind: 'imported', strategy: '9drive_path' } })

    ingest.mockResolvedValueOnce('inboxed')
    await expect(classifyTelegramDocument({
      document,
      existing: null,
      fetchedCaption: 'human caption',
      ingest,
      findPlacedFile,
    })).resolves.toMatchObject({ outcome: { kind: 'imported', strategy: 'recovered', action: 'inboxed' } })
  })

  it('keeps outcome statistics as a pure operation', () => {
    const current = stats()
    applyOutcomeStats(current, { kind: 'imported', telegramFileId: document.remoteId, strategy: '9drive_path', virtualPath: 'Reports/report.txt', fileId: 'file-new', parentFolderId: 'folder-1', action: 'created' })
    applyOutcomeStats(current, { kind: 'conflict', telegramFileId: document.remoteId, reason: 'size mismatch', file: { id: 'file-1', name: 'report.txt' } })
    expect(current).toMatchObject({ scannedCount: 2, importedCount: 1, orphanCount: 1, matchedByPathCount: 1, conflictCount: 1 })
  })
})
