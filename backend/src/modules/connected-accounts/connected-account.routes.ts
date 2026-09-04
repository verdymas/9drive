import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText, encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { hashPassword } from '../../utils/password.js'
import { createAuditLog } from '../../utils/audit.js'
import { createOAuthClient, replaceCredentialsAfterReconnect, syncGoogleQuota } from '../google/google.service.js'
import { syncS3Quota, testS3Connection } from '../s3/s3.service.js'
import { deriveTelegramChannelStatus } from '../telegram/telegram.service.js'
import { syncTelegramUsage } from '../telegram/telegram-usage.service.js'

export const connectedAccountRouter = Router()

const s3ConnectSchema = z.object({
  name: z.string().trim().min(1).max(191),
  bucket: z.string().trim().min(1).max(191),
  region: z.string().trim().min(1).max(191),
  endpoint: z.string().url().optional().or(z.literal('')),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional().nullable(),
})

async function syncQuotaForAccount(account: { id: string; provider: string }) {
  if (account.provider === 's3') return syncS3Quota(account.id)
  if (account.provider === 'telegram') return syncTelegramUsage(account.id)
  return syncGoogleQuota(account.id)
}

// Provider credentials are never exposed to the frontend. BigInts are
// stringified; Telegram accounts additionally surface their storage channel.
const accountInclude = {
  storageAccount: true,
  telegramStorageConfig: { select: { channelId: true, channelTitle: true } },
} satisfies Prisma.ConnectedAccountInclude

type AccountWithUsage = Prisma.ConnectedAccountGetPayload<{ include: typeof accountInclude }>

function serializeConnectedAccount(account: AccountWithUsage) {
  const { accessTokenEncrypted: _a, refreshTokenEncrypted: _r, storageAccount, telegramStorageConfig, ...rest } = account
  return {
    ...rest,
    storageAccount: storageAccount ? {
      ...storageAccount,
      totalBytes: storageAccount.totalBytes?.toString() ?? null,
      usedBytes: storageAccount.usedBytes.toString(),
      availableBytes: storageAccount.availableBytes?.toString() ?? null,
      trashBytes: storageAccount.trashBytes?.toString() ?? null,
    } : null,
    telegram: telegramStorageConfig
      ? {
          channelId: telegramStorageConfig.channelId,
          channelTitle: telegramStorageConfig.channelTitle,
          status: deriveTelegramChannelStatus(rest.status, telegramStorageConfig.channelId),
        }
      : null,
  }
}

connectedAccountRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    // Reauth-required accounts stay visible (with their last-known quota) so
    // the UI can surface the reconnect action.
    //
    // `?includeDisconnected=1` additionally lists disconnected accounts.
    // Disconnect is a soft status change: the row keeps its files AND its
    // `providerAccountId` claim — which for Telegram IS the storage channel id.
    // Without this, the account holding an abandoned channel is invisible in
    // Settings while still blocking a fresh connect with a 409. Opt-in so
    // every other consumer (drive layout, quota, upload placement) is
    // unaffected and never offers a dead account as a storage target.
    const includeDisconnected = req.query.includeDisconnected === '1'
    const connectedStatuses = { in: includeDisconnected ? ['connected', 'reauth_required', 'disconnected'] : ['connected', 'reauth_required'] }
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, status: connectedStatuses },
      include: accountInclude,
      orderBy: { createdAt: 'desc' },
    })
    const missingQuota = accounts.filter((account) => !account.storageAccount?.lastSyncedAt)
    for (const account of missingQuota) await syncQuotaForAccount(account).catch(() => undefined)

    const syncedAccounts = missingQuota.length > 0
      ? await prisma.connectedAccount.findMany({
        where: { userId: req.user!.id, status: connectedStatuses },
        include: accountInclude,
        orderBy: { createdAt: 'desc' },
      })
      : accounts

    return res.json({ accounts: syncedAccounts.map(serializeConnectedAccount) })
  } catch (error) {
    return next(error)
  }
})

async function createGoogleConnectUrl(req: AuthRequest) {
  const query = z.object({ providerConfigId: z.string().min(1).optional() }).parse(req.query)
  const config = query.providerConfigId
    ? await prisma.providerConfig.findFirstOrThrow({ where: { id: query.providerConfigId, OR: [{ userId: req.user!.id }, { userId: null }], provider: 'google_drive', status: 'active' } })
    : await prisma.providerConfig.findFirstOrThrow({ where: { userId: null, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } })
  const state = randomToken()
  await prisma.oauthState.create({ data: { userId: req.user!.id, providerConfigId: config.id, flow: 'connect', stateHash: hashToken(state), expiresAt: new Date(Date.now() + 10 * 60_000) } })
  const client = createOAuthClient(config)
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: config.scopes as string[],
    state,
  })
}

connectedAccountRouter.post('/s3', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = s3ConnectSchema.parse(req.body)
    const providerConfig = await prisma.providerConfig.findFirstOrThrow({ where: { provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } })
    const providerAccountId = `${body.bucket}:${body.endpoint || body.region}`
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: req.user!.id, provider: 's3', providerAccountId } } })
    const account = existingAccount
      ? await prisma.connectedAccount.update({
        where: { id: existingAccount.id },
        data: {
          providerConfigId: providerConfig.id,
          email: `${body.bucket} (S3)`,
          displayName: body.name,
          accessTokenEncrypted: encryptText('s3'),
          refreshTokenEncrypted: encryptText(randomToken()),
          tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
          scopes: [],
          status: 'connected',
        },
      })
      : await prisma.connectedAccount.create({ data: {
        userId: req.user!.id,
        providerConfigId: providerConfig.id,
        provider: 's3',
        providerAccountId,
        email: `${body.bucket} (S3)`,
        displayName: body.name,
        accessTokenEncrypted: encryptText('s3'),
        refreshTokenEncrypted: encryptText(randomToken()),
        tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
        scopes: [],
        status: 'connected',
      } })
    const config = await prisma.s3StorageConfig.upsert({
      where: { connectedAccountId: account.id },
      create: {
        userId: req.user!.id,
        connectedAccountId: account.id,
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
      },
      update: {
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
        status: 'active',
      },
    })
    try {
      await testS3Connection(config)
      const quota = await syncS3Quota(account.id)
      return res.status(201).json({
        account: {
          ...account,
          storageAccount: { ...quota, totalBytes: quota.totalBytes?.toString() ?? null, usedBytes: quota.usedBytes.toString(), availableBytes: quota.availableBytes?.toString() ?? null, trashBytes: quota.trashBytes?.toString() ?? null },
        },
      })
    } catch (error) {
      if (!existingAccount) await prisma.connectedAccount.delete({ where: { id: account.id } }).catch(() => undefined)
      throw error
    }
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/connect-url', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/connect', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.redirect(url)
  } catch (error) {
    return next(error)
  }
})

/**
 * Reconnect an EXISTING Google Drive connected account. The account id is
 * bound into the OAuth state server-side (never an unsigned callback
 * parameter); the callback updates the same ConnectedAccount row — no second
 * account is ever created. `prompt=consent` is intentional so Google has an
 * opportunity to issue a fresh refresh token.
 */
connectedAccountRouter.post('/:id/reconnect', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findFirst({
      where: { id: accountId, userId: req.user!.id },
      select: { id: true, provider: true },
    })
    if (!account) throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The storage account does not exist.', 404)
    if (account.provider !== 'google_drive') throw new AppError('INVALID_REQUEST', 'Only Google Drive accounts support reconnect.', 400)

    const config = await prisma.providerConfig.findFirstOrThrow({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
    const state = randomToken()
    await prisma.oauthState.create({
      data: {
        userId: req.user!.id,
        providerConfigId: config.id,
        flow: 'reconnect',
        stateHash: hashToken(state),
        connectedAccountId: account.id,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    })
    const client = createOAuthClient(config)
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: config.scopes as string[],
      state,
    })
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/callback', async (req, res, next) => {
  try {
    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const oauthState = await prisma.oauthState.findUniqueOrThrow({ where: { stateHash: hashToken(query.state) }, include: { providerConfig: true } })
    if (oauthState.usedAt || oauthState.expiresAt < new Date()) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const client = createOAuthClient(oauthState.providerConfig)
    const tokenResult = await client.getToken(query.code)
    const tokens = tokenResult.tokens
    if (!tokens.access_token) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })
    client.setCredentials(tokens)
    const oauth2 = google.oauth2({ version: 'v2', auth: client })
    const profile = await oauth2.userinfo.get()
    const providerAccountId = profile.data.id
    const email = profile.data.email
    if (!providerAccountId || !email) return res.status(400).json({ code: 'GOOGLE_PROFILE_FAILED', message: 'Google profile missing id or email.' })

    if (oauthState.flow === 'login') {
      const name = profile.data.name || email.split('@')[0] || 'Google User'
      const user = await prisma.user.upsert({
        where: { email },
        create: { email, name, passwordHash: await hashPassword(randomToken(32)) },
        update: { name },
      })
      const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } } })
      const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
      if (!refreshTokenEncrypted) {
        console.error('Google login failed: no refresh token received and no existing account. Has refresh_token:', !!tokens.refresh_token)
        return res.redirect(`${env.FRONTEND_URL}/google-auth?status=error`)
      }
      const account = await prisma.connectedAccount.upsert({
        where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } },
        create: {
          userId: user.id,
          providerConfigId: oauthState.providerConfigId,
          provider: 'google_drive',
          providerAccountId,
          email,
          displayName: profile.data.name,
          avatarUrl: profile.data.picture,
          accessTokenEncrypted: encryptText(tokens.access_token),
          refreshTokenEncrypted,
          tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          scopes: oauthState.providerConfig.scopes as string[],
          status: 'connected',
        },
        update: {
          providerConfigId: oauthState.providerConfigId,
          email,
          displayName: profile.data.name,
          avatarUrl: profile.data.picture,
          accessTokenEncrypted: encryptText(tokens.access_token),
          refreshTokenEncrypted,
          tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          scopes: oauthState.providerConfig.scopes as string[],
          status: 'connected',
        },
      })
      await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date(), userId: user.id } })
      await syncGoogleQuota(account.id).catch(() => undefined)
      const handoffToken = randomToken()
      await prisma.authHandoff.create({ data: { userId: user.id, tokenHash: hashToken(handoffToken), expiresAt: new Date(Date.now() + 5 * 60_000) } })
      return res.redirect(`${env.FRONTEND_URL}/google-auth?token=${handoffToken}`)
    }

    if (oauthState.flow === 'reconnect') {
      // Reconnect MUST update the existing account bound in the state — never
      // creates or upserts a new row. Identity is validated against the stored
      // provider account id so a different Google account cannot silently
      // replace the credentials of the originally linked one.
      if (!oauthState.userId || !oauthState.connectedAccountId) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
      const existing = await prisma.connectedAccount.findFirst({
        where: { id: oauthState.connectedAccountId, userId: oauthState.userId, provider: 'google_drive' },
      })
      if (!existing) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
      if (existing.providerAccountId !== providerAccountId) {
        console.info('[google-auth] reconnect_account_mismatch', JSON.stringify({ event: 'google.auth.reconnect_failed', connectedAccountId: existing.id, provider: 'google_drive', oauthErrorCode: 'account_mismatch' }))
        return res.status(400).json({
          code: 'GOOGLE_RECONNECT_ACCOUNT_MISMATCH',
          message: 'You authenticated a different Google account. Reconnect using the same Google Drive account originally linked here.',
        })
      }
      // Reconnect exists because the old refresh token is unusable — a callback
      // without a refresh token must NOT mark the account healthy while keeping
      // the known-invalid token.
      if (!tokens.refresh_token) {
        return res.status(400).json({
          code: 'GOOGLE_OAUTH_REFRESH_TOKEN_MISSING',
          message: 'Google did not return a new refresh token. Reconnect again and grant consent (approve all prompts) when prompted.',
        })
      }
      await replaceCredentialsAfterReconnect(existing.id, {
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted: encryptText(tokens.refresh_token),
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        providerConfigId: oauthState.providerConfigId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        scopes: oauthState.providerConfig.scopes as string[],
      })
      await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })
      await syncGoogleQuota(existing.id).catch(() => undefined)
      console.info('[google-auth] reconnect_succeeded', JSON.stringify({ event: 'google.auth.reconnect_succeeded', connectedAccountId: existing.id, provider: 'google_drive' }))
      return res.redirect(`${env.FRONTEND_URL}/google-connected?status=success`)
    }

    if (oauthState.flow !== 'connect' || !oauthState.userId) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } } })
    const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
    if (!refreshTokenEncrypted) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })

    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } },
      create: {
        userId: oauthState.userId,
        providerConfigId: oauthState.providerConfigId,
        provider: 'google_drive',
        providerAccountId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
      update: {
        providerConfigId: oauthState.providerConfigId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
    })
    await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })
    await syncGoogleQuota(account.id)
    return res.redirect(`${env.FRONTEND_URL}/google-connected?status=success`)
  } catch (error) {
    console.error('Google OAuth callback failed:', error)
    return res.redirect(`${env.FRONTEND_URL}/google-connected?status=error`)
  }
})

connectedAccountRouter.post('/:id/sync-quota', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId: req.user!.id } })
    const quota = await syncQuotaForAccount(account)
    return res.json({
      quota: {
        ...quota,
        totalBytes: quota.totalBytes?.toString() ?? null,
        usedBytes: quota.usedBytes.toString(),
        availableBytes: quota.availableBytes?.toString() ?? null,
        trashBytes: quota.trashBytes?.toString() ?? null,
      },
    })
  } catch (error) {
    // Map GOOGLE_REAUTH_REQUIRED (and other AppErrors) to a proper status so
    // the frontend sees the friendly code + message instead of a raw 500.
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

const updateAccountSchema = z.object({
  autoAllocationEnabled: z.boolean(),
})

/**
 * Update connected-account settings. Currently supports the Auto Allocation
 * placement policy only: `autoAllocationEnabled: false` excludes the account
 * from Automatic new-file routing while manual selection, Sync, quota refresh
 * and existing reads stay unaffected. Ownership is enforced server-side; the
 * returned account is the same safe shape as GET / (no provider credentials).
 */
connectedAccountRouter.patch('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = updateAccountSchema.parse(req.body)
    const accountId = String(req.params.id)
    const existing = await prisma.connectedAccount.findFirst({ where: { id: accountId, userId: req.user!.id } })
    if (!existing) throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The storage account does not exist.', 404)
    const previousValue = existing.autoAllocationEnabled

    const updated = await prisma.connectedAccount.update({
      where: { id: accountId },
      data: { autoAllocationEnabled: body.autoAllocationEnabled },
      include: accountInclude,
    })
    await createAuditLog(req.user!.id, body.autoAllocationEnabled ? 'storage.auto_allocation.enabled' : 'storage.auto_allocation.disabled', 'connected_account', accountId, {
      connectedAccountId: accountId,
      provider: existing.provider,
      previousValue,
      newValue: body.autoAllocationEnabled,
    })

    return res.json({ account: serializeConnectedAccount(updated) })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

connectedAccountRouter.delete('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    await prisma.connectedAccount.updateMany({ where: { id: accountId, userId: req.user!.id }, data: { status: 'disconnected' } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
