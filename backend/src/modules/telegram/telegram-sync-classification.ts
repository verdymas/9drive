import { AppError } from '../../utils/app-error.js'
import { inspectCaptionMeta } from './telegram-metadata-cache.js'
import { parseCaption } from './telegram-metadata.js'
import type {
  ClassifyResult,
  DocumentOutcome,
  TelegramDocument,
  TelegramFileRow,
  TelegramSyncRunStats,
} from './telegram-sync-types.js'

export type TelegramIngestAction = 'created' | 'updated' | 'matched' | 'inboxed' | 'skipped'

export type ClassifyTelegramDocumentInput = {
  document: TelegramDocument
  existing: TelegramFileRow | null
  fetchedCaption: string | null
  ingest: (document: TelegramDocument, caption: string | null) => Promise<TelegramIngestAction>
  findPlacedFile: () => Promise<{ id: string; folderId: string | null } | null>
}

/** Classify one Telegram document, with persistence delegated to callbacks. */
export async function classifyTelegramDocument(input: ClassifyTelegramDocumentInput): Promise<ClassifyResult> {
  const { document, existing, fetchedCaption } = input

  // Physical identity match by providerFileId takes precedence over caption
  // metadata. A size mismatch is actionable and never repaired implicitly.
  if (existing) {
    const sizeMatches = existing.sizeBytes === BigInt(document.size)
    if (sizeMatches) {
      const failure = inspectCaptionMeta(document.caption ?? null, existing.encryptedMetadata)
      if (failure) {
        return {
          outcome: { kind: 'unreadableMeta', telegramFileId: document.remoteId, errorCode: failure.code, errorMessage: failure.message },
          fileIdToStamp: existing.id,
        }
      }
      return { outcome: { kind: 'matched' }, fileIdToStamp: existing.id }
    }
    return {
      outcome: {
        kind: 'conflict',
        telegramFileId: document.remoteId,
        reason: 'size mismatch',
        file: { id: existing.id, name: existing.name },
      },
      fileIdToStamp: existing.id,
    }
  }

  const caption = document.caption ?? fetchedCaption ?? null
  const parsed = parseCaption(caption)
  const strategy: '9drive_id' | '9drive_path' | 'physical' | 'recovered' | 'none' = parsed.stableId
    ? '9drive_id'
    : parsed.logicalPath
      ? '9drive_path'
      : 'none'

  try {
    const action = await input.ingest(document, caption)
    const placed = await input.findPlacedFile()
    const fileIdToStamp = placed?.id ?? null
    const finalStrategy: '9drive_id' | '9drive_path' | 'physical' | 'recovered' | 'none' = action === 'inboxed'
      ? 'recovered'
      : strategy

    if (action === 'created' || action === 'inboxed') {
      return {
        outcome: {
          kind: 'imported',
          telegramFileId: document.remoteId,
          strategy: finalStrategy,
          virtualPath: parsed.logicalPath,
          fileId: placed?.id ?? null,
          parentFolderId: placed?.folderId ?? null,
          action,
        },
        fileIdToStamp,
      }
    }
    return { outcome: { kind: 'matched' }, fileIdToStamp }
  } catch (error) {
    if (isUnreadableMetadataError(error)) {
      return {
        outcome: {
          kind: 'unreadableMeta',
          telegramFileId: document.remoteId,
          errorCode: error.code,
          errorMessage: error.message.slice(0, 200),
        },
        fileIdToStamp: null,
      }
    }
    return {
      outcome: {
        kind: 'error',
        telegramFileId: document.remoteId,
        errorCode: error instanceof AppError ? error.code : 'TELEGRAM_UNKNOWN_ERROR',
        errorMessage: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      },
      fileIdToStamp: null,
    }
  }
}

function isUnreadableMetadataError(error: unknown): error is AppError {
  if (!(error instanceof AppError)) return false
  return error.code === 'TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED'
    || error.code === 'TELEGRAM_CRYPTO_KEY_INVALID'
    || error.code.startsWith('TELEGRAM_METADATA_')
}

export function applyOutcomeStats(stats: TelegramSyncRunStats, outcome: DocumentOutcome): void {
  stats.scannedCount += 1
  switch (outcome.kind) {
    case 'matched':
      stats.matchedCount += 1
      break
    case 'imported':
      stats.importedCount += 1
      stats.orphanCount += 1
      if (outcome.strategy === '9drive_id') stats.matchedByIdCount += 1
      else if (outcome.strategy === '9drive_path') stats.matchedByPathCount += 1
      else if (outcome.strategy === 'recovered' || outcome.strategy === 'none') stats.recoveredCount += 1
      break
    case 'missing':
      stats.missingCount += 1
      break
    case 'conflict':
      stats.conflictCount += 1
      break
    case 'unreadableMeta':
      stats.conflictCount += 1
      break
    case 'error':
      stats.errorCount += 1
      break
  }
}
