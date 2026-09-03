/**
 * WebDAV Telegram provider stream tests.
 *
 * Verifies the `telegram` branch in `streamProviderFileToReadable` streams the
 * requested byte window directly from Telegram via `iterDownload`'s native
 * offset/limit (NO temp file, NO full-file pre-download):
 *   - full GET streams the entire file
 *   - Range GET streams only the requested window (206 semantics)
 *   - open-ended range streams to EOF
 *   - the trimming generator cuts the final overshoot chunk (the library's
 *     `limit` is approximate, rounded up to whole request chunks)
 *   - `download.close()` always runs (end, error, early destroy)
 *   - missing / failed Telegram downloads surface as stable AppErrors
 */

import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import type { File, ConnectedAccount } from '@prisma/client'

const h = vi.hoisted(() => {
  const prismaMock = {
    telegramStorageConfig: { findFirstOrThrow: vi.fn() },
  }
  return { prismaMock, openTelegramDocument: vi.fn(), getTelegramConfig: vi.fn() }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

vi.mock('../telegram/telegram.service.js', async () => {
  const actual = await vi.importActual<typeof import('../telegram/telegram.service.js')>(
    '../telegram/telegram.service.js',
  )
  return {
    ...actual,
    openTelegramDocument: h.openTelegramDocument,
    getTelegramConfig: h.getTelegramConfig,
  }
})

// Imported AFTER the mocks are registered.
const { streamProviderFileToReadable } = await import('./webdav-virtual-fs.js')

function makeTelegramFile(overrides: Partial<File & { connectedAccount: ConnectedAccount }> = {}) {
  const base: File = {
    id: 'file-1',
    userId: 'user-1',
    folderId: null,
    connectedAccountId: 'acc-1',
    provider: 'telegram',
    providerFileId: 'telegram://-100123/42',
    name: 'movie.mkv',
    mimeType: 'video/x-matroska',
    sizeBytes: 1024n,
    checksum: null,
    status: 'active',
    telegramStableId: 'file-1',
    lastSeenSyncRunId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    deletedAt: null,
  }
  return { ...base, ...overrides, connectedAccount: { id: 'acc-1', userId: 'user-1', provider: 'telegram' } as ConnectedAccount } as File & { connectedAccount: ConnectedAccount }
}

/**
 * Emulate teleproto's `iterDownload` semantics: yields chunks starting at
 * `opts.offset`, in `requestSize` chunks, and MAY overshoot the requested
 * byte window by up to one chunk (because the library's `limit` is
 * approximate and rounded up to whole request chunks). It also respects an
 * overall `limit` (rounded up to whole chunks), like the real library.
 */
function iterDownloadLike(buffer: Buffer, opts: { offset?: number; limit?: number; requestSize?: number } = {}) {
  const requestSize = opts.requestSize ?? 512 * 1024
  const start = opts.offset ?? 0
  const hardLimit = opts.limit !== undefined ? start + Math.ceil(opts.limit / requestSize) * requestSize : undefined
  return (async function* () {
    for (let i = start; i < buffer.length; i += requestSize) {
      if (hardLimit !== undefined && i >= hardLimit) return
      yield buffer.subarray(i, Math.min(i + requestSize, buffer.length))
    }
  })()
}

function makeDownload(bytes: Buffer, opts: { offset?: number; limit?: number } = {}) {
  return {
    remoteId: 'telegram://-100123/42',
    stream: iterDownloadLike(bytes, opts),
    close: vi.fn(async () => undefined),
  }
}

// Capture the opts the WebDAV layer passed to openTelegramDocument.
let capturedOpts: { offset?: number; limit?: number } | undefined

function stubOpenDocument(bytes: Buffer) {
  h.openTelegramDocument.mockImplementation(async (_config: unknown, _remoteId: string, opts: { offset?: number; limit?: number } = {}) => {
    capturedOpts = opts
    return makeDownload(bytes, opts)
  })
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedOpts = undefined
  h.getTelegramConfig.mockResolvedValue({
    connectedAccountId: 'acc-1',
    apiIdEncrypted: 'x',
    apiHashEncrypted: 'y',
    sessionEncrypted: 'z',
  })
})

describe('streamProviderFileToReadable — telegram branch', () => {
  it('streams the full file when no Range is requested', async () => {
    const bytes = Buffer.from('hello-telegram'.repeat(100))
    stubOpenDocument(bytes)

    const file = makeTelegramFile({ sizeBytes: BigInt(bytes.length) })
    const stream = await streamProviderFileToReadable(file)
    const out = await readAll(stream)

    expect(out.equals(bytes)).toBe(true)
    // No range ⇒ start at offset 0, no byte limit.
    expect(capturedOpts).toEqual({ offset: 0, limit: undefined })
    expect(h.openTelegramDocument).toHaveBeenCalledTimes(1)
  })

  it('streams only the requested byte slice when Range is provided', async () => {
    const bytes = Buffer.alloc(2048, 0x41) // 'A'
    stubOpenDocument(bytes)

    const file = makeTelegramFile({ sizeBytes: BigInt(bytes.length) })
    const stream = await streamProviderFileToReadable(file, 'bytes=10-19')
    const out = await readAll(stream)

    expect(out.length).toBe(10)
    expect(out.equals(bytes.subarray(10, 20))).toBe(true)
    expect(capturedOpts).toEqual({ offset: 10, limit: 10 })
  })

  it('streams an open-ended range to end-of-file', async () => {
    const bytes = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    stubOpenDocument(bytes)

    const file = makeTelegramFile({ sizeBytes: BigInt(bytes.length) })
    const stream = await streamProviderFileToReadable(file, 'bytes=10-')
    const out = await readAll(stream)

    expect(out.length).toBe(bytes.length - 10)
    expect(out.equals(bytes.subarray(10))).toBe(true)
    expect(capturedOpts).toEqual({ offset: 10, limit: bytes.length - 10 })
  })

  it('clips an over-shooting end to size-1', async () => {
    const bytes = Buffer.from('0123456789')
    stubOpenDocument(bytes)

    const file = makeTelegramFile({ sizeBytes: BigInt(bytes.length) })
    const stream = await streamProviderFileToReadable(file, 'bytes=0-9999')
    const out = await readAll(stream)

    expect(out.length).toBe(10)
    expect(out.equals(bytes)).toBe(true)
    expect(capturedOpts).toEqual({ offset: 0, limit: 10 })
  })

  it('trims the final overshoot chunk to the exact requested window', async () => {
    // 3 whole 300-byte chunks. Request bytes 0-400 ⇒ limit 401, which the real
    // library rounds up to the next whole 300-byte chunk (yields 600 bytes).
    // The trimming generator must stop at exactly 401 bytes.
    const bytes = Buffer.alloc(900, 0x42)
    const download = {
      remoteId: 'telegram://-100123/42',
      stream: (async function* () {
        yield bytes.subarray(0, 300)
        yield bytes.subarray(300, 600)
        yield bytes.subarray(600, 900) // overshoot
      })(),
      close: vi.fn(async () => undefined),
    }
    h.openTelegramDocument.mockResolvedValue(download)

    const file = makeTelegramFile({ sizeBytes: BigInt(bytes.length) })
    const stream = await streamProviderFileToReadable(file, 'bytes=0-400')
    const out = await readAll(stream)

    expect(out.length).toBe(401)
    expect(out.equals(bytes.subarray(0, 401))).toBe(true)
    expect(download.close).toHaveBeenCalled()
  })

  it('calls download.close() when the consumer destroys the stream early', async () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x11)
    const download = makeDownload(bytes)
    h.openTelegramDocument.mockResolvedValue(download)

    const file = makeTelegramFile({ sizeBytes: BigInt(bytes.length) })
    const stream = await streamProviderFileToReadable(file)

    // Destroy before reading anything — the generator's finally must run close().
    stream.destroy()
    await vi.waitFor(() => expect(download.close).toHaveBeenCalled())
  })

  it('emits an error when the Telegram stream fails mid-download and maps it to an AppError', async () => {
    async function* failing() {
      yield Buffer.from('partial-')
      throw new Error('connection reset')
    }
    const download = {
      remoteId: 'telegram://-100123/42',
      stream: failing(),
      close: vi.fn(async () => undefined),
    }
    h.openTelegramDocument.mockResolvedValue(download)

    const file = makeTelegramFile({ sizeBytes: 100n })
    const stream = await streamProviderFileToReadable(file)

    const seen: unknown[] = []
    stream.on('error', (err) => seen.push(err))
    stream.resume()
    await vi.waitFor(() => expect(seen.length).toBe(1))

    // Mid-stream raw errors are classified into a stable AppError (the
    // generic fallback in classifyTelegramError returns status 502).
    expect(seen[0]).toBeInstanceOf(AppError)
    expect(download.close).toHaveBeenCalled()
  })

  it('rejects with a 404 AppError when the Telegram object is missing', async () => {
    h.openTelegramDocument.mockRejectedValue(
      new AppError('TELEGRAM_FILE_NOT_FOUND', 'The Telegram document could not be found.', 404),
    )

    const file = makeTelegramFile()
    await expect(streamProviderFileToReadable(file)).rejects.toMatchObject({
      code: 'TELEGRAM_FILE_NOT_FOUND',
      status: 404,
    })
  })

  it('rejects with a 401 AppError for a revoked session', async () => {
    h.openTelegramDocument.mockRejectedValue(
      new AppError('TELEGRAM_SESSION_INVALID', 'Telegram session is invalid.', 401),
    )

    const file = makeTelegramFile()
    await expect(streamProviderFileToReadable(file)).rejects.toMatchObject({
      code: 'TELEGRAM_SESSION_INVALID',
      status: 401,
    })
  })

  it('rejects with a 429 AppError for flood waits', async () => {
    h.openTelegramDocument.mockRejectedValue(
      new AppError('TELEGRAM_FLOOD_WAIT', 'Telegram requested a temporary wait. Retry after 30 seconds.', 429),
    )

    const file = makeTelegramFile()
    await expect(streamProviderFileToReadable(file)).rejects.toMatchObject({
      code: 'TELEGRAM_FLOOD_WAIT',
      status: 429,
    })
  })

  it('streams correctly when the range does not start at byte 0', async () => {
    const bytes = Buffer.alloc(4096)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    stubOpenDocument(bytes)

    const file = makeTelegramFile({ sizeBytes: BigInt(bytes.length) })
    const stream = await streamProviderFileToReadable(file, 'bytes=1000-1999')
    const out = await readAll(stream)

    expect(out.length).toBe(1000)
    expect(out.equals(bytes.subarray(1000, 2000))).toBe(true)
    expect(capturedOpts).toEqual({ offset: 1000, limit: 1000 })
  })
})
