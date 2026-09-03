import { beforeEach, describe, expect, it, vi } from 'vitest'

// Verify the spec's required scenarios for Telegram sync caption handling:
//   - 9drive:id is matched first
//   - 9drive:path resolves to a folder chain (existing or auto-created)
//   - existing files in the wrong folder get moved to the correct one
//   - missing folders are created, not routed to the recovery inbox
//   - root-level paths land at the user root
//   - spaces, `=`, CRLF, and extra caption text are preserved
//   - invalid / traversal paths fall back to the recovery inbox
//   - missing id + path-only still resolves safely
//   - missing path keeps the existing file in place
//   - repeated sync is idempotent

const h = vi.hoisted(() => {
  const prismaMock = {
    connectedAccount: { findFirst: vi.fn() },
    file: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    folder: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    audit: { create: vi.fn() },
  }
  return { prismaMock }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('./telegram-usage.service.js', () => ({ syncTelegramUsage: vi.fn() }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn() }))
vi.mock('./telegram.service.js', async () => {
  const actual = await vi.importActual<typeof import('./telegram.service.js')>('./telegram.service.js')
  return {
    ...actual,
    listTelegramDocuments: vi.fn(),
    getTelegramConfig: vi.fn(),
    withTelegramClient: vi.fn(),
  }
})

import { ingestTelegramDocument } from './telegram-ingest.service.js'
import { parseCaption } from './telegram-metadata.js'

const document = {
  remoteId: 'telegram://4458806678/42',
  name: 'architecture.md',
  size: 1024,
  mimeType: 'text/markdown',
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no existing folder / file matches. Individual tests override.
  h.prismaMock.folder.findFirst.mockResolvedValue(null)
  h.prismaMock.folder.findMany.mockResolvedValue([])
  h.prismaMock.folder.create.mockImplementation(async ({ data }: any) => ({ id: `${data.parentId ?? 'root'}/${data.name}` }))
  h.prismaMock.file.findFirst.mockResolvedValue(null)
  h.prismaMock.file.create.mockResolvedValue({ id: 'new-file' })
  h.prismaMock.file.update.mockResolvedValue({ id: 'updated-file' })
})

describe('ingestTelegramDocument — exact id + path', () => {
  it('matches the existing file by 9drive:id and updates its folder/filename', async () => {
    // Case 1 lookup by stableId → found.
    h.prismaMock.file.findFirst
      .mockResolvedValueOnce({ id: 'file-1', providerFileId: document.remoteId })
    // Inside updateFromParsed — read current row.
    h.prismaMock.file.findFirst.mockResolvedValueOnce({
      id: 'file-1',
      providerFileId: document.remoteId,
      name: 'old.md',
      folderId: null,
      mimeType: 'text/plain',
      sizeBytes: 100n,
      telegramStableId: 'stable-1',
    })

    const result = await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-1\n9drive:path=Movies/Anime/file.mkv',
    )

    expect(result).toBe('updated')
    const args = h.prismaMock.file.update.mock.calls[0]?.[0]
    expect(args.data.name).toBe('file.mkv')
    expect(args.data.folderId).toBe('root/Movies/Anime')
  })

  it('creates the missing folder chain (Projects → APP-V → docs) for a fresh id', async () => {
    // Case 1: stableId present, no existing file → createOrInboxFromParsed.
    h.prismaMock.file.findFirst.mockResolvedValue(null)

    await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-2\n9drive:path=Projects/APP-V/docs/architecture.md',
    )

    const createArgs = h.prismaMock.file.create.mock.calls[0]?.[0]
    expect(createArgs.data.name).toBe('architecture.md')
    expect(createArgs.data.folderId).toBe('root/Projects/APP-V/docs')
    expect(createArgs.data.telegramStableId).toBe('stable-2')
  })
})

describe('ingestTelegramDocument — existing file in recovery folder', () => {
  it('moves the file out of the recovery folder into its correct location', async () => {
    // Case 1 by stableId → found in recovery folder.
    h.prismaMock.file.findFirst.mockResolvedValueOnce({
      id: 'file-recovered',
      providerFileId: document.remoteId,
    })
    // Inside updateFromParsed — current row is in the recovery folder.
    h.prismaMock.file.findFirst.mockResolvedValueOnce({
      id: 'file-recovered',
      providerFileId: document.remoteId,
      name: 'episode-01.mkv',
      folderId: 'recovery-folder-id',
      mimeType: 'video/x-matroska',
      sizeBytes: 1024n,
      telegramStableId: 'stable-recovered',
    })

    const result = await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-recovered\n9drive:path=Movies/Anime/One Piece/episode-01.mkv',
    )

    expect(result).toBe('updated')
    const args = h.prismaMock.file.update.mock.calls[0]?.[0]
    // File moved out of recovery; folder chain created.
    expect(args.data.folderId).toBe('root/Movies/Anime/One Piece')
    // No second file was created.
    expect(h.prismaMock.file.create).not.toHaveBeenCalled()
  })
})

describe('ingestTelegramDocument — missing folder chain', () => {
  it('creates every missing folder in the chain when none of them exist', async () => {
    h.prismaMock.file.findFirst.mockResolvedValue(null)

    await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-3\n9drive:path=Projects/2026/Reports/September/report.pdf',
    )

    // All four folder segments were created.
    expect(h.prismaMock.folder.create).toHaveBeenCalledTimes(4)
    const folderNames = h.prismaMock.folder.create.mock.calls.map((c) => c[0].data.name)
    expect(folderNames).toEqual(['Projects', '2026', 'Reports', 'September'])
    const createArgs = h.prismaMock.file.create.mock.calls[0]?.[0]
    expect(createArgs.data.folderId).toBe('root/Projects/2026/Reports/September')
  })
})

describe('ingestTelegramDocument — root-level path', () => {
  it('places the file at the user root when 9drive:path has no parent segments', async () => {
    h.prismaMock.file.findFirst.mockResolvedValue(null)

    await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-4\n9drive:path=movie.mkv',
    )

    const args = h.prismaMock.file.create.mock.calls[0]?.[0]
    expect(args.data.name).toBe('movie.mkv')
    expect(args.data.folderId).toBeNull()
  })
})

describe('ingestTelegramDocument — filename with spaces and `=`', () => {
  it('preserves the filename as-is from the path basename', async () => {
    h.prismaMock.file.findFirst.mockResolvedValue(null)

    await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-5\n9drive:path=Movies/Documentaries/My Movie 1080p.mkv',
    )

    const args = h.prismaMock.file.create.mock.calls[0]?.[0]
    expect(args.data.name).toBe('My Movie 1080p.mkv')
    expect(args.data.folderId).toBe('root/Movies/Documentaries')
  })

  it('preserves an `=` character inside a filename (splits only on the first `=`)', async () => {
    // First inspect that the parser handles this directly.
    const parsed = parseCaption('9drive:id=abc\n9drive:path=Movies/file=name.mkv')
    expect(parsed.logicalPath).toBe('Movies/file=name.mkv')

    h.prismaMock.file.findFirst.mockResolvedValue(null)

    await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-6\n9drive:path=Movies/file=name.mkv',
    )

    const args = h.prismaMock.file.create.mock.calls[0]?.[0]
    expect(args.data.name).toBe('file=name.mkv')
    expect(args.data.folderId).toBe('root/Movies')
  })
})

describe('ingestTelegramDocument — CRLF and extra caption text', () => {
  it('parses CRLF line endings identically to LF', () => {
    const crlfCaption = '9drive:id=abc\r\n9drive:path=Movies/Anime/file.mkv'
    const lfCaption = '9drive:id=abc\n9drive:path=Movies/Anime/file.mkv'
    const a = parseCaption(crlfCaption)
    const b = parseCaption(lfCaption)
    expect(a.stableId).toBe(b.stableId)
    expect(a.logicalPath).toBe(b.logicalPath)
  })

  it('ignores extra human-written caption lines but still extracts metadata', () => {
    const parsed = parseCaption([
      'human-readable note',
      '9drive:id=abc',
      'second note',
      '9drive:path=A/B/file.txt',
      'tail',
    ].join('\n'))
    expect(parsed.stableId).toBe('abc')
    expect(parsed.logicalPath).toBe('A/B/file.txt')
    expect(parsed.extraLines).toEqual(['human-readable note', 'second note', 'tail'])
  })
})

describe('ingestTelegramDocument — invalid paths fall back to the recovery inbox', () => {
  it('routes traversal paths (../) to the recovery folder', async () => {
    h.prismaMock.file.findFirst.mockResolvedValue(null)

    const result = await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-bad\n9drive:path=../../outside/file.mkv',
    )

    // The parser drops the traversal path; only the id survives.
    // The file ends up in the recovery inbox (no logical path → inbox).
    expect(result).toBe('inboxed')
    const args = h.prismaMock.file.create.mock.calls[0]?.[0]
    // No folderId → recovery inbox folder set by createInboxFile (we don't
    // assert the exact id, just that folderId is set, not a hierarchy).
    expect(args.data.folderId).toBeDefined()
    expect(args.data.name).toBe('architecture.md')
  })

  it('routes captions with no metadata at all to the recovery inbox', async () => {
    const result = await ingestTelegramDocument('user-1', 'acc-1', document, 'just a human caption')
    expect(result).toBe('inboxed')
  })
})

describe('ingestTelegramDocument — missing id / missing path', () => {
  it('with only a path and a matching providerFileId, the existing file is reused (no duplicate)', async () => {
    // Case 1: no stableId.
    // Case 2: lookup by providerFileId → existing file (first findFirst).
    // updateFromParsed then re-reads the same row (second findFirst) before
    // writing the update.
    h.prismaMock.file.findFirst
      .mockResolvedValueOnce({
        id: 'file-existing',
        name: 'old.md',
        folderId: 'oldFolder',
        mimeType: 'text/plain',
        sizeBytes: 100n,
        telegramStableId: null,
      })
      .mockResolvedValueOnce({
        id: 'file-existing',
        name: 'old.md',
        folderId: 'oldFolder',
        mimeType: 'text/plain',
        sizeBytes: 100n,
        telegramStableId: null,
      })

    const result = await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:path=Movies/Anime/file.mkv',
    )

    // updateFromParsed is invoked.
    expect(result).toBe('updated')
    const args = h.prismaMock.file.update.mock.calls[0]?.[0]
    expect(args.data.name).toBe('file.mkv')
    expect(args.data.folderId).toBe('root/Movies/Anime')
    // No new row was created.
    expect(h.prismaMock.file.create).not.toHaveBeenCalled()
  })

  it('with only an id (no path), the existing file keeps its current folder and filename', async () => {
    // Case 1: lookup by stableId → found.
    h.prismaMock.file.findFirst.mockResolvedValueOnce({ id: 'file-existing', providerFileId: document.remoteId })
    // Inside updateFromParsed — current row stays put.
    h.prismaMock.file.findFirst.mockResolvedValueOnce({
      id: 'file-existing',
      providerFileId: document.remoteId,
      name: 'kept.md',
      folderId: 'keptFolder',
      mimeType: 'text/markdown',
      sizeBytes: 1024n,
      telegramStableId: 'stable-existing',
    })

    const result = await ingestTelegramDocument(
      'user-1',
      'acc-1',
      document,
      '9drive:id=stable-existing',
    )

    expect(result).toBe('matched')
    expect(h.prismaMock.file.update).not.toHaveBeenCalled()
  })
})

describe('ingestTelegramDocument — idempotency', () => {
  it('repeated runs with the same caption produce no duplicate files', async () => {
    h.prismaMock.file.findFirst.mockResolvedValue(null)

    const caption = '9drive:id=stable-idem\n9drive:path=Movies/file.mkv'

    // First run: no existing row → create.
    await ingestTelegramDocument('user-1', 'acc-1', document, caption)
    const firstCreateCount = h.prismaMock.file.create.mock.calls.length

    // Second run: same id now exists.
    h.prismaMock.file.findFirst.mockReset()
    h.prismaMock.file.findFirst
      .mockResolvedValueOnce({ id: 'file-1', providerFileId: document.remoteId })
      .mockResolvedValueOnce({
        id: 'file-1',
        providerFileId: document.remoteId,
        name: 'file.mkv',
        folderId: 'root/Movies',
        mimeType: 'text/markdown',
        sizeBytes: 1024n,
        telegramStableId: 'stable-idem',
      })

    await ingestTelegramDocument('user-1', 'acc-1', document, caption)

    // No second create.
    expect(h.prismaMock.file.create.mock.calls.length).toBe(firstCreateCount)
    expect(h.prismaMock.file.update).not.toHaveBeenCalled()
  })
})