import { google } from 'googleapis'
import type { ConnectedAccount, ProviderConfig } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

const googleDriveFolderMimeType = 'application/vnd.google-apps.folder'
const appFolderName = '9drive'

export function createOAuthClient(config: ProviderConfig) {
  return new google.auth.OAuth2(decryptText(config.clientIdEncrypted), decryptText(config.clientSecretEncrypted), config.redirectUri)
}

export async function getAuthedGoogleClient(account: ConnectedAccount) {
  if (!account.accessTokenEncrypted || !account.refreshTokenEncrypted || !account.tokenExpiresAt) throw new Error('Google account tokens are missing.')
  if (!account.providerConfigId) throw new Error('Google provider config is missing.')
  const config = await prisma.providerConfig.findUniqueOrThrow({ where: { id: account.providerConfigId } })
  const client = createOAuthClient(config)
  client.setCredentials({
    access_token: decryptText(account.accessTokenEncrypted),
    refresh_token: decryptText(account.refreshTokenEncrypted),
    expiry_date: account.tokenExpiresAt.getTime(),
  })

  if (account.tokenExpiresAt.getTime() < Date.now() + 60_000) {
    const result = await client.refreshAccessToken()
    const credentials = result.credentials
    if (credentials.access_token) {
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          accessTokenEncrypted: encryptText(credentials.access_token),
          tokenExpiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600_000),
        },
      })
      client.setCredentials(credentials)
    }
  }

  return client
}

export async function syncGoogleQuota(accountId: string) {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const about = await drive.about.get({ fields: 'storageQuota,user' })
  const quota = about.data.storageQuota
  const total = quota?.limit ? BigInt(quota.limit) : null
  const used = quota?.usage ? BigInt(quota.usage) : 0n
  return prisma.storageAccount.upsert({
    where: { connectedAccountId: accountId },
    create: {
      connectedAccountId: accountId,
      totalBytes: total,
      usedBytes: used,
      availableBytes: total === null ? null : total - used,
      trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
      lastSyncedAt: new Date(),
    },
    update: {
      totalBytes: total,
      usedBytes: used,
      availableBytes: total === null ? null : total - used,
      trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
      lastSyncedAt: new Date(),
    },
  })
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function ensureGoogleAppFolder(account: ConnectedAccount) {
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const queryName = escapeDriveQueryValue(appFolderName)
  const existing = await drive.files.list({
    q: `name = '${queryName}' and mimeType = '${googleDriveFolderMimeType}' and 'root' in parents and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 1,
  })
  const folderId = existing.data.files?.[0]?.id ?? (await drive.files.create({
    requestBody: { name: appFolderName, mimeType: googleDriveFolderMimeType, parents: ['root'] },
    fields: 'id',
  })).data.id

  if (!folderId) throw new Error('Failed to create Google Drive app folder.')
  return folderId
}

