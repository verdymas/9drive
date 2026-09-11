import type { RemoteImportRequestContext } from './request-context.js'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'
import {
  admitTempStorage,
  assertImportNotCancelled,
  logProgress,
  markFailed,
  STAGES,
  throttledProgressUpdater,
  updateStage,
  writeHeartbeat,
  type Stage,
} from './processor-progress.js'
import type { TempStorageStage } from './resource-control.js'

export { STAGES }
export type { Stage }
export type ProcessorRecord = Record<string, any>

export type RemoteImportProcessorContext<TRecord extends ProcessorRecord = ProcessorRecord> = {
  importId: string
  record: TRecord
  userId: string
  folderId: string | null
  fileName: string
  mimeType: string
  sourceUrl: string
  requestContext?: RemoteImportRequestContext
  maxBytes: bigint
  assertWithinTimeout(): void
  updateStage(stage: Stage, progress?: Record<string, unknown>): Promise<void>
  heartbeat(): Promise<void>
  assertNotCancelled(): Promise<void>
  markFailed(code: string, message: string, internalError?: string): Promise<void>
  admitTempStorage(stage: TempStorageStage, contentLength?: bigint | null): Promise<{ release(): void } | null>
  throttledProgressUpdater(stage: Stage): (progress: Record<string, unknown>) => Promise<void>
  logProgress(stage: Stage, message: string): void
}

export type RemoteImportProcessorContextOptions<TRecord extends ProcessorRecord = ProcessorRecord> = {
  importId: string
  record: TRecord
  userId: string
  folderId: string | null
  fileName: string
  mimeType: string
  sourceUrl: string
  requestContext?: RemoteImportRequestContext
  maxBytes: bigint
  startedAt: number
  jobTimeoutMs: number
}

export function createRemoteImportProcessorContext<TRecord extends ProcessorRecord>(
  options: RemoteImportProcessorContextOptions<TRecord>,
): RemoteImportProcessorContext<TRecord> {
  return {
    importId: options.importId,
    record: options.record,
    userId: options.userId,
    folderId: options.folderId,
    fileName: options.fileName,
    mimeType: options.mimeType,
    sourceUrl: options.sourceUrl,
    requestContext: options.requestContext,
    maxBytes: options.maxBytes,
    assertWithinTimeout: () => {
      if (Date.now() - options.startedAt > options.jobTimeoutMs) {
        throw new AppError('IMPORT_TIMEOUT', `Import exceeded the ${env.REMOTE_IMPORT_JOB_TIMEOUT_HOURS}h time limit.`, 408)
      }
    },
    updateStage: (stage, progress) => updateStage(options.importId, stage, progress),
    heartbeat: () => writeHeartbeat(options.importId),
    assertNotCancelled: () => assertImportNotCancelled(options.importId),
    markFailed: (code, message, internalError) => markFailed(options.importId, code, message, internalError),
    admitTempStorage: (stage, contentLength) => admitTempStorage(options.importId, stage, options.record.sourceType, contentLength),
    throttledProgressUpdater: (stage) => throttledProgressUpdater(options.importId, stage),
    logProgress: (stage, message) => logProgress(options.importId, stage, message),
  }
}

export function isHlsRecord(record: { sourceType?: string | null }): boolean {
  return record.sourceType === 'hls_master' || record.sourceType === 'hls_media'
}
