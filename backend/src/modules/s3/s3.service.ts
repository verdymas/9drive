import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ConnectedAccount, File, S3StorageConfig } from '@prisma/client'
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { decryptText } from '../../utils/crypto.js'
import { streamProxyResponse } from '../files/file-delivery.js'
import type { FileDeliveryDecision } from '../files/file-delivery.js'

type S3Config = S3StorageConfig
type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

type S3DownloadDecisionOptions = {
  enabled: boolean
  ttlSeconds: number
  range?: string
  disposition?: 'inline' | 'attachment'
}

function attachmentDisposition(fileName: string) {
  return `attachment; filename="${fileName.replaceAll('"', '')}"`
}

export function createS3Client(config: S3Config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle || Boolean(config.endpoint),
    credentials: {
      accessKeyId: decryptText(config.accessKeyIdEncrypted),
      secretAccessKey: decryptText(config.secretAccessKeyEncrypted),
    },
  })
}

export async function getS3ConfigForAccount(accountId: string, userId?: string) {
  return prisma.s3StorageConfig.findFirstOrThrow({ where: { connectedAccountId: accountId, status: 'active', ...(userId ? { userId } : {}) } })
}

export async function testS3Connection(config: S3Config) {
  const client = createS3Client(config)
  await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
}

function safeFileName(name: string) {
  return name.replace(/[\\/]+/g, '-').replace(/[\u0000-\u001f\u007f]+/g, '').slice(0, 180) || 'file'
}

/**
 * Build the S3 object key for a file.
 *
 * With a `folderPrefix` (the virtual folder's physical location prefix, e.g.
 * `Movies/Action` relative to the account root `9drive`), the object lands
 * under the folder's key prefix:
 *
 *   9drive/Movies/Action/{userId}/{fileId}/{name}
 *
 * Without one (root upload, or a folder that has never been materialized on
 * this account), the legacy flat scheme is kept:
 *
 *   9drive/{userId}/{fileId}/{name}
 *
 * Existing objects under the flat scheme are NOT migrated by this refactor —
 * both schemes coexist; keys are unique because `fileId` is a UUID.
 */
export function buildS3ObjectKey(config: Pick<S3Config, 'prefix'>, userId: string, fileId: string, fileName: string, folderPrefix?: string) {
  const root = config.prefix.replace(/^\/+|\/+$/g, '')
  if (folderPrefix) {
    const cleanFolder = folderPrefix.replace(/^\/+|\/+$/g, '').replace(/^9drive\/?/, '')
    if (cleanFolder) return `${root}/${cleanFolder}/${userId}/${fileId}/${safeFileName(fileName)}`
  }
  return `${root}/${userId}/${fileId}/${safeFileName(fileName)}`
}

export type UploadS3ObjectOptions = {
  /**
   * Called with the number of bytes uploaded so far. `httpUploadProgress`
   * reports per-part completions, so this is a step function of confirmed
   * bytes (plus parts already sent) — close enough for a live progress bar.
   */
  onProgress?: (uploadedBytes: bigint) => void
  /** Abort the managed multipart transfer when the originating request ends. */
  signal?: AbortSignal
}

/**
 * Return a direct S3 URL only for the ordinary attachment flow. Preview,
 * WebDAV, archive, and ranged reads intentionally never call this decision.
 * Signing failures are non-fatal: the caller retains the complete proxy path.
 */
export async function getS3DownloadDecision(
  file: FileWithAccount,
  options: S3DownloadDecisionOptions,
): Promise<FileDeliveryDecision> {
  if (!options.enabled || file.provider !== 's3' || options.range || options.disposition !== 'attachment') {
    return { kind: 'proxy' }
  }
  try {
    const config = await getS3ConfigForAccount(file.connectedAccountId, file.userId)
    const url = await getSignedUrl(
      createS3Client(config),
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: file.providerFileId,
        ResponseContentDisposition: attachmentDisposition(file.name),
      }),
      { expiresIn: options.ttlSeconds },
    )
    return { kind: 'redirect', url }
  } catch {
    return { kind: 'proxy' }
  }
}

/** S3 multipart primitives. Callers keep authority over account/key/session. */
export async function createS3MultipartUpload(config: S3Config, key: string, mimeType: string) {
  const response = await createS3Client(config).send(new CreateMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: mimeType,
  }))
  if (!response.UploadId) throw new Error('S3 did not return a multipart upload ID.')
  return response.UploadId
}

export async function getS3PresignedUploadPartUrl(
  config: S3Config,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn: number,
) {
  return getSignedUrl(
    createS3Client(config),
    new UploadPartCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn },
  )
}

/** Upload one server-relayed multipart part and return the provider ETag. */
export async function uploadS3MultipartPart(
  config: S3Config,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
) {
  const response = await createS3Client(config).send(new UploadPartCommand({
    Bucket: config.bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
    Body: body,
  }))
  if (!response.ETag) throw new Error('S3 did not return a multipart part ETag.')
  return response.ETag
}

export async function completeS3MultipartUpload(
  config: S3Config,
  key: string,
  uploadId: string,
  parts: Array<{ PartNumber: number; ETag: string }>,
) {
  await createS3Client(config).send(new CompleteMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }))
}

export async function abortS3MultipartUpload(config: S3Config, key: string, uploadId: string) {
  await createS3Client(config).send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId }))
}

/**
 * Parts the provider actually holds for an in-flight multipart upload. The
 * authoritative answer for "how far did a direct upload get" — the backend
 * never saw the bytes, so no local bookkeeping can replace it.
 */
export async function listS3MultipartParts(config: S3Config, key: string, uploadId: string) {
  const response = await createS3Client(config).send(new ListPartsCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId }))
  return (response.Parts ?? []).map((part) => ({ partNumber: part.PartNumber ?? 0, size: BigInt(part.Size ?? 0) }))
}

export async function headS3Object(config: S3Config, key: string) {
  const response = await createS3Client(config).send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
  return { contentLength: BigInt(response.ContentLength ?? 0) }
}

export async function uploadS3Object(
  config: S3Config,
  key: string,
  body: NodeJS.ReadableStream,
  mimeType: string,
  opts?: UploadS3ObjectOptions,
) {
  const client = createS3Client(config)
  const upload = new Upload({
    client,
    params: { Bucket: config.bucket, Key: key, Body: body as Readable, ContentType: mimeType },
  })
  if (opts?.onProgress) {
    upload.on('httpUploadProgress', (event) => {
      if (event.loaded != null) opts.onProgress!(BigInt(event.loaded))
    })
  }
  const abort = () => {
    void upload.abort().catch(() => undefined)
  }
  if (opts?.signal?.aborted) abort()
  opts?.signal?.addEventListener('abort', abort, { once: true })
  try {
    await upload.done()
  } finally {
    opts?.signal?.removeEventListener('abort', abort)
  }
}

export async function deleteS3Object(file: FileWithAccount) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
}

/** Delete a just-created object before a File row can be safely retained. */
export async function deleteS3ObjectByKey(config: S3Config, key: string) {
  const client = createS3Client(config)
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
}

export async function syncS3Quota(accountId: string) {
  const config = await getS3ConfigForAccount(accountId)
  const client = createS3Client(config)
  let usedBytes = 0n
  let continuationToken: string | undefined
  do {
    const response = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: continuationToken }))
    for (const object of response.Contents ?? []) usedBytes += BigInt(object.Size ?? 0)
    continuationToken = response.NextContinuationToken
  } while (continuationToken)

  return prisma.storageAccount.upsert({
    where: { connectedAccountId: accountId },
    create: {
      connectedAccountId: accountId,
      totalBytes: config.quotaBytes,
      usedBytes,
      availableBytes: config.quotaBytes === null ? null : config.quotaBytes - usedBytes,
      lastSyncedAt: new Date(),
    },
    update: {
      totalBytes: config.quotaBytes,
      usedBytes,
      availableBytes: config.quotaBytes === null ? null : config.quotaBytes - usedBytes,
      lastSyncedAt: new Date(),
    },
  })
}

export async function streamS3File(
  file: FileWithAccount,
  range: string | undefined,
  res: Response,
  options: StreamOptions = {},
  signal?: AbortSignal,
) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: range }), { abortSignal: signal })

  const body = response.Body as Readable | undefined
  if (!body) {
    res.status(response.ContentRange ? 206 : 200)
    res.setHeader('Content-Type', response.ContentType ?? file.mimeType)
    res.setHeader('Accept-Ranges', 'bytes')
    return res.end()
  }
  return streamProxyResponse(res, {
    body,
    status: response.ContentRange ? 206 : 200,
    contentType: response.ContentType ?? file.mimeType,
    contentLength: response.ContentLength,
    contentRange: response.ContentRange,
    disposition: options.disposition,
    fileName: file.name,
    abort: () => body.destroy(),
  })
}
