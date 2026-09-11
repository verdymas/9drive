# Database Schema Reference

Source of truth: `backend/prisma/schema.prisma` (MySQL).

## Relationship Overview

- `User` owns sessions, accounts, virtual files/folders, imports, API keys, audit records, browser devices, etc.
- `ConnectedAccount` is the hub for physical storage provider identity.
- `StorageAccount` stores quota/usage snapshot per connected account.
- `FolderStorageLocation` maps logical folders to physical provider folders.
- `File` belongs to exactly one connected account/provider at a time.
- `RemoteImport` optionally points to destination account, worker, and resulting file.
- Telegram sync has dedicated state/run/issue tables.

## Models

### `User`

**Fields:** `id: String`, `name: String`, `email: String`, `passwordHash: String`, `status: String`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `sessions: UserSession[]`, `authHandoffs: AuthHandoff[]`, `providerConfigs: ProviderConfig[]`, `oauthStates: OauthState[]`, `connectedAccounts: ConnectedAccount[]`, `s3StorageConfigs: S3StorageConfig[]`, `telegramStorageConfigs: TelegramStorageConfig[]`, `telegramAuthStates: TelegramAuthState[]`, `files: File[]`, `fileShares: FileShare[]`, `filePreviewTokens: FilePreviewToken[]`, `folders: Folder[]`, `uploadSessions: UploadSession[]`, `auditLogs: AuditLog[]`, `workspaceInvitesSent: WorkspaceInvite[]`, `uploadRoutingPolicy: UploadRoutingPolicy?`, `apiKeys: ApiKey[]`, `remoteImports: RemoteImport[]`, `syncRuns: SyncRun[]`, `browserDevicePairings: BrowserDevicePairing[]`, `browserDevices: BrowserDevice[]`, `capturedResources: CapturedResource[]`.

### `ApiKey`

**Fields:** `id: String`, `userId: String`, `name: String`, `keyPrefix: String`, `keyHash: String`, `scopes: Json`, `status: String`, `lastUsedAt: DateTime?`, `expiresAt: DateTime?`, `revokedAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`.

### `UploadRoutingPolicy`

**Fields:** `id: String`, `userId: String`, `mode: String`, `priorityAccountIds: Json`, `roundRobinCursor: Int`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`.

### `UserSession`

**Fields:** `id: String`, `userId: String`, `refreshTokenHash: String`, `userAgent: String?`, `ipAddress: String?`, `expiresAt: DateTime`, `revokedAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`.

### `AuthHandoff`

**Fields:** `id: String`, `userId: String`, `tokenHash: String`, `expiresAt: DateTime`, `usedAt: DateTime?`, `createdAt: DateTime`.

**Relations:** `user: User`.

### `ProviderConfig`

**Fields:** `id: String`, `userId: String?`, `provider: String`, `clientIdEncrypted: String`, `clientSecretEncrypted: String`, `redirectUri: String`, `scopes: Json`, `status: String`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User?`, `oauthStates: OauthState[]`, `connectedAccounts: ConnectedAccount[]`.

### `OauthState`

**Fields:** `id: String`, `userId: String?`, `providerConfigId: String`, `flow: String`, `stateHash: String`, `expiresAt: DateTime`, `usedAt: DateTime?`, `connectedAccountId: String?`, `createdAt: DateTime`.

**Relations:** `user: User?`, `providerConfig: ProviderConfig`.

### `ConnectedAccount`

**Fields:** `id: String`, `userId: String`, `providerConfigId: String?`, `provider: String`, `providerAccountId: String`, `email: String`, `displayName: String?`, `avatarUrl: String?`, `accessTokenEncrypted: String?`, `refreshTokenEncrypted: String?`, `tokenExpiresAt: DateTime?`, `scopes: Json`, `status: String`, `autoAllocationEnabled: Boolean`, `lastError: String?`, `reauthRequiredAt: DateTime?`, `lastAuthErrorCode: String?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`, `providerConfig: ProviderConfig?`, `storageAccount: StorageAccount?`, `files: File[]`, `folders: Folder[]`, `storageLocations: FolderStorageLocation[]`, `uploadSessions: UploadSession[]`, `s3StorageConfig: S3StorageConfig?`, `telegramStorageConfig: TelegramStorageConfig?`, `remoteImports: RemoteImport[]`, `syncRuns: SyncRun[]`, `telegramSyncStates: TelegramSyncState[]`, `telegramSyncRuns: TelegramSyncRun[]`, `telegramSyncIssues: TelegramSyncIssue[]`.

### `S3StorageConfig`

**Fields:** `id: String`, `userId: String`, `connectedAccountId: String`, `name: String`, `bucket: String`, `region: String`, `endpoint: String?`, `accessKeyIdEncrypted: String`, `secretAccessKeyEncrypted: String`, `forcePathStyle: Boolean`, `prefix: String`, `quotaBytes: BigInt?`, `status: String`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`, `connectedAccount: ConnectedAccount`.

### `TelegramStorageConfig`

**Fields:** `id: String`, `userId: String`, `connectedAccountId: String`, `name: String`, `apiIdEncrypted: String`, `apiHashEncrypted: String`, `sessionEncrypted: String`, `channelId: String?`, `channelTitle: String?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`, `connectedAccount: ConnectedAccount`.

### `TelegramAuthState`

**Fields:** `id: String`, `userId: String`, `connectedAccountId: String?`, `step: String`, `apiIdEncrypted: String`, `apiHashEncrypted: String`, `phoneEncrypted: String?`, `codeHashEncrypted: String?`, `sessionEncrypted: String`, `expiresAt: DateTime`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`.

### `StorageAccount`

**Fields:** `id: String`, `connectedAccountId: String`, `totalBytes: BigInt?`, `usedBytes: BigInt`, `availableBytes: BigInt?`, `trashBytes: BigInt?`, `fileCount: Int`, `lastSyncedAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `connectedAccount: ConnectedAccount`.

### `File`

**Fields:** `id: String`, `userId: String`, `connectedAccountId: String`, `folderId: String?`, `provider: String`, `providerFileId: String`, `name: String`, `mimeType: String`, `sizeBytes: BigInt`, `checksum: String?`, `status: String`, `lastSeenSyncRunId: String?`, `telegramStableId: String?`, `createdAt: DateTime`, `updatedAt: DateTime`, `deletedAt: DateTime?`.

**Relations:** `user: User`, `connectedAccount: ConnectedAccount`, `folder: Folder?`, `shares: FileShare[]`, `previewTokens: FilePreviewToken[]`, `remoteImport: RemoteImport?`.

WebDAV exact child resolution uses the composite index
`files_folder_status_name_idx` on `(folder_id, status, name)`. The index
matches the existing shared-password WebDAV predicates; normal REST file
queries continue to use their user-prefixed indexes.

### `RemoteImport`

**Fields:** `id: String`, `userId: String`, `folderId: String?`, `connectedAccountId: String?`, `workerId: String?`, `workerNameSnapshot: String?`, `fileId: String?`, `sourceUrlEncrypted: String`, `requestContextEncrypted: String?`, `displayUrl: String`, `finalUrlEncrypted: String?`, `fileName: String`, `sourceFileName: String?`, `mimeType: String?`, `status: String`, `stage: String`, `totalBytes: BigInt?`, `downloadedBytes: BigInt`, `uploadedBytes: BigInt`, `uploadTotalBytes: BigInt?`, `sourceETag: String?`, `sourceLastModified: DateTime?`, `sourceRangeSupported: Boolean`, `sourceType: String?`, `hlsPlaylistType: String?`, `hlsVariantId: String?`, `hlsVariantBandwidth: Int?`, `hlsVariantWidth: Int?`, `hlsVariantHeight: Int?`, `hlsAudioTrackId: String?`, `hlsAudioTrackLanguage: String?`, `hlsOutputContainer: String?`, `hlsIsLive: Boolean?`, `hlsRecordingDurationSeconds: Int?`, `hlsMediaDurationSeconds: Float?`, `hlsSegmentCount: Int?`, `hlsCompletedSegmentCount: Int?`, `remuxProgress: Float?`, `outputDurationSeconds: Float?`, `outputCodecSummary: String?`, `tempPath: String?`, `resumeSessionEncrypted: String?`, `jobId: String?`, `attempt: Int`, `queuedAt: DateTime?`, `retryRequestedAt: DateTime?`, `heartbeatAt: DateTime?`, `retryFromStage: String?`, `errorCode: String?`, `errorMessage: String?`, `internalError: String?`, `startedAt: DateTime?`, `completedAt: DateTime?`, `failedAt: DateTime?`, `cancelledAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`, `folder: Folder?`, `connectedAccount: ConnectedAccount?`, `worker: RemoteFetchWorker?`, `file: File?`.

### `FileShare`

**Fields:** `id: String`, `fileId: String`, `userId: String`, `token: String?`, `tokenHash: String`, `enabled: Boolean`, `expiresAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `file: File`, `user: User`.

### `FilePreviewToken`

**Fields:** `id: String`, `fileId: String`, `userId: String`, `tokenHash: String`, `expiresAt: DateTime`, `createdAt: DateTime`.

**Relations:** `file: File`, `user: User`.

### `Folder`

**Fields:** `id: String`, `userId: String`, `parentId: String?`, `connectedAccountId: String?`, `provider: String`, `providerFolderId: String?`, `name: String`, `normalizedName: String?`, `origin: String`, `color: String`, `iconUrl: String?`, `createdAt: DateTime`, `updatedAt: DateTime`, `deletedAt: DateTime?`.

**Relations:** `user: User`, `parent: Folder?`, `children: Folder[]`, `connectedAccount: ConnectedAccount?`, `storageLocations: FolderStorageLocation[]`, `files: File[]`, `uploadSessions: UploadSession[]`, `remoteImports: RemoteImport[]`.

WebDAV exact child resolution uses the composite index
`folders_parent_deleted_name_idx` on `(parent_id, deleted_at, name)`.

### `FolderStorageLocation`

**Fields:** `id: String`, `folderId: String`, `connectedAccountId: String`, `provider: String`, `providerFolderId: String`, `lastSeenSyncRunId: String?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `folder: Folder`, `connectedAccount: ConnectedAccount`.

### `SyncRun`

**Fields:** `id: String`, `userId: String`, `connectedAccountId: String`, `provider: String`, `status: String`, `startedAt: DateTime`, `completedAt: DateTime?`, `errorCode: String?`, `errorMessage: String?`, `foldersDiscovered: Int`, `filesDiscovered: Int`, `foldersCreated: Int`, `mappingsCreated: Int`, `mappingsReused: Int`, `mappingsDetached: Int`, `filesCreated: Int`, `filesUpdated: Int`, `filesMoved: Int`, `filesMissing: Int`, `mappingsMissing: Int`, `collisionsDetected: Int`, `scannedCount: Int`, `matchedCount: Int`, `importedCount: Int`, `missingCount: Int`, `orphanCount: Int`, `conflictCount: Int`, `errorCount: Int`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`, `connectedAccount: ConnectedAccount`.

### `UploadSession`

**Fields:** `id: String`, `userId: String`, `targetConnectedAccountId: String?`, `folderId: String?`, `fileName: String`, `mimeType: String`, `sizeBytes: BigInt`, `status: String`, `googleSessionUri: String?`, `errorMessage: String?`, `createdAt: DateTime`, `completedAt: DateTime?`.

**Relations:** `user: User`, `targetConnectedAccount: ConnectedAccount?`, `folder: Folder?`.

### `AuditLog`

**Fields:** `id: String`, `userId: String?`, `action: String`, `entityType: String`, `entityId: String?`, `metadata: Json?`, `createdAt: DateTime`.

**Relations:** `user: User?`.

### `WorkspaceInvite`

**Fields:** `id: String`, `inviterId: String`, `inviteeEmail: String`, `targetType: String`, `targetId: String`, `role: String`, `status: String`, `revokedAt: DateTime?`, `acceptedAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `inviter: User`.

### `BrowserDevicePairing`

**Fields:** `id: String`, `userId: String`, `codeHash: String`, `expiresAt: DateTime`, `usedAt: DateTime?`, `createdAt: DateTime`.

**Relations:** `user: User`.

### `BrowserDevice`

**Fields:** `id: String`, `userId: String`, `name: String`, `browser: String`, `platform: String`, `extensionVersion: String?`, `deviceTokenHash: String`, `status: String`, `lastSeenAt: DateTime?`, `revokedAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `user: User`, `capturedResources: CapturedResource[]`.

### `CapturedResource`

**Fields:** `id: String`, `browserDeviceId: String`, `userId: String`, `urlEncrypted: String`, `displayUrl: String`, `type: String`, `mimeType: String?`, `filename: String`, `pageUrl: String?`, `pageTitle: String?`, `requestContextEncrypted: String?`, `mediaIdentityTitle: String?`, `mediaIdentitySource: String?`, `mediaIdentityConfidence: Int`, `status: String`, `detectedAt: DateTime`, `expiresAt: DateTime`, `importedAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `device: BrowserDevice`, `user: User`.

### `RemoteFetchWorker`

**Fields:** `id: String`, `name: String`, `slug: String?`, `driver: String`, `endpointUrl: String?`, `isEnabled: Boolean`, `isDefault: Boolean`, `priority: Int?`, `region: String?`, `description: String?`, `authType: String`, `secretEncrypted: String?`, `configEncrypted: String?`, `capabilitiesJson: Json?`, `metadataJson: Json?`, `status: String`, `lastHealthCheckAt: DateTime?`, `lastHealthyAt: DateTime?`, `lastFailedAt: DateTime?`, `lastErrorCode: String?`, `deletedAt: DateTime?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `remoteImports: RemoteImport[]`.

### `TelegramSyncState`

**Fields:** `id: String`, `userId: String`, `connectedAccountId: String`, `lastMessageId: BigInt?`, `lastScanAt: DateTime?`, `status: String`, `errorCode: String?`, `errorMessage: String?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `connectedAccount: ConnectedAccount`.

### `TelegramSyncRun`

**Fields:** `id: String`, `userId: String`, `connectedAccountId: String`, `status: String`, `startedAt: DateTime`, `finishedAt: DateTime?`, `scannedCount: Int`, `matchedCount: Int`, `importedCount: Int`, `missingCount: Int`, `orphanCount: Int`, `conflictCount: Int`, `errorCount: Int`, `errorCode: String?`, `errorMessage: String?`, `createdAt: DateTime`, `updatedAt: DateTime`.

**Relations:** `connectedAccount: ConnectedAccount`.

### `TelegramSyncIssue`

**Fields:** `id: String`, `userId: String`, `runId: String?`, `connectedAccountId: String`, `kind: String`, `telegramFileId: String?`, `fileId: String?`, `detectedAt: DateTime`, `resolvedAt: DateTime?`, `metadata: Json?`.

**Relations:** `connectedAccount: ConnectedAccount`.

## Migration Rule

Do not edit the production database directly as a substitute for a migration. Update the Prisma schema, create a migration, review the SQL, then use the deployment migration command in non-development/production environments.
