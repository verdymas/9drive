import { google } from 'googleapis'
import type { ConnectedAccount, FolderStorageLocation } from '@prisma/client'
import { AppError } from '../../utils/app-error.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder } from '../google/google.service.js'
import { getS3ConfigForAccount } from '../s3/s3.service.js'
import { getTelegramConfig } from '../telegram/telegram.service.js'

/**
 * Provider-agnostic physical folder operations, dispatched by `account.provider`.
 *
 * Virtual folders (the `Folder` tree) no longer own a single physical folder:
 * each virtual folder may have zero-to-many `FolderStorageLocation` rows, one
 * per connected account. This service is the only place that maps those rows
 * to real provider operations:
 *
 * - Google Drive: `providerFolderId` is a Drive folder id; folders are real
 *   Drive objects.
 * - S3: folders are object-key prefixes. `providerFolderId` stores the prefix
 *   for the virtual folder path (e.g. `9drive/Movies/Action`) and is derived
 *   from the virtual path; no real object is ever created for a "folder".
 * - Telegram: the channel is physically flat blob storage (the DB stays the
 *   source of truth for the tree). Folder operations are virtual no-ops; the
 *   `providerFolderId` of a location is the `telegram://channel` root plus the
 *   sanitized virtual path, kept only so location rows stay stable and unique.
 *
 * Never call the Google Drive API directly from routes for folder operations —
 * go through this module so S3 and future providers stay uniform.
 */

const googleDriveFolderMimeType = 'application/vnd.google-apps.folder'

/**
 * Resolve the account's 9Drive root location:
 * - Google: the `9drive` folder under Drive root (find-or-create).
 * - S3: the configured object-key prefix (e.g. `9drive`).
 * - Telegram: the private storage channel id (virtual root).
 */
export async function ensureProviderRoot(account: ConnectedAccount): Promise<string> {
  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id)
    return config.prefix.replace(/^\/+|\/+$/g, '')
  }
  if (account.provider === 'telegram') {
    const config = await getTelegramConfig(account.id)
    return config.channelId ?? 'telegram'
  }
  return ensureGoogleAppFolder(account)
}

/**
 * Create a physical folder under `parentProviderId` (a provider root or a
 * parent folder's `providerFolderId`). Returns the provider folder id.
 *
 * Google: find-by-name-in-parent first (reconciliation — two concurrent
 * materializations must not create duplicate sibling folders), then create.
 * S3: the "folder" is just the joined prefix; nothing is created remotely.
 * Telegram: channel is flat — the "folder" is a stable virtual path suffix.
 */
export async function createProviderFolder(account: ConnectedAccount, name: string, parentProviderId: string): Promise<string> {
  if (account.provider === 's3' || account.provider === 'telegram') {
    return `${parentProviderId.replace(/\/+$/g, '')}/${name.replace(/[/\\]/g, '-')}`
  }

  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const queryName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const existing = await drive.files.list({
    q: `name = '${queryName}' and mimeType = '${googleDriveFolderMimeType}' and '${parentProviderId}' in parents and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 1,
  })
  if (existing.data.files?.[0]?.id) return existing.data.files[0].id

  const created = await drive.files.create({
    requestBody: { name, mimeType: googleDriveFolderMimeType, parents: [parentProviderId] },
    fields: 'id',
  })
  const folderId = created.data.id
  if (!folderId) throw new AppError('FOLDER_PROVIDER_CREATE_FAILED', 'Provider did not return a folder id.', 502)
  return folderId
}

/**
 * Check whether a physical folder still exists on the provider.
 * S3/Telegram: prefixes are virtual — always true.
 */
export async function providerFolderExists(account: ConnectedAccount, providerFolderId: string): Promise<boolean> {
  if (account.provider === 's3' || account.provider === 'telegram') return true
  try {
    const auth = await getAuthedGoogleClient(account)
    await google.drive({ version: 'v3', auth }).files.get({ fileId: providerFolderId, fields: 'id' })
    return true
  } catch {
    return false
  }
}

/**
 * Rename a physical folder. S3/Telegram folder prefixes are derived from the
 * virtual path, never from a stored name — renaming is a no-op there.
 */
export async function renameProviderFolder(account: ConnectedAccount, providerFolderId: string, newName: string): Promise<void> {
  if (account.provider === 's3' || account.provider === 'telegram') return
  try {
    const auth = await getAuthedGoogleClient(account)
    await google.drive({ version: 'v3', auth }).files.update({ fileId: providerFolderId, requestBody: { name: newName } })
  } catch (error: any) {
    throw new AppError('FOLDER_PROVIDER_RENAME_FAILED', 'Provider failed to rename the physical folder.', 502)
  }
}

/**
 * Move a physical folder under `newParentProviderId`. S3/Telegram: no-op
 * (prefixes are derived from the virtual tree on next materialization).
 */
export async function moveProviderFolder(account: ConnectedAccount, providerFolderId: string, newParentProviderId: string): Promise<void> {
  if (account.provider === 's3' || account.provider === 'telegram') return
  try {
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const fileInfo = await drive.files.get({ fileId: providerFolderId, fields: 'parents' })
    const previousParents = fileInfo.data.parents?.join(',')
    await drive.files.update({
      fileId: providerFolderId,
      addParents: newParentProviderId,
      removeParents: previousParents,
      fields: 'id, parents',
    })
  } catch (error: any) {
    throw new AppError('FOLDER_PROVIDER_MOVE_FAILED', 'Provider failed to move the physical folder.', 502)
  }
}

/**
 * Delete a physical folder. S3/Telegram: no-op — folder prefixes have no real
 * object; the objects under the prefix are removed by per-file deletion.
 */
export async function deleteProviderFolder(account: ConnectedAccount, providerFolderId: string): Promise<void> {
  if (account.provider === 's3' || account.provider === 'telegram') return
  try {
    const auth = await getAuthedGoogleClient(account)
    await google.drive({ version: 'v3', auth }).files.delete({ fileId: providerFolderId })
  } catch (error: any) {
    throw new AppError('FOLDER_PROVIDER_DELETE_FAILED', 'Provider failed to delete the physical folder.', 502)
  }
}

/**
 * Resolve the provider parent for an upload into a materialized location:
 * - Google: the Drive folder id.
 * - S3: the location's object-key prefix (already the full virtual path).
 */
export function resolveUploadParent(account: ConnectedAccount, location: Pick<FolderStorageLocation, 'providerFolderId'>): string {
  return location.providerFolderId
}
