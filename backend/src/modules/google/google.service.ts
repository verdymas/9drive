import { google } from 'googleapis'
import type { ConnectedAccount, ProviderConfig } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

const googleDriveFolderMimeType = 'application/vnd.google-apps.folder'
const appFolderName = '9drive'

export function createOAuthClient(config: ProviderConfig) {
  return new google.auth.OAuth2(decryptText(config.clientIdEncrypted), decryptText(config.clientSecretEncrypted), config.redirectUri)
}

/** True when the account's Google credentials are unusable until reconnected. */
export function isReauthEffective(account: Pick<ConnectedAccount, 'provider' | 'status'>): boolean {
  return account.provider === 'google_drive' && account.status === 'reauth_required'
}

const REAUTH_MESSAGE = 'This Google Drive account needs to be reconnected before it can be used.'

/**
 * Classify a Google OAuth token-refresh failure. Only a structured
 * `invalid_grant` is permanent (requires user reauthorization); everything
 * else — HTTP 429/5xx, network resets, timeouts — stays retryable and must
 * never mark the account. Configuration errors (`invalid_client`, …) are not
 * reauth either: reconnecting cannot fix them.
 */
export function classifyOAuthRefreshError(err: unknown): 'invalid_grant' | 'transient' | 'unknown' {
  const e = err as { response?: { status?: number; data?: { error?: string; error_description?: string } } | string; code?: string | number; message?: string }
  const status = Number(e?.response && typeof e.response === 'object' ? e.response.status : 0)
  const data = e?.response && typeof e.response === 'object' ? e.response.data : undefined
  if (status >= 400 && status < 500) {
    // Structured code first — never classify arbitrary message fragments when
    // a structured error field is available.
    const code = data?.error ?? ''
    const description = data?.error_description ?? ''
    if (code === 'invalid_grant' || description.startsWith('invalid_grant') || code.startsWith('invalid_grant:')) return 'invalid_grant'
    // HTTP 429 is the only retryable 4xx class; other client errors are
    // configuration or protocol problems that reconnect cannot fix.
    if (status === 429) return 'transient'
    return 'unknown'
  }
  if ((status >= 500 && status <= 599) || status === 0) return 'transient'
  if (e?.code === 'ECONNRESET' || e?.code === 'ETIMEDOUT') return 'transient'
  // Fallback for libraries that surface only the message (e.g. googleapis'
  // GoogleAuthError `message` starts with the oauth error code).
  const message = e?.message ?? ''
  if (message.startsWith('invalid_grant')) return 'invalid_grant'
  return 'unknown'
}

/**
 * Idempotently mark a Google Drive account REAUTH_REQUIRED (Google only —
 * S3 rows share the model but can never reach this state). Never touches the
 * saved `autoAllocationEnabled` preference or any token columns. Safe to call
 * from ten concurrent failures: the `updateMany` CAS admits exactly one
 * transition.
 */
export async function markReauthRequired(accountId: string, reason?: string): Promise<void> {
  const affected = await prisma.connectedAccount.updateMany({
    where: { id: accountId, provider: 'google_drive', status: { not: 'reauth_required' } },
    data: {
      status: 'reauth_required',
      reauthRequiredAt: new Date(),
      lastAuthErrorCode: 'GOOGLE_OAUTH_INVALID_GRANT',
      lastError: reason ? reason.slice(0, 1000) : null,
    },
  })
  if (affected.count > 0) {
    console.info('[google-auth] reauth_required', JSON.stringify({ event: 'google.auth.reauth_required', connectedAccountId: accountId, provider: 'google_drive', oauthErrorCode: 'invalid_grant', authStateTransition: 'connected->reauth_required' }))
  }
}

/**
 * Refresh the account's Google access token under a per-account single-flight
 * mutex. Concurrent callers wait for the in-flight refresh and reuse its
 * result instead of stampeding Google's token endpoint. The fresh account row
 * is re-read after acquiring the lock, so a caller holding a stale object
 * still observes a concurrent invalid_grant transition and fails fast with
 * `GOOGLE_REAUTH_REQUIRED` instead of retrying the invalid refresh token.
 */
const refreshInFlight = new Map<string, Promise<ConnectedAccount>>()

export async function refreshAccessToken(account: ConnectedAccount): Promise<ConnectedAccount> {
  const accountId = account.id

  // Single-flight: a caller that finds an in-flight refresh adopts its exact
  // outcome (fresh account on success, GOOGLE_REAUTH_REQUIRED on invalid_grant,
  // GOOGLE_OAUTH_REFRESH_FAILED on transient errors) — never starts a second
  // Google refresh. The get→set window is atomic: both are synchronous, so
  // simultaneous callers cannot both see an empty map.
  const inFlight = refreshInFlight.get(accountId)
  if (inFlight) return inFlight

  const attempt = runRefresh(accountId)
  refreshInFlight.set(accountId, attempt)
  try {
    return await attempt
  } finally {
    refreshInFlight.delete(accountId)
  }
}

async function runRefresh(accountId: string): Promise<ConnectedAccount> {
    // Never trust the caller's possibly-stale object for the status transition.
    const fresh = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
    if (isReauthEffective(fresh)) throw new AppError('GOOGLE_REAUTH_REQUIRED', REAUTH_MESSAGE, 401)
    if (!fresh.accessTokenEncrypted || !fresh.refreshTokenEncrypted) {
      throw new AppError('GOOGLE_OAUTH_REFRESH_TOKEN_MISSING', 'Google Drive refresh token is missing.', 500)
    }
    if (!fresh.providerConfigId) throw new AppError('GOOGLE_OAUTH_REFRESH_TOKEN_MISSING', 'Google provider config is missing.', 500)

    const config = await prisma.providerConfig.findUniqueOrThrow({ where: { id: fresh.providerConfigId } })
    const client = createOAuthClient(config)
    client.setCredentials({ refresh_token: decryptText(fresh.refreshTokenEncrypted) })

    let credentials: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }
    try {
      const result = await client.refreshAccessToken()
      credentials = result.credentials
    } catch (error) {
      const kind = classifyOAuthRefreshError(error)
      if (kind === 'invalid_grant') {
        await markReauthRequired(accountId, error instanceof Error ? error.message : undefined)
        throw new AppError('GOOGLE_REAUTH_REQUIRED', REAUTH_MESSAGE, 401)
      }
      console.error('[google-auth] refresh_failed', JSON.stringify({
        event: 'google.auth.refresh_failed',
        connectedAccountId: accountId,
        provider: 'google_drive',
        oauthErrorCode: kind === 'transient' ? 'transient' : 'unknown',
        operation: 'refreshAccessToken',
      }))
      throw new AppError('GOOGLE_OAUTH_REFRESH_FAILED', 'Google OAuth token refresh failed.', 503)
    }

    if (!credentials.access_token) {
      throw new AppError('GOOGLE_OAUTH_REFRESH_FAILED', 'Google OAuth token refresh returned no access token.', 503)
    }

    // Persist the new access token + expiry. A refresh response may omit a new
    // refresh token — never overwrite the stored one with null/undefined.
    const data: {
      accessTokenEncrypted: string
      tokenExpiresAt: Date
      refreshTokenEncrypted?: string
    } = {
      accessTokenEncrypted: encryptText(credentials.access_token),
      tokenExpiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600_000),
    }
    if (credentials.refresh_token) {
      data.refreshTokenEncrypted = encryptText(credentials.refresh_token)
      console.info('[google-auth] refresh_succeeded', JSON.stringify({ event: 'google.auth.refresh_succeeded', connectedAccountId: accountId, provider: 'google_drive', rotatedRefreshToken: true }))
    }
    return prisma.connectedAccount.update({ where: { id: accountId }, data })
}

/**
 * Authoritative Google client factory — every Google Drive operation in the
 * codebase obtains its client through this function.
 *
 * - Accounts in REAUTH_REQUIRED state fail fast with `GOOGLE_REAUTH_REQUIRED`
 *   (no repeated attempts against Google's token endpoint).
 * - Near-expiry access tokens are refreshed under the single-flight mutex.
 * - The client is always built from the freshly persisted credentials.
 */
export async function getAuthedGoogleClient(account: ConnectedAccount) {
  if (isReauthEffective(account)) throw new AppError('GOOGLE_REAUTH_REQUIRED', REAUTH_MESSAGE, 401)
  if (!account.accessTokenEncrypted || !account.refreshTokenEncrypted || !account.tokenExpiresAt) throw new Error('Google account tokens are missing.')
  if (!account.providerConfigId) throw new Error('Google provider config is missing.')

  let freshAccount = account
  if (account.tokenExpiresAt.getTime() < Date.now() + 60_000) {
    freshAccount = await refreshAccessToken(account)
  }

  if (!freshAccount.accessTokenEncrypted || !freshAccount.refreshTokenEncrypted || !freshAccount.tokenExpiresAt) throw new Error('Google account tokens are missing.')
  if (!freshAccount.providerConfigId) throw new Error('Google provider config is missing.')
  const config = await prisma.providerConfig.findUniqueOrThrow({ where: { id: freshAccount.providerConfigId } })
  const client = createOAuthClient(config)
  client.setCredentials({
    access_token: decryptText(freshAccount.accessTokenEncrypted),
    refresh_token: decryptText(freshAccount.refreshTokenEncrypted),
    expiry_date: freshAccount.tokenExpiresAt!.getTime(),
  })

  return client
}

/** Replace credentials after a successful validated reconnect (update only — never creates an account). */
export async function replaceCredentialsAfterReconnect(
  accountId: string,
  data: {
    accessTokenEncrypted: string
    refreshTokenEncrypted: string
    tokenExpiresAt: Date
    providerConfigId: string
    email: string
    displayName: string | null | undefined
    avatarUrl: string | null | undefined
    scopes: string[]
  },
) {
  return prisma.connectedAccount.update({
    where: { id: accountId },
    data: {
      ...data,
      status: 'connected',
      reauthRequiredAt: null,
      lastAuthErrorCode: null,
      lastError: null,
    },
  })
}

export async function syncGoogleQuota(accountId: string) {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
  if (isReauthEffective(account)) throw new AppError('GOOGLE_REAUTH_REQUIRED', REAUTH_MESSAGE, 401)
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