import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  env: { S3_DIRECT_UPLOAD_ENABLED: false, S3_DIRECT_UPLOAD_PART_SIZE_BYTES: 5, S3_DIRECT_UPLOAD_SESSION_TTL_SECONDS: 900, S3_DIRECT_UPLOAD_PART_URL_TTL_SECONDS: 300 },
  placement: vi.fn(),
  getConfig: vi.fn(),
  buildKey: vi.fn(),
  createMultipart: vi.fn(),
  signPart: vi.fn(),
  completeMultipart: vi.fn(),
  abortMultipart: vi.fn(),
  deleteObject: vi.fn(),
  headObject: vi.fn(),
  listParts: vi.fn(),
  syncQuota: vi.fn(),
  sessionCreate: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionFindMany: vi.fn(),
  fileCreate: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    uploadSession: {
      create: h.sessionCreate,
      findFirst: h.sessionFindFirst,
      update: h.sessionUpdate,
      findMany: h.sessionFindMany,
    },
    file: { create: h.fileCreate },
  },
}))
vi.mock('../storage/upload-placement.service.js', () => ({ resolveUploadPlacement: h.placement }))
vi.mock('../s3/s3.service.js', () => ({
  getS3ConfigForAccount: h.getConfig,
  buildS3ObjectKey: h.buildKey,
  createS3MultipartUpload: h.createMultipart,
  getS3PresignedUploadPartUrl: h.signPart,
  completeS3MultipartUpload: h.completeMultipart,
  abortS3MultipartUpload: h.abortMultipart,
  deleteS3ObjectByKey: h.deleteObject,
  headS3Object: h.headObject,
  listS3MultipartParts: h.listParts,
  syncS3Quota: h.syncQuota,
}))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: h.audit }))
vi.mock('../../config/env.js', () => ({ env: h.env }))

import {
  abortDirectS3Upload,
  completeDirectS3Upload,
  directS3UploadedBytes,
  initDirectS3Upload,
  signDirectS3UploadPart,
  startDirectS3UploadSweeper,
  sweepExpiredDirectS3Uploads,
} from './direct-s3-upload.service.js'

const config = { id: 'config-1', bucket: 'bucket', prefix: '9drive' }
const account = { id: 's3-account', provider: 's3', email: 'bucket@example.test' }

beforeEach(() => {
  vi.clearAllMocks()
  h.placement.mockResolvedValue({ connectedAccount: account, folderStorageLocation: { providerFolderId: 'root' } })
  h.getConfig.mockResolvedValue(config)
  h.buildKey.mockReturnValue('9drive/user-1/session-1/report.txt')
  h.sessionCreate.mockResolvedValue({ id: 'session-1' })
  h.createMultipart.mockResolvedValue('multipart-1')
  h.deleteObject.mockResolvedValue(undefined)
  h.syncQuota.mockResolvedValue(undefined)
  h.listParts.mockResolvedValue([])
})

describe('initDirectS3Upload', () => {
  it('creates a server-owned S3 multipart session only when placement resolves to S3', async () => {
    await expect(initDirectS3Upload('user-1', {
      fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: 10n, folderId: null, targetAccountId: null,
    }, { enabled: true, expiresInSeconds: 900, partSizeBytes: 5 })).resolves.toMatchObject({
      mode: 'direct-s3', sessionId: 'session-1', partSizeBytes: 5, targetAccountId: 's3-account',
    })

    expect(h.placement).toHaveBeenCalledWith('user-1', null, null, 10n, expect.any(Map), 'resumable')
    expect(h.sessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', targetConnectedAccountId: 's3-account', status: 'direct_s3_uploading' }),
    }))
    expect(h.buildKey).toHaveBeenCalledWith(config, 'user-1', 'session-1', 'report.txt', undefined)
    expect(h.createMultipart).toHaveBeenCalledWith(config, '9drive/user-1/session-1/report.txt', 'text/plain')
  })

  it('advertises the server fallback when direct upload is disabled or placement is not S3', async () => {
    await expect(initDirectS3Upload('user-1', {
      fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: 10n, folderId: null, targetAccountId: null,
    }, { enabled: false, expiresInSeconds: 900, partSizeBytes: 5 })).resolves.toEqual({ mode: 'server' })
    expect(h.placement).not.toHaveBeenCalled()

    h.placement.mockResolvedValueOnce({ connectedAccount: { ...account, provider: 'google_drive' }, folderStorageLocation: { providerFolderId: 'root' } })
    await expect(initDirectS3Upload('user-1', {
      fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: 10n, folderId: null, targetAccountId: null,
    }, { enabled: true, expiresInSeconds: 900, partSizeBytes: 5 })).resolves.toEqual({ mode: 'server' })
  })
})

describe('direct S3 multipart session controls', () => {
  const session = {
    id: 'session-1', userId: 'user-1', targetConnectedAccountId: 's3-account', folderId: null,
    fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: 10n, status: 'direct_s3_uploading',
    s3MultipartUploadId: 'multipart-1', s3ObjectKey: '9drive/user-1/session-1/report.txt',
    s3UploadExpiresAt: new Date(Date.now() + 60_000),
  }

  it('signs only an owned, in-bounds part URL with a short expiry', async () => {
    h.sessionFindFirst.mockResolvedValueOnce(session)
    h.signPart.mockResolvedValueOnce('https://s3.example.test/part?short-lived')

    await expect(signDirectS3UploadPart('user-1', 'session-1', 2, { partSizeBytes: 5, partUrlExpiresInSeconds: 300 })).resolves.toEqual({
      partNumber: 2, url: 'https://s3.example.test/part?short-lived', expiresInSeconds: 300,
    })
    expect(h.signPart).toHaveBeenCalledWith(config, session.s3ObjectKey, session.s3MultipartUploadId, 2, 300)
  })

  it('rejects a foreign, expired, or out-of-bounds part before signing', async () => {
    h.sessionFindFirst.mockResolvedValueOnce(null)
    await expect(signDirectS3UploadPart('other-user', 'session-1', 1, { partSizeBytes: 5, partUrlExpiresInSeconds: 300 })).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_NOT_FOUND' })
    expect(h.signPart).not.toHaveBeenCalled()

    h.sessionFindFirst.mockResolvedValueOnce({ ...session, s3UploadExpiresAt: new Date(Date.now() - 1) })
    await expect(signDirectS3UploadPart('user-1', 'session-1', 1, { partSizeBytes: 5, partUrlExpiresInSeconds: 300 })).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_EXPIRED' })

    h.sessionFindFirst.mockResolvedValueOnce(session)
    await expect(signDirectS3UploadPart('user-1', 'session-1', 3, { partSizeBytes: 5, partUrlExpiresInSeconds: 300 })).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_INVALID_PART' })
  })

  it('completes verified expected parts and creates an active File only after S3 confirms size', async () => {
    h.sessionFindFirst.mockResolvedValueOnce(session)
    h.headObject.mockResolvedValueOnce({ contentLength: 10n })
    h.fileCreate.mockResolvedValueOnce({ id: 'file-1', sizeBytes: 10n, status: 'active' })

    await expect(completeDirectS3Upload('user-1', 'session-1', [
      { partNumber: 1, etag: 'etag-1', sizeBytes: 5 }, { partNumber: 2, etag: 'etag-2', sizeBytes: 5 },
    ], { partSizeBytes: 5 })).resolves.toMatchObject({ status: 'completed', file: { id: 'file-1', status: 'active' } })
    expect(h.completeMultipart).toHaveBeenCalledWith(config, session.s3ObjectKey, 'multipart-1', [
      { PartNumber: 1, ETag: 'etag-1' }, { PartNumber: 2, ETag: 'etag-2' },
    ])
    expect(h.fileCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ provider: 's3', providerFileId: session.s3ObjectKey, status: 'active' }) }))
  })

  it('rejects parts whose declared sizes do not match the session before contacting the provider', async () => {
    h.sessionFindFirst.mockResolvedValueOnce(session).mockResolvedValueOnce(session)

    await expect(completeDirectS3Upload('user-1', 'session-1', [
      { partNumber: 1, etag: 'etag-1', sizeBytes: 3 }, { partNumber: 2, etag: 'etag-2', sizeBytes: 5 },
    ], { partSizeBytes: 5 })).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_INVALID_PARTS' })
    expect(h.completeMultipart).not.toHaveBeenCalled()
    expect(h.fileCreate).not.toHaveBeenCalled()

    await expect(completeDirectS3Upload('user-1', 'session-1', [
      { partNumber: 1, etag: 'etag-1', sizeBytes: 5 }, { partNumber: 2, etag: 'etag-2', sizeBytes: 5 }, { partNumber: 3, etag: 'etag-3', sizeBytes: 5 },
    ], { partSizeBytes: 5 })).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_INVALID_PARTS' })
    expect(h.completeMultipart).not.toHaveBeenCalled()
  })

  it('rejects a short non-final part even when the declared total matches', async () => {
    h.sessionFindFirst.mockResolvedValueOnce({ ...session, sizeBytes: 12n })

    await expect(completeDirectS3Upload('user-1', 'session-1', [
      { partNumber: 1, etag: 'etag-1', sizeBytes: 5 }, { partNumber: 2, etag: 'etag-2', sizeBytes: 2 }, { partNumber: 3, etag: 'etag-3', sizeBytes: 5 },
    ], { partSizeBytes: 5 })).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_INVALID_PARTS' })
    expect(h.completeMultipart).not.toHaveBeenCalled()
  })

  it('records the verified provider-side size on completion', async () => {
    h.sessionFindFirst.mockResolvedValueOnce({ ...session, sizeBytes: 12n })
    h.headObject.mockResolvedValueOnce({ contentLength: 12n })
    h.fileCreate.mockResolvedValueOnce({ id: 'file-1', sizeBytes: 12n, status: 'active' })

    await expect(completeDirectS3Upload('user-1', 'session-1', [
      { partNumber: 1, etag: 'etag-1', sizeBytes: 5 }, { partNumber: 2, etag: 'etag-2', sizeBytes: 5 }, { partNumber: 3, etag: 'etag-3', sizeBytes: 2 },
    ], { partSizeBytes: 5 })).resolves.toMatchObject({ status: 'completed' })
    expect(h.sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed', s3CompletedParts: expect.any(Array) }),
    }))
  })

  it('deletes a completed object with an unexpected size before it can become active', async () => {
    h.sessionFindFirst.mockResolvedValueOnce(session)
    h.headObject.mockResolvedValueOnce({ contentLength: 9n })

    await expect(completeDirectS3Upload('user-1', 'session-1', [
      { partNumber: 1, etag: 'etag-1', sizeBytes: 5 }, { partNumber: 2, etag: 'etag-2', sizeBytes: 5 },
    ], { partSizeBytes: 5 })).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_SIZE_MISMATCH' })

    expect(h.deleteObject).toHaveBeenCalledWith(config, session.s3ObjectKey)
    expect(h.fileCreate).not.toHaveBeenCalled()
  })

  it('aborts owned incomplete work and sweeps expired sessions without creating files', async () => {
    h.sessionFindFirst.mockResolvedValueOnce(session)
    await expect(abortDirectS3Upload('user-1', 'session-1')).resolves.toEqual({ status: 'aborted' })
    expect(h.abortMultipart).toHaveBeenCalledWith(config, session.s3ObjectKey, session.s3MultipartUploadId)
    expect(h.fileCreate).not.toHaveBeenCalled()

    h.sessionFindMany.mockResolvedValueOnce([{ ...session, s3UploadExpiresAt: new Date(Date.now() - 1) }])
    await expect(sweepExpiredDirectS3Uploads(new Date())).resolves.toEqual({ swept: 1 })
    expect(h.sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }))
  })
})

describe('direct S3 session observability', () => {
  const base = {
    id: 'session-1', userId: 'user-1', targetConnectedAccountId: 's3-account',
    s3MultipartUploadId: 'multipart-1', s3ObjectKey: '9drive/user-1/session-1/report.txt',
    sizeBytes: 20n,
  }

  it('asks the provider for the part bytes it actually holds', async () => {
    h.sessionFindFirst.mockResolvedValueOnce({ ...base, status: 'direct_s3_uploading' })
    h.listParts.mockResolvedValueOnce([{ partNumber: 1, size: 8n }, { partNumber: 2, size: 4n }])
    await expect(directS3UploadedBytes('user-1', 'session-1')).resolves.toBe(12n)
  })

  it('reports terminal states without consulting the provider', async () => {
    h.sessionFindFirst.mockResolvedValueOnce({ ...base, status: 'completed' })
    await expect(directS3UploadedBytes('user-1', 'session-1')).resolves.toBe(20n)
    h.sessionFindFirst.mockResolvedValueOnce({ ...base, status: 'aborted' })
    await expect(directS3UploadedBytes('user-1', 'session-1')).resolves.toBe(0n)
    expect(h.listParts).not.toHaveBeenCalled()
  })

  it('degrades to null instead of guessing when the provider cannot be read', async () => {
    h.sessionFindFirst.mockResolvedValueOnce({ ...base, status: 'direct_s3_uploading' })
    h.listParts.mockRejectedValueOnce(new Error('provider unreachable'))
    await expect(directS3UploadedBytes('user-1', 'session-1')).resolves.toBeNull()
  })

  it('only schedules the sweeper while direct uploads are enabled', () => {
    h.env.S3_DIRECT_UPLOAD_ENABLED = false
    expect(startDirectS3UploadSweeper()).toBeUndefined()

    h.env.S3_DIRECT_UPLOAD_ENABLED = true
    const timer = startDirectS3UploadSweeper(60_000)
    expect(timer).toBeDefined()
    timer?.close()
  })
})
