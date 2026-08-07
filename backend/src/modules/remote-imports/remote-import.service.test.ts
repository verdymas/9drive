import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import { serializeRemoteImport } from './remote-import.service.js'

// ── Mocks: isolate the service from prisma + queue + audit + temp-storage ─────
// vi.mock factories are hoisted above the imports, so any spy/object they close
// over must come from vi.hoisted (like validationSpy in the integration test).
const h = vi.hoisted(() => {
  const baseRow = {
    id: 'import-1',
    userId: 'user-1',
    folderId: null,
    connectedAccountId: 'acc-1',
    fileName: 'movie.mkv',
    sourceType: 'hls_master',
    sourceUrlEncrypted: 'encrypted',
    status: 'failed',
    stage: 'finished',
    errorCode: 'HLS_REMUX_FAILED',
    errorMessage: 'The HLS media could not be converted.',
    internalError: 'ffmpeg details',
    attempt: 1,
    totalBytes: 1000n,
    downloadedBytes: 1000n,
    uploadedBytes: 0n,
    failedAt: new Date('2026-01-01T00:00:00.000Z'),
    cancelledAt: null,
    completedAt: null,
    startedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    fileId: null,
    hlsVariantId: null,
    hlsAudioTrackId: null,
    hlsOutputContainer: 'auto',
    hlsIsLive: false,
    hlsRecordingDurationSeconds: null,
  }
  const prismaMock = {
    remoteImport: {
      findFirst: vi.fn(),
      update: vi.fn(async ({ data }: { data: any }) => {
        // Resolve `{ increment: 1 }` like real Prisma does (the mock factory's
        // plain spread would leave a literal `{ increment: 1 }` object).
        if (typeof data?.attempt?.increment === 'number') {
          data = { ...data, attempt: (baseRow.attempt ?? 0) + data.attempt.increment }
        }
        return { ...baseRow, ...data }
      }),
    },
  }
  return {
    baseRow,
    prismaMock,
    enqueueSpy: vi.fn(),
    auditSpy: vi.fn(),
    removeJobDirSpy: vi.fn(async () => undefined),
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

vi.mock('./queue.js', () => ({
  enqueueRemoteImport: (...args: unknown[]) => h.enqueueSpy(...args),
  removeRemoteImportJob: vi.fn(async () => undefined),
}))

vi.mock('../../utils/audit.js', () => ({ createAuditLog: (...args: unknown[]) => h.auditSpy(...args) }))

// removeJobDirIfExists uses `await import(...)` — a no-op mock here.
vi.mock('./hls/job-dir.js', () => ({
  hlsJobDir: vi.fn(() => '/tmp/jobs/u/i'),
  removeJobDir: (...args: unknown[]) => h.removeJobDirSpy(...args),
}))

vi.mock('../../utils/crypto.js', () => ({
  encryptText: (s: string) => s,
  decryptText: (s: string) => s,
}))

vi.mock('./temp-storage.js', () => ({
  removeTempFile: vi.fn(async () => undefined),
}))

// Import AFTER the mocks are registered (vi.mock is hoisted; imports re-order).
import { retryRemoteConvert, retryRemoteImport } from './remote-import.service.js'

/** Install `findFirst`/`update` mocks for one call with the given row shape. */
async function withRow(overrides: Record<string, unknown> = {}) {
  const current = { ...h.baseRow, ...overrides }
  ;(h.prismaMock.remoteImport.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(current)
  ;(h.prismaMock.remoteImport.update as ReturnType<typeof vi.fn>).mockImplementationOnce(async ({ data }: { data: any }) => {
    // Resolve `{ increment: 1 }` like real Prisma (the plain spread would leave
    // a literal `{ increment: 1 }` object in the returned row).
    if (typeof data?.attempt?.increment === 'number') {
      data = { ...data, attempt: (current.attempt ?? 0) + data.attempt.increment }
    }
    return { ...current, ...data }
  })
  return current
}

describe('serializeRemoteImport', () => {
  it('coerces every BigInt byte field to a string', () => {
    const row = {
      id: 'import-1',
      fileName: 'movie.mkv',
      totalBytes: 12345678901234567890n,
      downloadedBytes: 2048n,
      uploadedBytes: 2048n,
    }
    expect(serializeRemoteImport(row)).toMatchObject({
      totalBytes: '12345678901234567890',
      downloadedBytes: '2048',
      uploadedBytes: '2048',
    })
    expect(typeof serializeRemoteImport(row).totalBytes).toBe('string')
  })

  it('serializes a null totalBytes as null', () => {
    const serialized = serializeRemoteImport({ id: 'import-2', totalBytes: null, downloadedBytes: 0n, uploadedBytes: 0n })
    expect(serialized.totalBytes).toBeNull()
  })

  it('defines a JSON-safe payload with a nested file relation (regression: sizeBytes BigInt)', () => {
    const row = {
      id: 'import-3',
      totalBytes: null,
      downloadedBytes: 100n,
      uploadedBytes: 100n,
      file: { id: 'file-1', name: 'movie.mkv', sizeBytes: 100n },
    }
    const serialized = serializeRemoteImport(row)
    expect(serialized.file?.sizeBytes).toBe('100')
    expect(() => JSON.stringify(serialized)).not.toThrow()
    expect(JSON.parse(JSON.stringify(serialized)).file.sizeBytes).toBe('100')
  })

  it('passes HLS fields through unchanged and stays JSON-safe', () => {
    const row = {
      id: 'import-4',
      totalBytes: null,
      downloadedBytes: 0n,
      uploadedBytes: 0n,
      sourceType: 'hls_media',
      hlsPlaylistType: 'vod',
      hlsVariantId: null,
      hlsVariantBandwidth: null,
      hlsVariantWidth: null,
      hlsVariantHeight: null,
      hlsAudioTrackId: null,
      hlsAudioTrackLanguage: 'en',
      hlsOutputContainer: 'mkv',
      hlsIsLive: false,
      hlsRecordingDurationSeconds: null,
      hlsMediaDurationSeconds: 1234.5,
      hlsSegmentCount: 42,
      hlsCompletedSegmentCount: 42,
      remuxProgress: 0.55,
      outputDurationSeconds: 1234.5,
      outputCodecSummary: 'h264, aac',
    }
    const serialized = serializeRemoteImport(row)
    expect(serialized.sourceType).toBe('hls_media')
    expect(serialized.hlsPlaylistType).toBe('vod')
    expect(serialized.hlsMediaDurationSeconds).toBe(1234.5)
    expect(serialized.hlsSegmentCount).toBe(42)
    expect(serialized.hlsCompletedSegmentCount).toBe(42)
    expect(serialized.remuxProgress).toBe(0.55)
    expect(serialized.hlsOutputContainer).toBe('mkv')
    expect(serialized.hlsIsLive).toBe(false)
    expect(() => JSON.stringify(serialized)).not.toThrow()
  })
})

describe('retryRemoteConvert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts a failed HLS import with HLS_REMUX_FAILED', async () => {
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    const result = await retryRemoteConvert('import-1', 'user-1')
    expect(result.status).toBe('queued')
    expect(result.attempt).toBe(2)
    expect(result.errorCode).toBeNull()
    expect(result.errorMessage).toBeNull()
    expect(result.internalError).toBeNull()
    expect(result.failedAt).toBeNull()
  })

  it('accepts a failed HLS import with HLS_OUTPUT_INVALID', async () => {
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_OUTPUT_INVALID' })
    const result = await retryRemoteConvert('import-1', 'user-1')
    expect(result.status).toBe('queued')
    expect(result.errorCode).toBeNull()
  })

  it('rejects a non-failed import', async () => {
    await withRow({ status: 'processing', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    await expect(retryRemoteConvert('import-1', 'user-1')).rejects.toBeInstanceOf(AppError)
  })

  it('rejects a failed non-HLS import', async () => {
    await withRow({ status: 'failed', sourceType: 'direct', errorCode: 'HLS_REMUX_FAILED' })
    await expect(retryRemoteConvert('import-1', 'user-1')).rejects.toBeInstanceOf(AppError)
  })

  it('rejects a failed HLS import with a non-retryable error code', async () => {
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_INVALID_MANIFEST' })
    await expect(retryRemoteConvert('import-1', 'user-1')).rejects.toBeInstanceOf(AppError)
  })

  it('re-enqueues but never removes the job dir (segments are reused)', async () => {
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    await retryRemoteConvert('import-1', 'user-1')
    expect(h.enqueueSpy).toHaveBeenCalledWith('import-1')
    expect(h.removeJobDirSpy).not.toHaveBeenCalled()
    // Contrast: the generic retry DOES wipe the dir for a full re-run.
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    await retryRemoteImport('import-1', 'user-1')
    expect(h.removeJobDirSpy).toHaveBeenCalledTimes(1)
  })
})