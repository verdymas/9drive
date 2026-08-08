import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { ConnectedAccount, File, S3StorageConfig } from '@prisma/client'
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { decryptText } from '../../utils/crypto.js'

type S3Config = S3StorageConfig
type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

function contentDisposition(type: 'inline' | 'attachment', fileName: string) {
  return `${type}; filename="${fileName.replaceAll('"', '')}"`
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
  await upload.done()
}

export async function deleteS3Object(file: FileWithAccount) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
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

export async function streamS3File(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: range }))

  res.status(response.ContentRange ? 206 : 200)
  res.setHeader('Content-Type', response.ContentType ?? file.mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  if (options.disposition) res.setHeader('Content-Disposition', contentDisposition(options.disposition, file.name))
  if (response.ContentLength !== undefined) res.setHeader('Content-Length', response.ContentLength.toString())
  if (response.ContentRange) res.setHeader('Content-Range', response.ContentRange)

  const body = response.Body as Readable | undefined
  if (!body) return res.end()
  return body.pipe(res)
}
