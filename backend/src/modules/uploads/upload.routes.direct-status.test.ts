import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'events'
import type { Server } from 'node:http'

/**
 * `/uploads/resumable/status/:id` must describe a direct S3 session from the
 * provider's own part list, not from the local staged temp file it never wrote.
 * Only that branch is exercised here; the routes below it keep their existing
 * resumable semantics (covered by upload.routes.multipart.test.ts).
 */
const h = vi.hoisted(() => ({
  sessionFindFirst: vi.fn(),
  accountFindFirst: vi.fn(),
  directUploadedBytes: vi.fn(),
  env: {
    MAX_UPLOAD_BYTES: 1000, UPLOAD_TEMP_DIR: './tmp', S3_DIRECT_UPLOAD_PART_SIZE_BYTES: 5,
    TELEGRAM_MAX_FILE_BYTES: 1000, CHUNK_UPLOAD_ENABLED: false,
  },
}))

vi.mock('../../config/env.js', () => ({ env: h.env }))
vi.mock('../../config/prisma.js', () => ({
  prisma: {
    uploadSession: { findFirstOrThrow: h.sessionFindFirst, findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    connectedAccount: { findFirstOrThrow: h.accountFindFirst },
  },
}))
vi.mock('../../middleware/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: 'user-1' }
    next()
  },
}))
vi.mock('../google/google.service.js', () => ({ getAuthedGoogleClient: vi.fn(async () => ({})), syncGoogleQuota: vi.fn(async () => undefined) }))
vi.mock('../s3/s3.service.js', () => ({
  buildS3ObjectKey: vi.fn(() => '9drive/object'),
  deleteS3ObjectByKey: vi.fn(),
  getS3ConfigForAccount: vi.fn(),
  syncS3Quota: vi.fn(async () => undefined),
  uploadS3Object: vi.fn(),
}))
vi.mock('../telegram/telegram.service.js', () => ({ deleteTelegramDocuments: vi.fn(), getTelegramConfig: vi.fn(), uploadTelegramDocument: vi.fn() }))
vi.mock('../telegram/telegram-usage.service.js', () => ({ syncTelegramUsage: vi.fn(async () => undefined) }))
vi.mock('../telegram/telegram-caption.service.js', () => ({ uploadTelegramDocumentWithCrypto: vi.fn() }))
vi.mock('../telegram/telegram-metadata-cache.js', () => ({ buildTelegramMetadataCache: vi.fn(() => ({})) }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn() }))
vi.mock('./storage-routing.service.js', () => ({ planBatchUploads: vi.fn() }))
vi.mock('../storage/upload-placement.service.js', () => ({ resolveUploadPlacement: vi.fn() }))
vi.mock('../storage/provider-folder.service.js', () => ({ ensureProviderRoot: vi.fn(), resolveUploadParent: vi.fn() }))
vi.mock('../files/file-logical-path.js', () => ({ logicalPathForFileId: vi.fn() }))
vi.mock('./direct-s3-upload.routes.js', () => ({ directS3UploadRouter: express.Router() }))
vi.mock('./direct-s3-upload.service.js', () => ({ directS3UploadedBytes: h.directUploadedBytes }))
vi.mock('googleapis', () => ({ google: { auth: { GoogleAuth: class {} } } }))

import { uploadRouter } from './upload.routes.js'

let server: Server | undefined

async function status(sessionId: string) {
  const app = express()
  app.use('/uploads', uploadRouter)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  const response = await fetch(`http://127.0.0.1:${address.port}/uploads/resumable/status/${sessionId}`)
  return { status: response.status, body: await response.json() as Record<string, string> }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.directUploadedBytes.mockResolvedValue(0n)
  h.accountFindFirst.mockResolvedValue({ id: 's3-account', provider: 's3', userId: 'user-1' })
})

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())))
  server = undefined
})

const expiresAt = new Date('2030-01-01T00:00:00.000Z')

describe('upload status for direct S3 sessions', () => {
  it('reports live provider progress instead of the local staged offset', async () => {
    h.sessionFindFirst.mockResolvedValueOnce({
      id: 'session-1', userId: 'user-1', sizeBytes: 20n, status: 'direct_s3_uploading',
      targetConnectedAccountId: 's3-account', s3UploadExpiresAt: expiresAt,
    })
    h.directUploadedBytes.mockResolvedValueOnce(12n)

    await expect(status('session-1')).resolves.toEqual({ status: 200, body: { status: 'uploading', offset: '12', expiresAt: expiresAt.toISOString() } })
    expect(h.directUploadedBytes).toHaveBeenCalledWith('user-1', 'session-1')
    expect(h.accountFindFirst).not.toHaveBeenCalled()
  })

  it('reports an aborted direct session as terminal rather than resumable', async () => {
    h.sessionFindFirst.mockResolvedValueOnce({
      id: 'session-1', userId: 'user-1', sizeBytes: 20n, status: 'aborted',
      targetConnectedAccountId: 's3-account', s3UploadExpiresAt: expiresAt,
    })
    h.directUploadedBytes.mockResolvedValueOnce(0n)

    await expect(status('session-1')).resolves.toMatchObject({ status: 200, body: { status: 'failed', offset: '0' } })
  })

  it('keeps legacy resumable statuses on the provider/temp staging path', async () => {
    h.sessionFindFirst.mockResolvedValueOnce({
      id: 'session-1', userId: 'user-1', sizeBytes: 20n, status: 'uploading', targetConnectedAccountId: 's3-account',
    })

    await expect(status('session-1')).resolves.toMatchObject({ status: 200, body: { status: 'uploading' } })
    expect(h.accountFindFirst).toHaveBeenCalled()
  })
})
