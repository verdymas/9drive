import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import { createRemoteImport, serializeRemoteImport } from './remote-import.service.js'

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
    uploadTotalBytes: null,
    queuedAt: null,
    retryRequestedAt: null,
    heartbeatAt: null,
    retryFromStage: null,
    jobId: null,
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
      create: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  }
  return {
    baseRow,
    prismaMock,
    enqueueSpy: vi.fn(),
    auditSpy: vi.fn(),
    removeJobDirSpy: vi.fn(async () => undefined),
    readResumeMarkerSpy: vi.fn(),
    accessImpl: {
      /** True → `fsp.access` resolves (file exists). False → rejects (ENOENT). */
      exists: vi.fn(async () => false),
    },
    /** The row most recently installed by `withRow` (used by the CAS re-read stub). */
    currentRow: baseRow,
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

vi.mock('./queue.js', () => ({
  enqueueRemoteImport: (...args: unknown[]) => h.enqueueSpy(...args),
  removeRemoteImportJob: vi.fn(async () => undefined),
  remoteImportJobId: (importId: string, attempt: number) => `${importId}:${attempt}`,
}))

vi.mock('../../utils/audit.js', () => ({ createAuditLog: (...args: unknown[]) => h.auditSpy(...args) }))

// removeJobDirIfExists uses `await import(...)` — a no-op mock here.
vi.mock('./hls/job-dir.js', () => ({
  hlsJobDir: vi.fn(() => '/tmp/jobs/u/i'),
  removeJobDir: (...args: unknown[]) => h.removeJobDirSpy(...args),
  readResumeMarker: (...args: unknown[]) => h.readResumeMarkerSpy(...args),
}))

vi.mock('../../utils/crypto.js', () => ({
  encryptText: (s: string) => s,
  decryptText: (s: string) => s,
}))

// Never hit real DNS from a unit test: `validateRemoteUrl` is a network call
// the service's create path performs for every URL.
vi.mock('./ssrf.js', () => ({
  validateRemoteUrl: async (rawUrl: string) => new URL(rawUrl),
}))

vi.mock('./temp-storage.js', () => ({
  removeTempFile: vi.fn(async () => undefined),
  tempFilePath: (importId: string) => `/tmp/${importId}.part`,
}))

// Reconcile-on-read is a no-op for the retry tests (never exercised: the mocked
// rows are `failed`). Mock the module so its import in the service resolves.
vi.mock('./queue-reconcile.js', () => ({
  reconcileQueuedRow: vi.fn(async () => 'kept'),
}))

// `determineRetryStage` probes the filesystem for artifacts (temp part, HLS
// output) via `fsp.access`, which REJECTS with ENOENT when missing. The hook
// returns `true` (exists: resolve) or `false` (missing: reject like Prisma).
vi.mock('node:fs/promises', () => ({
  default: {
    access: async () => {
      if (await h.accessImpl.exists()) return undefined
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  },
}))

// Import AFTER the mocks are registered (vi.mock is hoisted; imports re-order).
import { retryRemoteConvert, retryRemoteImport } from './remote-import.service.js'

/** Reset each mock/function then re-apply the defaults. `vi.clearAllMocks`
 *  would be wrong here: queued `*Once` values from a finished test survive a
 *  clear and replay into the next test. */
function resetMocks() {
  vi.resetAllMocks()
  ;(h.enqueueSpy as ReturnType<typeof vi.fn>).mockResolvedValue('import-1:2')
  ;(h.prismaMock.remoteImport.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 })
  ;(h.prismaMock.remoteImport.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => ({ ...h.baseRow, ...data }))
  ;(h.prismaMock.remoteImport.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => ({ ...h.baseRow, ...data }))
  // findUniqueOrThrow: the post-CAS re-read of `enqueueRetry` returns the
  // current row with the stored queued-state payload applied on top.
  ;(h.prismaMock.remoteImport.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    const stored = (h.prismaMock.remoteImport.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.data ?? {}
    return { ...h.currentRow, ...stored, connectedAccount: null }
  })
  // Default label state: no output/temp artifact exists on disk.
  ;(h.accessImpl.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
  ;(h.readResumeMarkerSpy as ReturnType<typeof vi.fn>).mockResolvedValue(null)
}

/** Install `findFirst` for one call with the given row shape. */
async function withRow(overrides: Record<string, unknown> = {}) {
  const current = { ...h.baseRow, ...overrides }
  h.currentRow = current
  ;(h.prismaMock.remoteImport.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ...current,
    connectedAccount: null,
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
    resetMocks()
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
    expect(result.retryFromStage).toBe('segments')
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
    expect(h.enqueueSpy).toHaveBeenCalledWith('import-1', 2)
    expect(h.removeJobDirSpy).not.toHaveBeenCalled()
    // Contrast: the generic retry DOES wipe the dir for a full re-run.
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    await retryRemoteImport('import-1', 'user-1')
    expect(h.removeJobDirSpy).toHaveBeenCalledTimes(1)
  })

  it('enqueues BEFORE persisting the queued state (queue-first order)', async () => {
    const calls: string[] = []
    const enqueueOrder: string[] = []
    const enqueue = h.enqueueSpy as ReturnType<typeof vi.fn>
    enqueue.mockImplementation(async () => {
      enqueueOrder.push('enqueue')
      return 'import-1:2'
    })
    const updateMany = h.prismaMock.remoteImport.updateMany as ReturnType<typeof vi.fn>
    updateMany.mockImplementation(async (args: any) => {
      calls.push('updateMany')
      expect(args.where).toEqual({ id: 'import-1', status: { in: ['failed', 'cancelled'] } })
      enqueueOrder.push('updateMany')
      return { count: 1 }
    })
    // Re-read resolves with the stored state.
    ;(h.prismaMock.remoteImport.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      enqueueOrder.push('findUniqueOrThrow')
      // Reuse the previous implementation after first call.
      return { ...h.baseRow, status: 'queued', attempt: 2, connectedAccount: null }
    })
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    await retryRemoteConvert('import-1', 'user-1')
    // Enqueue must happen BEFORE the DB is flipped to queued.
    expect(enqueueOrder).toEqual(['enqueue', 'updateMany', 'findUniqueOrThrow'])
    expect(calls).toEqual(['updateMany'])
  })

  it('fails the row with the enqueue error when queue.add() throws (never queued)', async () => {
    ;(h.enqueueSpy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis down'))
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    await expect(retryRemoteConvert('import-1', 'user-1')).rejects.toMatchObject({ code: 'REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED' })
    const update = h.prismaMock.remoteImport.update as ReturnType<typeof vi.fn>
    // The restore write must mark the row failed with the enqueue error and
    // MUST NOT set status queued.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'import-1' },
        data: expect.objectContaining({ status: 'failed', errorCode: 'REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED' }),
      }),
    )
    // No CAS transition to queued was attempted, and no job-dir wipe happened.
    expect(h.prismaMock.remoteImport.updateMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(h.removeJobDirSpy).not.toHaveBeenCalled()
  })

  it('reports 409 when the CAS loses the race (duplicate concurrent retry)', async () => {
    ;(h.prismaMock.remoteImport.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 })
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    await expect(retryRemoteConvert('import-1', 'user-1')).rejects.toMatchObject({ code: 'REMOTE_IMPORT_ALREADY_ACTIVE' })
    // The queue job was already enqueued by the loser's caller — the winner
    // owns it; no cleanup is attempted here.
    expect(h.enqueueSpy).toHaveBeenCalledWith('import-1', 2)
    expect(h.auditSpy).not.toHaveBeenCalled()
  })

  it('rejects with 409 when the import is already queued or processing', async () => {
    const tooOld = new Date('2025-01-01T00:00:00.000Z')
    await withRow({ status: 'queued', stage: 'waiting', queuedAt: tooOld })
    await expect(retryRemoteConvert('import-1', 'user-1')).rejects.toMatchObject({ code: 'REMOTE_IMPORT_ALREADY_ACTIVE' })
    expect(h.enqueueSpy).not.toHaveBeenCalled()
    await withRow({ status: 'processing', stage: 'downloading' })
    await expect(retryRemoteConvert('import-1', 'user-1')).rejects.toMatchObject({ code: 'REMOTE_IMPORT_ALREADY_ACTIVE' })
  })

  it('keeps the user-entered filename across a retry (canonical name preserved)', async () => {
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED', fileName: 'Remote Import Test Movie.mkv' })
    const result = await retryRemoteConvert('import-1', 'user-1')
    expect(result.fileName).toBe('Remote Import Test Movie.mkv')
  })

  it('resumes at remuxing when the job dir holds a resume marker', async () => {
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    ;(h.accessImpl.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    ;(h.readResumeMarkerSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 1,
      mode: 'remux-only',
      playlistUrl: 'https://cdn.example/video.m3u8',
      audioPlaylistUrl: null,
      container: 'mkv',
      expectAudio: true,
      mediaDurationSeconds: 600,
    })
    const result = await retryRemoteConvert('import-1', 'user-1')
    expect(result.retryFromStage).toBe('remuxing')
  })

  it('resumes at uploading when the output file already exists on disk', async () => {
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' })
    ;(h.accessImpl.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    const result = await retryRemoteImport('import-1', 'user-1')
    expect(result.retryFromStage).toBe('uploading')
  })

  it('resumes at downloading for a direct import with no temp file', async () => {
    await withRow({ status: 'failed', sourceType: 'direct', errorCode: 'DOWNLOAD_FAILED', fileName: 'direct.bin' })
    ;(h.accessImpl.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    // tempFilePath.access fails (file gone) → re-download.
    const result = await retryRemoteImport('import-1', 'user-1')
    expect(result.retryFromStage).toBe('downloading')
  })

  it('resumes at registering when the provider file was already uploaded', async () => {
    await withRow({ status: 'failed', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED', fileId: 'file-9' })
    const result = await retryRemoteConvert('import-1', 'user-1')
    expect(result.retryFromStage).toBe('registering')
  })
})

describe('createRemoteImport', () => {
  beforeEach(() => {
    resetMocks()
    ;(h.prismaMock.remoteImport.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: { data: any }) => ({ ...h.baseRow, ...data }))
  })

  it('persists the user-entered filename as-is (canonical) and strips m3u8', async () => {
    const created = await createRemoteImport({
      userId: 'user-1',
      sourceUrl: 'https://cdn.example/playlist.m3u8',
      fileName: 'My Movie.mkv',
      hls: { sourceType: 'hls_media' },
    })
    expect(created.fileName).toBe('My Movie.mkv')
    expect(h.enqueueSpy).toHaveBeenCalledWith(created.id, 1)
  })

  it('rejects an explicit filename extension contradicting the container', async () => {
    await expect(
      createRemoteImport({
        userId: 'user-1',
        sourceUrl: 'https://cdn.example/playlist.m3u8',
        fileName: 'Movie.mp4',
        hls: { sourceType: 'hls_media', outputContainer: 'mkv' },
      }),
    ).rejects.toMatchObject({ code: 'FILE_NAME_EXTENSION_MISMATCH' })
    expect(h.enqueueSpy).not.toHaveBeenCalled()
  })

  it('appends the output container extension when none is given', async () => {
    const created = await createRemoteImport({
      userId: 'user-1',
      sourceUrl: 'https://cdn.example/video.m3u8',
      fileName: 'Untitled',
      hls: { sourceType: 'hls_media', outputContainer: 'mp4' },
    })
    expect(created.fileName).toBe('Untitled.mp4')
  })

  it('falls back to the detected filename when the user entered none', async () => {
    const created = await createRemoteImport({
      userId: 'user-1',
      sourceUrl: 'https://cdn.example/other.mp4?x=1',
      detectedFileName: 'Detected Name.mp4',
    })
    expect(created.fileName).toBe('Detected Name.mp4')
  })

  it('does not leave the row queued when enqueuing fails', async () => {
    ;(h.enqueueSpy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis down'))
    await expect(
      createRemoteImport({
        userId: 'user-1',
        sourceUrl: 'https://cdn.example/file.mp4',
        fileName: 'File.mp4',
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED' })
    expect(h.prismaMock.remoteImport.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'queued' }) }),
    )
    const updates = h.prismaMock.remoteImport.update as ReturnType<typeof vi.fn>
    expect(updates).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', errorCode: 'REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED' }),
      }),
    )
  })
})