import { env } from '../../config/env.js'
import fsp from 'node:fs/promises'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { estimateTempReservation, tempStorageReservations, type TempStorageDiagnostics, type TempStorageStage } from './resource-control.js'

export const STAGES = {
  PROBING: 'probing',
  DOWNLOADING: 'downloading',
  SEGMENTS: 'segments',
  REMUXING: 'remuxing',
  VERIFYING: 'verifying',
  SELECTING_STORAGE: 'selecting_storage',
  UPLOADING: 'uploading',
  REGISTERING: 'registering',
  CLEANING: 'cleaning',
  FINISHED: 'finished',
} as const

export type Stage = (typeof STAGES)[keyof typeof STAGES]

export async function updateStage(importId: string, stage: Stage, progress: Record<string, unknown> = {}) {
  await prisma.remoteImport.update({
    where: { id: importId },
    data: { stage, ...progress, heartbeatAt: new Date() },
  }).catch(() => undefined)
}

export async function writeHeartbeat(importId: string) {
  await prisma.remoteImport.update({
    where: { id: importId },
    data: { heartbeatAt: new Date() },
  }).catch(() => undefined)
}

export async function startUploadPhase(importId: string, localPath: string) {
  const stat = await fsp.stat(localPath)
  const totalBytes = BigInt(stat.size)
  await updateStage(importId, STAGES.UPLOADING, { uploadedBytes: 0, uploadTotalBytes: totalBytes })
  return totalBytes
}

export function throttledProgressUpdater(importId: string, stage: Stage) {
  let lastWrite = 0
  return async (progress: Record<string, unknown>) => {
    const now = Date.now()
    if (now - lastWrite < env.REMOTE_IMPORT_PROGRESS_UPDATE_INTERVAL_MS) return
    lastWrite = now
    await updateStage(importId, stage, progress)
  }
}

export function logProgress(importId: string, stage: Stage, message: string) {
  console.log(`[remote-import] ${new Date().toISOString()} ${importId} ${stage}: ${message}`)
}

function serializeResourceDiagnostics(diagnostics: TempStorageDiagnostics) {
  return JSON.stringify({
    ...diagnostics,
    freeBytes: diagnostics.freeBytes.toString(),
    reservedBytes: diagnostics.reservedBytes.toString(),
    requiredBytes: diagnostics.requiredBytes.toString(),
  })
}

export async function admitTempStorage(
  importId: string,
  stage: TempStorageStage,
  sourceType: string | null | undefined,
  contentLength: bigint | null | undefined,
) {
  const admission = await tempStorageReservations.tryAcquire({
    importId,
    stage,
    requiredBytes: estimateTempReservation({ sourceType, contentLength }),
    reserveBytes: BigInt(env.REMOTE_IMPORT_TEMP_FREE_SPACE_RESERVE_BYTES),
  })
  if (admission.admitted) return admission.reservation

  await prisma.remoteImport.update({
    where: { id: importId },
    data: {
      status: 'queued',
      stage: 'waiting',
      errorCode: 'RESOURCE_WAITING',
      errorMessage: 'Waiting for temporary storage capacity.',
      internalError: serializeResourceDiagnostics(admission.diagnostics),
      heartbeatAt: new Date(),
    },
  }).catch(() => undefined)
  console.warn(`[remote-import] ${importId} deferred: temporary storage reserve would be consumed`)
  return null
}

export async function assertImportNotCancelled(importId: string) {
  const current = await prisma.remoteImport.findUnique({ where: { id: importId } }).catch(() => null)
  if (current?.status !== 'cancelled') return
  const error = new AppError('ABORTED', 'The import was cancelled.', 499)
  error.name = 'AbortError'
  throw error
}

export async function markFailed(importId: string, code: string, message: string, internalError?: string) {
  await prisma.remoteImport.update({
    where: { id: importId },
    data: {
      status: 'failed',
      stage: STAGES.FINISHED,
      errorCode: code,
      errorMessage: message.slice(0, 4096),
      internalError: internalError ? internalError.slice(0, 16_384) : null,
      failedAt: new Date(),
    },
  }).catch(() => undefined)
}
