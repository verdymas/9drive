import { PassThrough, Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const send = vi.fn()
  const getSignedUrl = vi.fn()
  let lastClientOptions: unknown
  class S3Client {
    constructor(options: unknown) {
      lastClientOptions = options
    }
    send = send
  }
  class GetObjectCommand {
    constructor(readonly input: unknown) {}
  }
  class CreateMultipartUploadCommand {
    constructor(readonly input: unknown) {}
  }
  class UploadPartCommand {
    constructor(readonly input: unknown) {}
  }
  class CompleteMultipartUploadCommand {
    constructor(readonly input: unknown) {}
  }
  class AbortMultipartUploadCommand {
    constructor(readonly input: unknown) {}
  }
  class HeadObjectCommand {
    constructor(readonly input: unknown) {}
  }
  return {
    send, getSignedUrl, S3Client, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand,
    CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand,
    getLastClientOptions: () => lastClientOptions,
  }
})

vi.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: class {},
  GetObjectCommand: h.GetObjectCommand,
  CreateMultipartUploadCommand: h.CreateMultipartUploadCommand,
  UploadPartCommand: h.UploadPartCommand,
  CompleteMultipartUploadCommand: h.CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand: h.AbortMultipartUploadCommand,
  HeadObjectCommand: h.HeadObjectCommand,
  HeadBucketCommand: class {},
  ListObjectsV2Command: class {},
  S3Client: h.S3Client,
}))
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: class {} }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: h.getSignedUrl }))
vi.mock('../../config/prisma.js', () => ({
  prisma: {
    s3StorageConfig: {
      findFirstOrThrow: vi.fn(async () => ({
        bucket: 'bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', forcePathStyle: true,
        accessKeyIdEncrypted: 'key', secretAccessKeyEncrypted: 'secret',
      })),
    },
  },
}))
vi.mock('../../utils/crypto.js', () => ({ decryptText: (value: string) => value }))

import {
  abortS3MultipartUpload,
  completeS3MultipartUpload,
  createS3MultipartUpload,
  getS3DownloadDecision,
  getS3PresignedUploadPartUrl,
  headS3Object,
  streamS3File,
} from './s3.service.js'

beforeEach(() => {
  vi.clearAllMocks()
})

class FakeResponse extends PassThrough {
  statusCode = 200
  readonly headers = new Map<string, string>()

  status(code: number) {
    this.statusCode = code
    return this
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
  }
}

describe('streamS3File', () => {
  it('forwards the range and downstream abort signal when opening the S3 stream', async () => {
    h.send.mockResolvedValueOnce({
      Body: Readable.from(['data']),
      ContentRange: 'bytes 0-3/4',
      ContentLength: 4,
      ContentType: 'text/plain',
    })
    const response = new FakeResponse()
    const abort = new AbortController()

    await streamS3File({
      connectedAccountId: 'account-1',
      providerFileId: '9drive/file',
      mimeType: 'text/plain',
      name: 'file.txt',
    } as never, 'bytes=0-3', response as never, { disposition: 'attachment' }, abort.signal)

    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Bucket: 'bucket', Key: '9drive/file', Range: 'bytes=0-3' } }),
      { abortSignal: abort.signal },
    )
    expect(response.statusCode).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-3/4')
  })
})

describe('getS3DownloadDecision', () => {
  const s3File = {
    provider: 's3',
    connectedAccountId: 'account-1',
    providerFileId: '9drive/file',
    mimeType: 'text/plain',
    name: 'file.txt',
  } as never

  it('returns an object-scoped attachment URL for an enabled ordinary S3 download', async () => {
    h.getSignedUrl.mockResolvedValueOnce('https://s3.example.test/bucket/9drive/file?X-Amz-Signature=short-lived')

    await expect(getS3DownloadDecision(s3File, {
      enabled: true,
      ttlSeconds: 300,
      range: undefined,
      disposition: 'attachment',
    })).resolves.toEqual({ kind: 'redirect', url: expect.stringContaining('X-Amz-Signature') })

    expect(h.getSignedUrl).toHaveBeenCalledWith(
      expect.any(h.S3Client),
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'bucket',
          Key: '9drive/file',
          ResponseContentDisposition: 'attachment; filename="file.txt"',
        }),
      }),
      { expiresIn: 300 },
    )
    expect(h.getLastClientOptions()).toEqual(expect.objectContaining({
      endpoint: 'https://s3.example.test',
      forcePathStyle: true,
    }))
  })

  it('keeps disabled, ranged, and non-S3 requests on the proxy path without signing', async () => {
    await expect(getS3DownloadDecision(s3File, { enabled: false, ttlSeconds: 300, range: undefined, disposition: 'attachment' })).resolves.toEqual({ kind: 'proxy' })
    await expect(getS3DownloadDecision(s3File, { enabled: true, ttlSeconds: 300, range: 'bytes=0-3', disposition: 'attachment' })).resolves.toEqual({ kind: 'proxy' })
    await expect(getS3DownloadDecision({ ...s3File, provider: 'google_drive' }, { enabled: true, ttlSeconds: 300, range: undefined, disposition: 'attachment' })).resolves.toEqual({ kind: 'proxy' })
    expect(h.getSignedUrl).not.toHaveBeenCalled()
  })

  it('falls back to the proxy when S3 URL signing fails', async () => {
    h.getSignedUrl.mockRejectedValueOnce(new Error('signer unavailable'))

    await expect(getS3DownloadDecision(s3File, { enabled: true, ttlSeconds: 300, range: undefined, disposition: 'attachment' })).resolves.toEqual({ kind: 'proxy' })
  })
})

describe('direct S3 multipart primitives', () => {
  const s3Config = {
    bucket: 'bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', forcePathStyle: true,
    accessKeyIdEncrypted: 'key', secretAccessKeyEncrypted: 'secret',
  } as never

  it('creates, signs, completes, heads, and aborts a server-selected multipart object key', async () => {
    h.send
      .mockResolvedValueOnce({ UploadId: 'upload-1' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ContentLength: 10 })
      .mockResolvedValueOnce({})
    h.getSignedUrl.mockResolvedValueOnce('https://s3.example.test/part?short-lived')

    await expect(createS3MultipartUpload(s3Config, '9drive/user/session/file.txt', 'text/plain')).resolves.toBe('upload-1')
    await expect(getS3PresignedUploadPartUrl(s3Config, '9drive/user/session/file.txt', 'upload-1', 1, 300)).resolves.toContain('short-lived')
    await completeS3MultipartUpload(s3Config, '9drive/user/session/file.txt', 'upload-1', [{ PartNumber: 1, ETag: 'etag-1' }])
    await expect(headS3Object(s3Config, '9drive/user/session/file.txt')).resolves.toEqual({ contentLength: 10n })
    await abortS3MultipartUpload(s3Config, '9drive/user/session/file.txt', 'upload-1')

    expect(h.send.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ input: { Bucket: 'bucket', Key: '9drive/user/session/file.txt', ContentType: 'text/plain' } }),
      expect.objectContaining({ input: { Bucket: 'bucket', Key: '9drive/user/session/file.txt', UploadId: 'upload-1', MultipartUpload: { Parts: [{ PartNumber: 1, ETag: 'etag-1' }] } } }),
      expect.objectContaining({ input: { Bucket: 'bucket', Key: '9drive/user/session/file.txt' } }),
      expect.objectContaining({ input: { Bucket: 'bucket', Key: '9drive/user/session/file.txt', UploadId: 'upload-1' } }),
    ])
    expect(h.getSignedUrl).toHaveBeenCalledWith(expect.any(h.S3Client), expect.objectContaining({
      input: { Bucket: 'bucket', Key: '9drive/user/session/file.txt', UploadId: 'upload-1', PartNumber: 1 },
    }), { expiresIn: 300 })
  })
})
