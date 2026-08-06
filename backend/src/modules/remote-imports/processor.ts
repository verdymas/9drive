import type { Job } from 'bullmq'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { selectAccount } from '../uploads/storage-routing.service.js'
import type { RemoteImportJobData } from './queue.js'
import { followRemoteUrl } from './url-downloader.js'
import { uploadToGoogleResumable } from './google-resumable-uploader.js'
import { createTempPartFile, removeTempFile, appendStreamToTemp } from './temp-storage.js'
import { sanitizeFileName } from './filename-sanitize.js'

const STAGES = {
  PROBING: 'probing',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  SELECTING_STORAGE: 'selecting_storage',
  UPLOADING: 'uploading',
  REGISTERING: 'registering',
  CLEANING: 'cleaning',
  FINISHED: 'finished',
} as const

type Stage = (typeof STAGES)[keyof typeof STAGES]

/**
 * Update the domain row's stage + progress. `progress` must be a small
 * object of bytes/fields (never the URL, never tokens). Errors are swallowed
 * so a transient DB blip never fails the import itself.
 */
async function updateStage(importId: string, stage: Stage, progress: Record<string, unknown> = {}) {
  await prisma.remoteImport.update({
    where: { id: importId },
    data: { stage, ...progress },
  }).catch(() => undefined)
}

/** Throttle a stage-update call to REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS. */
function throttledProgressUpdater(importId: string) {
  let lastWrite = 0
  return async (progress: Record<string, unknown>) => {
    const now = Date.now()
    if (now - lastWrite < env.REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS) return
    lastWrite = now
    await updateStage(importId, STAGES.DOWNLOADING, progress)
  }
}

function nowIso() {
  return new Date().toISOString()
}

function logProgress(importId: string, stage: Stage, message: string) {
  // Log-only; never includes URL query strings or secrets.
  console.log(`[remote-import] ${nowIso()} ${importId} ${stage}: ${message}`)
}

/** Fetch + stream a remote URL to a temp part file with byte cap and idle timeout. */
async function downloadToTemp(importId: string, startUrl: string, maxBytes: bigint): Promise<{ finalUrl: string; tempPartPath: string; contentLength: bigint | null; supportsRange: boolean }> {
  const partPath = await createTempPartFile(importId)
  let supportsRange = false
  let contentLength: bigint | null = null
  let finalUrl = startUrl
  let totalBytes = 0n

  await followRemoteUrl(startUrl, {
    onResponse: async (res) => {
      const rawLength = res.headers['content-length']
      if (rawLength) contentLength = BigInt(rawLength)
      supportsRange = res.headers['accept-ranges'] === 'bytes' || res.statusCode === 206
      if (res.statusCode >= 400) {
        throw new AppError('DOWNLOAD_HTTP_ERROR', `Remote server responded ${res.statusCode}.`, 502)
      }

      // Idle-timeout and size-cap aborts are deliberate — keep the body's
      // 'error' event from becoming an unhandled rejection. The body is an
      // undici stream at runtime; guard for the type-safe listener.
      if (typeof (res.body as { on?: unknown }).on === 'function') {
        (res.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
      }

      const fileStream = appendStreamToTemp(partPath)
      const writeProgress = throttledProgressUpdater(importId)

      try {
        for await (const chunk of res.body) {
          totalBytes += BigInt(chunk.byteLength)
          if (totalBytes > maxBytes) {
            fileStream.destroy()
            throw new AppError('DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.', 413)
          }
          if (!fileStream.write(chunk)) {
            await new Promise<void>((resolve) => fileStream.once('drain', resolve))
          }
          await writeProgress({ downloadedBytes: totalBytes.toString() })
        }
        await new Promise<void>((resolve, reject) => fileStream.end((err: Error | null) => (err ? reject(err) : resolve())))
      } catch (error) {
        fileStream.destroy()
        throw error
      }
      return { finalUrl, contentLength, supportsRange }
    },
  })

  await updateStage(importId, STAGES.VERIFYING, { downloadedBytes: totalBytes.toString() })
  return { finalUrl, tempPartPath: partPath, contentLength, supportsRange }
}

/** Stream the temp part file into the destination provider and return provider metadata. */
async function uploadTempFile(importId: string, account: { id: string; provider: string }, userId: string, folderId: string | null, fileName: string, mimeType: string, tempPartPath: string) {
  const fileStream = fs.createReadStream(tempPartPath)
  await updateStage(importId, STAGES.UPLOADING)

  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id, userId)
    const provisionalFile = await prisma.file.create({
      data: { userId, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType, sizeBytes: 0n, status: 'uploading' },
    })
    const providerFileId = buildS3ObjectKey(config, userId, provisionalFile.id, fileName)
    try {
      await uploadS3Object(config, providerFileId, fileStream, mimeType)
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId, status: 'active' } })
      return { providerFileId, fileId: provisionalFile.id }
    } catch (error) {
      await prisma.file.update({ where: { id: provisionalFile.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
      throw error
    }
  }

  // Google Drive — resumable upload streams the temp file directly, records
  // the session encrypted (for crash-resume), and returns provider metadata.
  const uploaded = await uploadToGoogleResumable(importId, account.id, userId, folderId, fileName, mimeType, tempPartPath)
  return { providerFileId: uploaded.providerFileId, fileId: null }
}

/**
 * Register the imported file in the virtual filesystem (idempotent by
 * providerFileId when the row already points at one).
 */
async function registerFile(importId: string, remoteImport: { userId: string; folderId: string | null; connectedAccountId: string | null; fileName: string; mimeType: string | null; tempPath: string | null }, providerFileId: string, sizeBytes: bigint) {
  await updateStage(importId, STAGES.REGISTERING)
  const accountId = remoteImport.connectedAccountId
  if (!accountId) throw new Error('Missing connected account for file registration.')
  const provider = (await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })).provider

  const existing = await prisma.file.findFirst({
    where: { userId: remoteImport.userId, provider, providerFileId },
  })
  if (existing) return existing

  const created = await prisma.file.create({
    data: {
      userId: remoteImport.userId,
      connectedAccountId: accountId,
      folderId: remoteImport.folderId,
      provider,
      providerFileId,
      name: remoteImport.fileName,
      mimeType: remoteImport.mimeType ?? 'application/octet-stream',
      sizeBytes,
      status: 'active',
    },
  })
  await createAuditLog(remoteImport.userId, 'IMPORT_FILE', 'file', created.id, { name: created.name, size: created.sizeBytes.toString() })
  return created
}

/** Mark the import failed with a safe, loggable message (never the URL). */
async function markFailed(importId: string, code: string, message: string) {
  await prisma.remoteImport.update({
    where: { id: importId },
    data: { status: 'failed', stage: STAGES.FINISHED, errorCode: code, errorMessage: message, failedAt: new Date() },
  }).catch(() => undefined)
}

/**
 * Main worker processor. Drives one import through every stage and writes
 * progress back to the `remote_imports` row. The temp file is removed
 * regardless of outcome; a `CANCELLED` import aborts early.
 */
export async function processRemoteImportJob(job: Job<RemoteImportJobData>) {
  const { importId } = job.data
  const record = await prisma.remoteImport.findUnique({ where: { id: importId } })
  if (!record) return
  if (record.status === 'cancelled') return

  const userId = record.userId
  const folderId = record.folderId
  const fileName = sanitizeFileName(record.fileName)
  const mimeType = record.mimeType ?? 'application/octet-stream'
  const sourceUrl = decryptText(record.sourceUrlEncrypted)
  const maxBytes = BigInt(env.REMOTE_IMPORT_MAX_BYTES)
  const startedAt = Date.now()
  const jobTimeoutMs = env.REMOTE_IMPORT_JOB_TIMEOUT_HOURS * 60 * 60 * 1000

  // Fail an import that has been running longer than the configured cap
  // (BullMQ v6 has no per-job `timeout` option; the deadline is enforced here,
  // between phases, so a hung download never occupies a worker slot forever).
  const assertWithinTimeout = () => {
    if (Date.now() - startedAt > jobTimeoutMs) {
      throw new AppError('IMPORT_TIMEOUT', `Import exceeded the ${env.REMOTE_IMPORT_JOB_TIMEOUT_HOURS}h time limit.`, 408)
    }
  }

  try {
    if (record.status !== 'queued' && record.status !== 'failed' && record.status !== 'processing') return

    await prisma.remoteImport.update({
      where: { id: importId },
      data: { status: 'processing', stage: STAGES.PROBING, startedAt: new Date(), jobId: job.id },
    })

    // Probe the URL: follow redirects with SSRF validation, get size/range.
    // A ranged GET (`bytes=0-0`) keeps the probe cheap; servers that ignore
    // the range still answer 200 with a full body, which we abort after the
    // first chunk (we only need headers + content-length).
    let finalUrl: string
    try {
      const probe = await followRemoteUrl(sourceUrl, {
        headers: { Range: 'bytes=0-0' },
        onResponse: async (res) => {
          const length = res.headers['content-length']
          const supportsRange = res.headers['accept-ranges'] === 'bytes' || res.statusCode === 206
          // The early abort below is deliberate — silence the body error event.
          if (typeof (res.body as { on?: unknown }).on === 'function') {
            (res.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
          }
          // Abort the body after the first chunk (a server that ignored our
          // Range may stream the whole file — we don't want that during probe).
          const reader = res.body[Symbol.asyncIterator]()
          await reader.next().catch(() => undefined)
          await reader.return?.().catch(() => undefined)
          return { length, supportsRange }
        },
      })
      finalUrl = probe.finalUrl
      if (probe.result.length) {
        const declared = BigInt(probe.result.length)
        if (declared > maxBytes) {
          await markFailed(importId, 'DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.')
          return
        }
        await prisma.remoteImport.update({ where: { id: importId }, data: { totalBytes: declared, sourceRangeSupported: probe.result.supportsRange } })
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'DOWNLOAD_TOO_LARGE') {
        await markFailed(importId, 'DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.')
        return
      }
      throw error
    }

    const downloaded = await downloadToTemp(importId, finalUrl, maxBytes)
    finalUrl = downloaded.finalUrl

    assertWithinTimeout()

    // Re-check cancellation between phases.
    const afterDownload = await prisma.remoteImport.findUnique({ where: { id: importId } })
    if (afterDownload?.status === 'cancelled') {
      await removeTempFile(importId)
      return
    }

    assertWithinTimeout()

    // Select destination account (default routing or pinned account).
    // Precedence: the user's explicit `connectedAccountId` wins over the
    // destination folder's binding (the folder binding already implies it,
    // but the user's direct pick must not be silently overridden).
    await updateStage(importId, STAGES.SELECTING_STORAGE)
    const folder = folderId
      ? await prisma.folder.findFirst({ where: { id: folderId, userId, deletedAt: null } })
      : null
    const targetAccountId = record.connectedAccountId ?? folder?.connectedAccountId ?? undefined
    const account = await selectAccount(userId, downloaded.contentLength ?? 0n, undefined, targetAccountId)
    if (!account) {
      await markFailed(importId, 'NO_ACCOUNT_WITH_ENOUGH_SPACE', 'No connected storage account has enough space.')
      await removeTempFile(importId)
      return
    }

    // Upload.
    const uploaded = await uploadTempFile(importId, { id: account.id, provider: account.provider }, userId, folderId, fileName, mimeType, downloaded.tempPartPath)
    assertWithinTimeout()
    await updateStage(importId, STAGES.REGISTERING)

    // Register file + link the import row.
    const sizeBytes = downloaded.contentLength ?? (await fsp.stat(downloaded.tempPartPath)).size
    const file = await registerFile(importId, { ...record, connectedAccountId: account.id, fileName, mimeType }, uploaded.providerFileId, BigInt(sizeBytes))

    const totalSize = BigInt(sizeBytes)
    await prisma.remoteImport.update({
      where: { id: importId },
      data: {
        status: 'completed',
        stage: STAGES.FINISHED,
        fileId: file.id,
        completedAt: new Date(),
        downloadedBytes: totalSize,
        uploadedBytes: totalSize,
        tempPath: null,
        finalUrlEncrypted: encryptText(finalUrl),
      },
    })
    logProgress(importId, STAGES.FINISHED, 'import completed')

    // Quota sync (best-effort).
    if (account.provider === 's3') syncS3Quota(account.id).catch(() => undefined)
    else syncGoogleQuota(account.id).catch(() => undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const code = error instanceof AppError ? error.code : 'IMPORT_FAILED'
    await markFailed(importId, code, message)
    console.error(`[remote-import] ${importId} failed: ${code} ${message}`)
  } finally {
    await removeTempFile(importId)
  }
}