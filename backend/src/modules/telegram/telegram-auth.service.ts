import type { ConnectedAccount, TelegramAuthState } from '@prisma/client'
import type { TelegramClient } from 'teleproto'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { classifyTelegramError, serializeTelegramAccount, telegramDisplayName } from './telegram.service.js'
import { syncTelegramUsage } from './telegram-usage.service.js'

/**
 * Telegram auth wizard (phone → OTP → optional 2FA) that ends with an
 * encrypted `StringSession` stored on the account's `TelegramStorageConfig`.
 *
 * State lives in a short-lived `TelegramAuthState` row (encrypted creds +
 * intermediate session + phone_code_hash). Reconnecting an existing account
 * only refreshes the session; the configured storage channel is preserved.
 *
 * The wizard is decoupled from storage-channel setup: connecting never
 * creates or resolves a channel. A fresh connect creates the account in a
 * "storage channel required" state (pending placeholder) and the user picks
 * "create new / use existing" explicitly afterwards.
 *
 * Sessions/codes/passwords are never returned to the client and never logged.
 */
const AUTH_STATE_TTL_MS = 15 * 60_000

async function loadTelegram() {
  return import('teleproto')
}

type ApiCredentials = { apiId: number; apiHash: string }

function buildClient(session: string, credentials: ApiCredentials): Promise<TelegramClient> {
  return loadTelegram().then((telegram) => new telegram.TelegramClient(new telegram.sessions.StringSession(session), credentials.apiId, credentials.apiHash, {}) as TelegramClient)
}

async function sessionString(client: TelegramClient): Promise<string> {
  return String((client.session as unknown as { save(): string }).save())
}

/**
 * Step 1 — request a login code for `phone`, persisting an intermediate state.
 *
 * Two entry points:
 * - Fresh connect: `apiId` + `apiHash` (from the wizard form) + `phone`. A new
 *   `TelegramAuthState` row is created with no `connectedAccountId`; the
 *   account row is created only after a successful verify.
 * - Reconnect: `accountId` (stored creds are reused; the session is refreshed).
 *   Optional `apiId`/`apiHash` override the stored credentials when provided.
 */
export async function startTelegramAuth(input: { userId: string; accountId?: string; phone: string; apiId?: number | string; apiHash?: string }) {
  const phone = input.phone.trim()
  let credentials: ApiCredentials

  if (input.accountId) {
    const existing = await prisma.telegramStorageConfig.findFirst({
      where: { connectedAccountId: input.accountId, userId: input.userId },
    })
    if (!existing) throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The Telegram storage account does not exist.', 404)
    credentials =
      input.apiId !== undefined && input.apiHash
        ? { apiId: Number(input.apiId), apiHash: input.apiHash.trim() }
        : { apiId: Number(decryptText(existing.apiIdEncrypted)), apiHash: decryptText(existing.apiHashEncrypted) }
  } else {
    if (input.apiId === undefined || !input.apiHash?.trim()) {
      throw new AppError('INVALID_REQUEST', 'Telegram API ID and API Hash are required to start a login.', 400)
    }
    credentials = { apiId: Number(input.apiId), apiHash: input.apiHash.trim() }
  }
  if (!Number.isInteger(credentials.apiId) || credentials.apiId <= 0) {
    throw new AppError('INVALID_REQUEST', 'Telegram API ID must be a positive integer.', 400)
  }
  if (!phone) throw new AppError('INVALID_REQUEST', 'Enter your Telegram phone number.', 400)

  const client = await buildClient('', credentials)
  try {
    await client.connect()
    const result = await client.sendCode(credentials, phone)
    const phoneCodeHash = (result as { phoneCodeHash?: string }).phoneCodeHash
    if (!phoneCodeHash) throw new AppError('TELEGRAM_CREDENTIALS_INVALID', 'Telegram did not issue a login code hash.', 400)
    const intermediateSession = await sessionString(client)

    let state: TelegramAuthState
    if (input.accountId) {
      const local = await prisma.telegramAuthState.upsert({
        where: { id: input.accountId },
        create: {
          id: input.accountId,
          userId: input.userId,
          connectedAccountId: input.accountId,
          apiIdEncrypted: encryptText(String(credentials.apiId)),
          apiHashEncrypted: encryptText(credentials.apiHash),
          phoneEncrypted: encryptText(phone),
          codeHashEncrypted: encryptText(phoneCodeHash),
          sessionEncrypted: encryptText(intermediateSession),
          expiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS),
        },
        update: {
          userId: input.userId,
          connectedAccountId: input.accountId,
          apiIdEncrypted: encryptText(String(credentials.apiId)),
          apiHashEncrypted: encryptText(credentials.apiHash),
          phoneEncrypted: encryptText(phone),
          codeHashEncrypted: encryptText(phoneCodeHash),
          sessionEncrypted: encryptText(intermediateSession),
          step: 'awaiting_code',
          expiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS),
        },
      })
      state = local
    } else {
      state = await prisma.telegramAuthState.create({
        data: {
          userId: input.userId,
          step: 'awaiting_code',
          apiIdEncrypted: encryptText(String(credentials.apiId)),
          apiHashEncrypted: encryptText(credentials.apiHash),
          phoneEncrypted: encryptText(phone),
          codeHashEncrypted: encryptText(phoneCodeHash),
          sessionEncrypted: encryptText(intermediateSession),
          expiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS),
        },
      })
    }
    return { authId: state.id, nextStep: 'code' }
  } catch (error) {
    throw classifyTelegramError(error)
  } finally {
    client.disconnect().catch(() => undefined)
  }
}

/**
 * Step 2 (OTP) / Step 3 (2FA password). On success finalizes the connected
 * account and returns `{ nextStep: 'done', account }`.
 */
export async function verifyTelegramAuth(userId: string, authId: string, input: { code?: string; password?: string }) {
  const state = await prisma.telegramAuthState.findFirst({ where: { id: authId, userId } })
  if (!state) throw new AppError('TELEGRAM_AUTH_EXPIRED', 'This Telegram login session has expired. Start again.', 400)
  if (state.expiresAt < new Date()) {
    await prisma.telegramAuthState.delete({ where: { id: state.id } }).catch(() => undefined)
    throw new AppError('TELEGRAM_AUTH_EXPIRED', 'This Telegram login session has expired. Start again.', 400)
  }

  const credentials: ApiCredentials = {
    apiId: Number(decryptText(state.apiIdEncrypted)),
    apiHash: decryptText(state.apiHashEncrypted),
  }
  const client = await buildClient(decryptText(state.sessionEncrypted), credentials)
  try {
    await client.connect()

    if (input.password && !input.code) {
      await client.signInWithPassword(credentials, { password: () => Promise.resolve(input.password!), onError: () => undefined })
    } else if (input.code) {
      const phone = decryptText(state.phoneEncrypted ?? '')
      const codeHash = decryptText(state.codeHashEncrypted ?? '')
      if (!phone || !codeHash) throw new AppError('TELEGRAM_AUTH_EXPIRED', 'Telegram login session is incomplete. Start again.', 400)
      try {
        const telegram = await loadTelegram()
        await client.invoke(new telegram.Api.auth.SignIn({ phoneNumber: phone, phoneCode: input.code, phoneCodeHash: codeHash }))
      } catch (error) {
        if ((error as { name?: string }).name === 'SessionPasswordNeededError') {
          await prisma.telegramAuthState.update({ where: { id: state.id }, data: { step: 'awaiting_password', sessionEncrypted: encryptText(await sessionString(client)) } })
          return { nextStep: 'password' }
        }
        throw error
      }
    } else {
      throw new AppError('INVALID_REQUEST', 'Enter the Telegram OTP code.', 400)
    }

    const session = await sessionString(client)
    return { nextStep: 'done' as const, ...(await finalizeTelegramAuth(userId, state, credentials, session, client)) }
  } catch (error) {
    throw classifyTelegramError(error)
  } finally {
    client.disconnect().catch(() => undefined)
  }
}

async function finalizeTelegramAuth(
  userId: string,
  state: Pick<TelegramAuthState, 'id' | 'connectedAccountId' | 'phoneEncrypted'>,
  credentials: ApiCredentials,
  session: string,
  // ponytail: no getMe() identity check on Telegram reconnect — deliberate, it is
  // what lets an abandoned channel be recovered with a different login. Add one
  // (like GOOGLE_RECONNECT_ACCOUNT_MISMATCH) only alongside a stored Telegram
  // user id AND an explicit "recover with different account" opt-in.
  _client: TelegramClient,
) {
  let account: ConnectedAccount | null = null
  let previousChannelId: string | null | undefined
  let previousChannelTitle: string | null | undefined

  if (state.connectedAccountId) {
    // Reconnect: reuse the existing account row, keep its configured storage
    // channel intact, and only clear reauth markers. The session is refreshed
    // below; the channel is never re-resolved or re-created here.
    const existing = await prisma.connectedAccount.findFirst({ where: { id: state.connectedAccountId, userId } })
    if (existing) {
      const existingConfig = await prisma.telegramStorageConfig.findFirst({ where: { connectedAccountId: existing.id } })
      previousChannelId = existingConfig?.channelId
      previousChannelTitle = existingConfig?.channelTitle
      // Reconnect relabels the account too: the new login may belong to a
      // different number (abandoned-channel recovery) so the UI's only identity
      // cue must follow the active session, not the row's birth-time label.
      const reconnectPhone = state.phoneEncrypted ? decryptText(state.phoneEncrypted) : null
      account = await prisma.connectedAccount.update({
        where: { id: existing.id },
        data: {
          status: 'connected',
          reauthRequiredAt: null,
          lastAuthErrorCode: null,
          lastError: null,
          displayName: telegramDisplayName(reconnectPhone, previousChannelTitle ?? null),
        },
      })
    }
  }

  if (!account) {
    // Fresh connect: create the account WITHOUT a storage channel. The channel
    // is configured explicitly in a later step ("Create new / Use existing").
    // A unique pending placeholder satisfies the (userId, provider,
    // providerAccountId) unique constraint until the real channel id is set.
    const created = await prisma.connectedAccount.create({
      data: {
        userId,
        provider: 'telegram',
        providerAccountId: 'pending', // replaced with the channel id during channel setup
        email: 'telegram@pending',
        displayName: telegramDisplayName(
          state.phoneEncrypted ? decryptText(state.phoneEncrypted) : null,
          null,
        ),
        scopes: [],
        status: 'connected',
      },
    })
    account = await prisma.connectedAccount.update({
      where: { id: created.id },
      data: { providerAccountId: `pending:${created.id}` },
    })
  }

  await prisma.telegramStorageConfig.upsert({
    where: { connectedAccountId: account.id },
    create: {
      userId,
      connectedAccountId: account.id,
      name: 'Telegram Drive',
      apiIdEncrypted: encryptText(String(credentials.apiId)),
      apiHashEncrypted: encryptText(credentials.apiHash),
      sessionEncrypted: encryptText(session),
      phoneEncrypted: state.phoneEncrypted ?? null,
      channelId: null,
      channelTitle: null,
    },
    update: {
      apiIdEncrypted: encryptText(String(credentials.apiId)),
      apiHashEncrypted: encryptText(credentials.apiHash),
      sessionEncrypted: encryptText(session),
      // Refresh the stored phone: reconnect is also when the number changes
      // (different login). If a prior reconnect left no phone behind, preserve null.
      ...(state.phoneEncrypted ? { phoneEncrypted: state.phoneEncrypted } : {}),
      // Preserve an already-configured channel across reconnects.
      ...(previousChannelId
        ? { channelId: previousChannelId, ...(previousChannelTitle ? { channelTitle: previousChannelTitle } : {}) }
        : {}),
    },
  })

  await prisma.telegramAuthState.deleteMany({ where: { id: state.id } }).catch(() => undefined)
  await syncTelegramUsage(account.id).catch(() => undefined)
  await createAuditLog(userId, state.connectedAccountId ? 'telegram.reconnect' : 'telegram.connect', 'connected_account', account.id, {
    ...(previousChannelId ? { channelId: previousChannelId } : {}),
  })

  return { account: await serializeTelegramAccount(userId, account.id) }
}

/** Load a ConnectedAccount by id enforcing ownership; used by test/status routes. */
export async function getOwnedTelegramAccount(userId: string, accountId: string): Promise<ConnectedAccount> {
  const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, userId, provider: 'telegram' } })
  if (!account) throw new AppError('STORAGE_ACCOUNT_NOT_FOUND', 'The Telegram storage account does not exist.', 404)
  return account
}