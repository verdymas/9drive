export const TELEGRAM_SYNC_STATUSES = [
  'never_synced',
  'syncing',
  'up_to_date',
  'changes_detected',
  'needs_attention',
  'sync_failed',
] as const

export type TelegramSyncStatus = (typeof TELEGRAM_SYNC_STATUSES)[number]

export const TELEGRAM_SYNC_ISSUE_KINDS = [
  'ORPHAN_REMOTE_FILE',
  'REMOTE_FILE_MISSING',
  'TELEGRAM_METADATA_MISMATCH',
  'TELEGRAM_METADATA_UNREADABLE',
] as const

export type TelegramSyncIssueKind = (typeof TELEGRAM_SYNC_ISSUE_KINDS)[number]

export type TelegramSyncRunStats = {
  scannedCount: number
  matchedCount: number
  importedCount: number
  missingCount: number
  orphanCount: number
  conflictCount: number
  errorCount: number
  matchedByIdCount: number
  matchedByPathCount: number
  recoveredCount: number
  trashedCount: number
}

export type TelegramSyncRunSummary = TelegramSyncRunStats & {
  id: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: Date
  finishedAt: Date | null
  errorCode: string | null
  errorMessage: string | null
  durationMs: number | null
}

export type TelegramSyncOptions = {
  full?: boolean
  trigger?: 'manual' | 'auto' | 'recovery'
  skipLock?: boolean
}

export type TelegramDocument = {
  remoteId: string
  channelId: string
  messageId: number
  name: string
  size: number
  mimeType: string | null
  caption?: string | null
}

export type TelegramFileRow = {
  id: string
  providerFileId: string
  name: string
  mimeType: string
  sizeBytes: bigint
  folderId: string | null
  telegramStableId: string | null
  status: string
  encryptedMetadata: string | null
}

export type FileByProviderFileId = Map<string, TelegramFileRow>

export type DocumentOutcome =
  | { kind: 'matched' }
  | {
      kind: 'imported'
      telegramFileId: string
      strategy: '9drive_id' | '9drive_path' | 'physical' | 'recovered' | 'none'
      virtualPath: string | null
      fileId: string | null
      parentFolderId: string | null
      action: 'created' | 'updated' | 'matched' | 'inboxed' | 'skipped'
    }
  | { kind: 'missing'; telegramFileId: string; file: { id: string; name: string } }
  | { kind: 'conflict'; telegramFileId: string; reason: string; file: { id: string; name: string } }
  | { kind: 'unreadableMeta'; telegramFileId: string; errorCode: string; errorMessage: string }
  | { kind: 'error'; telegramFileId: string; errorCode: string; errorMessage: string }

export type ClassifyResult = {
  outcome: DocumentOutcome
  fileIdToStamp: string | null
}

export type RawTelegramDocument = {
  messageId: number
  name: string
  size: number
  mimeType: string | null
  caption: string | null
}

export const emptyTelegramSyncStats = (): TelegramSyncRunStats => ({
  scannedCount: 0,
  matchedCount: 0,
  importedCount: 0,
  missingCount: 0,
  orphanCount: 0,
  conflictCount: 0,
  errorCount: 0,
  matchedByIdCount: 0,
  matchedByPathCount: 0,
  recoveredCount: 0,
  trashedCount: 0,
})
