import type { ConnectedAccount, File, TelegramStorageConfig } from '@prisma/client'
import type { Response } from 'express'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { decryptText } from '../../utils/crypto.js'
import type { TelegramClient } from 'teleproto'

type TelegramConfig = TelegramStorageConfig & { connectedAccount: ConnectedAccount }
type ConnectionConfig = CredentialsSource & { channelId?: string | null }
type CredentialsSource = Pick<TelegramStorageConfig, 'apiIdEncrypted' | 'apiHashEncrypted' | 'sessionEncrypted'>
type StreamOptions = { disposition?: 'inline' | 'attachment' }
type FileWithAccount = File & { connectedAccount: ConnectedAccount }

/** Status vocabulary for the Telegram storage channel (spec §14). */
export type TelegramChannelStatus =
  | 'connected'
  | 'storage_channel_required'
  | 'storage_channel_invalid'
  | 'storage_channel_read_only'
  | 'authentication_required'
  | 'ready'
  | 'error'

export type TelegramConnectionTest = {
  ok: boolean
  status: TelegramChannelStatus
  checks: {
    account: boolean
    channel: boolean | null // null = not configured yet
    read: boolean | null
    write: boolean | null
    delete: boolean | null
  }
  details?: string
}

/**
 * Telegram Drive — MTProto (teleproto, a GramJS-compatible client) storage
 * provider.
 *
 * Telegram is used strictly as private blob storage in a user-owned private
 * channel. No chats / contacts / messaging are exposed. One short-lived client
 * per operation, built from the per-user encrypted `StringSession`, disconnected
 * in `finally`.
 *
 * Remote identities are `telegram://<channelId>/<messageId>` stored in
 * `File.providerFileId`. The database (Files/Folders) remains the source of
 * truth for the virtual tree; the channel is physically flat.
 *
 * The storage channel is NEVER chosen implicitly: every storage operation uses
 * the channel persisted on the account config, and fails with
 * `TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED` when none is configured. Saved
 * Messages / personal chats / groups are never used as storage destinations.
 */

const TELEGRAM_REMOTE_PREFIX = 'telegram://'

export function buildTelegramRemoteId(channelId: string | number, messageId: number | string) {
  return `${TELEGRAM_REMOTE_PREFIX}${channelId}/${messageId}`
}

export function parseTelegramRemoteId(remoteId: string): { channelId: string; messageId: number } {
  if (!remoteId.startsWith(TELEGRAM_REMOTE_PREFIX)) {
    throw new AppError('TELEGRAM_FILE_INVALID', 'The Telegram document reference is invalid.', 400)
  }
  const [, body = ''] = remoteId.split(TELEGRAM_REMOTE_PREFIX)
  const [channelId, messageIdText] = body.split('/')
  const messageId = Number(messageIdText)
  if (!channelId || !Number.isInteger(messageId) || messageId <= 0) {
    throw new AppError('TELEGRAM_FILE_INVALID', 'The Telegram document reference is invalid.', 400)
  }
  return { channelId, messageId }
}

/** Normalize whatever id Telegram returned to the `-100...` string form used in `telegram://`. */
export function normalizeChannelId(id: unknown): string {
  if (id === undefined || id === null) throw new AppError('TELEGRAM_CHANNEL_UNAVAILABLE', 'Telegram did not return a channel id.', 502)
  // teleproto returns channel ids as a BigInteger wrapper (or a plain string/
  // number for raw variants). String() covers all of them via toString().
  if (typeof id === 'string') return id
  return String(id)
}

/**
 * Hard failure when no storage channel is configured. Never silently fall back
 * to Saved Messages or another chat (spec §5, Test 5).
 */
export function storageTargetNotConfigured(): AppError {
  return new AppError(
    'TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED',
    'No Telegram storage channel is configured for this account. Create or select a storage channel first.',
    409,
  )
}

/** Assert a configured channel id exists; returns it or throws `TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED`. */
export function assertChannelConfigured(channelId: string | null | undefined): string {
  if (!channelId || !channelId.trim()) throw storageTargetNotConfigured()
  return channelId
}

/**
 * Structural check for a usable storage channel entity.
 *
 * Only broadcast channels qualify as storage. Teleproto returns raw TL
 * entities: an `Api.Channel` carries the `megagroup`/`broadcast` flags and a
 * POSITIVE raw id (the `-100…` form is only a lookup convention, see
 * `channelLookupCandidates`). Users and basic-group `Api.Chat` objects carry
 * neither flag and can never match; Saved Messages ("self") is a user.
 */
export function isStorageChannelCandidate(entity: unknown): boolean {
  if (!entity || typeof entity !== 'object') return false
  const e = entity as { id?: unknown; title?: unknown; megagroup?: unknown; broadcast?: unknown }
  if (typeof e.title !== 'string' || e.title.trim() === '') return false
  // Only channels carry these boolean flags — users and basic groups lack both.
  if (typeof e.megagroup !== 'boolean' && typeof e.broadcast !== 'boolean') return false
  if (e.megagroup === true) return false
  if (e.broadcast === false) return false
  return e.id !== undefined && e.id !== null
}

/**
 * Lookup candidates for a stored channel id. Teleproto's Bot-API-style
 * convention makes a bare POSITIVE id resolve as a `PeerUser` — it is the raw
 * channel id whose marked peer form is `-100<id>`. The marked form is always
 * tried first so `channels.getChannels` (access hash 0) can resolve the
 * account's own channels in a fresh session with an empty entity cache; the
 * bare id is kept as a fallback for cache hits on already-cached entities.
 */
export function channelLookupCandidates(channelId: string | null | undefined): string[] {
  const id = assertChannelConfigured(channelId)
  if (id.startsWith('-')) return [id]
  if (/^\d+$/.test(id)) return [`-100${id}`, id]
  return [id]
}

/**
 * Derive the channel status shown by account serializers. Live `ready` /
 * `error` come from the connection test endpoint; this covers the derived
 * states (spec §14).
 */
export function deriveTelegramChannelStatus(accountStatus: string, channelId: string | null | undefined): TelegramChannelStatus {
  if (accountStatus === 'reauth_required') return 'authentication_required'
  if (!channelId) return 'storage_channel_required'
  return 'connected'
}

/**
 * Display label for a Telegram login phone: country prefix + last 4 digits,
 * never the full number. Short inputs are masked aggressively (we only need
 * enough for a user to tell two of their own accounts apart).
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  if (digits.length <= 7) return `•••${digits.slice(-2)}`
  return `${digits.slice(0, 3)}${'•'.repeat(digits.length - 7)}${digits.slice(-4)}`
}

/** Account label: masked phone (or generic placeholder), plus channel title when one is configured. */
export function telegramDisplayName(phone: string | null, channelTitle: string | null): string {
  const left = phone ? maskPhone(phone) : 'Telegram Drive'
  return channelTitle ? `${left} · ${channelTitle}` : left
}

/**
 * Classify a teleproto/Telegram thrown error into an AppError with a stable
 * code, user-friendly message and HTTP status. Handles FloodWait, revoked/
 * expired/unregistered sessions, invalid credentials, and lookup failures.
 * AppErrors pass through unchanged.
 *
 * Teleproto/GramJS errors are inconsistent in shape: typed errors carry a
 * `name` (e.g. `FloodWaitError`), while RPC rejections surface as plain
 * objects with `code` + `message`/`errorMessage` (e.g. `AUTH_KEY_UNREGISTERED`
 * with code 401). The classifier inspects all of these, and the fallback
 * preserves the raw error text so a failure is never reduced to an opaque
 * "retry" message.
 */
export function classifyTelegramError(error: unknown): AppError {
  if (error instanceof AppError) return error

  const raw = error as {
    name?: string
    code?: number | string
    errorCode?: number | string
    seconds?: number | string
    message?: string
    errorMessage?: string
  }
  const name = raw?.name ?? ''
  const message = String(raw?.message ?? raw?.errorMessage ?? error ?? 'Unknown Telegram error')
  const code = typeof raw?.code === 'number' ? raw.code : typeof raw?.errorCode === 'number' ? raw.errorCode : undefined

  // FloodWait — retryable 429. `seconds` may be a number or a numeric string.
  if (name === 'FloodWaitError' || /FloodWait|FLOOD_WAIT/i.test(message)) {
    const waitSeconds = Number(raw?.seconds)
    const capped = Number.isFinite(waitSeconds) && waitSeconds > 0 ? Math.ceil(waitSeconds) : 60
    return new AppError('TELEGRAM_FLOOD_WAIT', `Telegram requested a temporary wait. Retry after ${capped} seconds.`, 429)
  }

  // Revoked/expired/unregistered sessions and auth-key rejections. These come
  // back as 401/403 RPC errors whose `name` is generic, so detect by code and
  // message text as well as by the typed error classes. 401 is always an auth
  // rejection; 403 only when the message/name says so (403 also covers channel
  // privacy / banned rights, which the branches below classify more precisely).
  const authRejectionText =
    /AUTH_KEY_(UNREGISTERED|INVALID|OLD|DROP)|SESSION_(REVOKED|EXPIRED|REVERSED)|Unauthorized|unauthorized|auth key (unregistered|expired|invalid)|ACTIVE_USER_REQUIRED|USER_DEACTIVATED|AUTH_RESTART|AUTH_KEY_PERM_EMPTY/i
  if (
    name === 'SessionRevokedError' ||
    name === 'SessionExpiredError' ||
    name === 'UnauthorizedError' ||
    name === 'AuthKeyUnregisteredError' ||
    code === 401 ||
    (code === 403 && authRejectionText.test(message))
  ) {
    return new AppError('TELEGRAM_SESSION_INVALID', 'The Telegram session is invalid or has been revoked. Reconnect this account.', 401)
  }

  if (name === 'ApiIdInvalidError' || name === 'ApiIdPublishedFloodError' || /API_ID_INVALID|API_ID_PUBLISHED_FLOOD/i.test(message)) {
    return new AppError('TELEGRAM_CREDENTIALS_INVALID', 'The Telegram API ID or API Hash is invalid.', 400)
  }

  if (/CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID|channel is no longer available|not found in the/i.test(message)) {
    return new AppError('TELEGRAM_CHANNEL_UNAVAILABLE', 'The Telegram storage channel is no longer available.', 410)
  }

  if (/MEDIA_EMPTY|document was not found|message_id_invalid|MESSAGE_ID_INVALID|document not found/i.test(message)) {
    return new AppError('TELEGRAM_FILE_NOT_FOUND', 'The Telegram document could not be found.', 404)
  }

  if (/FILE_PART_|FILE_PARTS_|Upload|upload|media invalid|MEDIA_INVALID|image process|file too big|FILE_TOO_BIG/i.test(message)) {
    return new AppError('TELEGRAM_UPLOAD_FAILED', `The Telegram upload failed. ${message.slice(0, 200)}`, 502)
  }

  if (/NETWORK|TIMEOUT|Connection|connect|ECONN|socket/i.test(message)) {
    return new AppError('TELEGRAM_NETWORK', `Could not reach Telegram. Retry shortly. (${message.slice(0, 200)})`, 503)
  }

  // Unknown failure: keep the raw error text so logs and the user surface show
  // the actual cause instead of an opaque retry hint.
  return new AppError('TELEGRAM_UPLOAD_FAILED', `A Telegram storage operation failed. ${message.slice(0, 200)}`, 502)
}

async function loadTelegram() {
  // Lazy so startup stays cheap and unit tests mock this module boundary.
  return import('teleproto')
}

export async function getTelegramConfig(accountId: string, userId?: string) {
  return prisma.telegramStorageConfig.findFirstOrThrow({
    where: { connectedAccountId: accountId, ...(userId ? { userId } : {}) },
    include: { connectedAccount: true },
  })
}

/**
 * Safe account serializer shared by the auth wizard, the channel setup flow
 * and (via the connected-account routes) the account list. Provider
 * credentials are never exposed; Telegram usage is indexed-only
 * (totalBytes/availableBytes always null); the storage channel and its
 * derived status are included.
 */
export async function serializeTelegramAccount(userId: string, accountId: string) {
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: accountId, userId },
    include: { storageAccount: true, telegramStorageConfig: { select: { channelId: true, channelTitle: true } } },
  })
  const { accessTokenEncrypted: _a, refreshTokenEncrypted: _r, telegramStorageConfig, storageAccount, ...rest } = account

  // Pull the latest synchronization state + open-issue count so the UI
  // can render the "Last sync / Status / Issues" card without an extra
  // round-trip to /telegram/accounts/:id/status. Single-flight safe:
  // never throws — sync failures must not break account listing.
  let syncStatus: string = 'never_synced'
  let lastSyncAt: Date | null = null
  let openIssuesCount = 0
  try {
    const state = await prisma.telegramSyncState.findUnique({
      where: { connectedAccountId: accountId },
      select: { status: true, lastScanAt: true },
    })
    if (state) {
      syncStatus = state.status
      lastSyncAt = state.lastScanAt
    }
    openIssuesCount = await prisma.telegramSyncIssue.count({
      where: { userId, connectedAccountId: accountId, resolvedAt: null },
    })
  } catch {
    // Sync tables may not exist yet on a fresh install — fall through
    // with the default "never_synced" status.
  }

  return {
    ...rest,
    provider: 'telegram',
    storageAccount: storageAccount ? {
      ...storageAccount,
      totalBytes: null,
      usedBytes: storageAccount.usedBytes.toString(),
      fileCount: Number(storageAccount.fileCount ?? 0),
      availableBytes: null,
      trashBytes: storageAccount.trashBytes?.toString() ?? null,
    } : null,
    telegram: telegramStorageConfig ? {
      channelId: telegramStorageConfig.channelId,
      channelTitle: telegramStorageConfig.channelTitle,
      status: deriveTelegramChannelStatus(account.status, telegramStorageConfig.channelId),
      syncStatus,
      lastSyncAt: lastSyncAt?.toISOString() ?? null,
      openIssuesCount,
    } : null,
  }
}

/** Build a connected teleproto client from an encrypted session + credentials. */
export async function createTelegramClient(config: CredentialsSource) {
  try {
    const telegram = await loadTelegram()
    const apiId = Number(decryptText(config.apiIdEncrypted))
    const apiHash = decryptText(config.apiHashEncrypted)
    const session = decryptText(config.sessionEncrypted)
    return new telegram.TelegramClient(new telegram.sessions.StringSession(session), apiId, apiHash, {}) as TelegramClient
  } catch (error) {
    throw classifyTelegramError(error)
  }
}

/** Serialize the current teleproto client session into an encrypted string session. */
export async function saveSessionString(client: TelegramClient): Promise<string> {
  return String((client.session as unknown as { save(): string | Promise<string> }).save?.() ?? '')
}

/** Run `fn` with a fresh connected client, disconnected in `finally`. */
export async function withTelegramClient<T>(
  config: CredentialsSource,
  fn: (client: TelegramClient) => Promise<T>,
): Promise<T> {
  const client = await createTelegramClient(config)
  try {
    await client.connect()
    return await fn(client)
  } catch (error) {
    throw classifyTelegramError(error)
  } finally {
    client.disconnect().catch(() => undefined)
  }
}

function channelTitleOf(entity: unknown): string {
  const title = (entity as { title?: string } | undefined)?.title
  return title || env.TELEGRAM_STORAGE_CHANNEL
}

/**
 * Resolve the CONFIGURED storage channel for an operation.
 *
 * Fails hard when no channel is stored (`TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED`)
 * or when the stored channel is gone/inaccessible. It NEVER creates a channel,
 * searches dialogs by title, or falls back to another chat — a missing/invalid
 * channel is an error, not a cue to pick a new destination (spec §5, §13).
 *
 * The id is looked up in marked (`-100…`) AND bare forms: accounts configured
 * before the marked-form convention store the raw positive channel id, which
 * teleproto would otherwise resolve as a `PeerUser` and fail on.
 */
export async function resolveConfiguredChannel(client: TelegramClient, channelId: string | null | undefined): Promise<unknown> {
  let fallback: AppError | undefined
  for (const candidate of channelLookupCandidates(channelId)) {
    try {
      if (client.getInputEntity) {
        await client.getInputEntity(candidate)
      }
      const entity = await client.getEntity(candidate)
      if (entity) return entity
    } catch (error) {
      if (error instanceof AppError) throw error
      const classified = classifyTelegramError(error)
      // A definitive cause (channel gone/private, revoked session, flood…)
      // outranks the generic entity-not-found fallback from the bare form.
      if (classified.code !== 'TELEGRAM_UPLOAD_FAILED') throw classified
      fallback ??= classified
    }
  }
  throw fallback ?? new AppError('TELEGRAM_CHANNEL_UNAVAILABLE', 'The Telegram storage channel is no longer available.', 410)
}

/** Persist a resolved channel id onto the account's config (connect or recreation). */
export async function persistTelegramChannel(accountId: string, channelId: string, channelTitle: string) {
  await prisma.telegramStorageConfig.update({
    where: { connectedAccountId: accountId },
    data: { channelId, channelTitle },
  })
}

/** Result of probing read/write/delete on a channel. */
export type ChannelCapabilityProbe = { read: boolean; write: boolean; delete: boolean }

/**
 * Probe read/write/delete capability on a channel using a temporary marker
 * message that is ALWAYS removed (no permanent test files, spec §13). Never
 * throws for capability failures — returns booleans so callers can decide
 * their error semantics.
 */
export async function probeChannelCapabilities(client: TelegramClient, channel: unknown): Promise<ChannelCapabilityProbe> {
  const result: ChannelCapabilityProbe = { read: false, write: false, delete: false }
  try {
    await client.getMessages(channel as never, { limit: 1 })
    result.read = true
  } catch {
    return result
  }
  let markerId: number | undefined
  try {
    const sent = await client.sendMessage(channel as never, { message: '9Drive storage channel test' })
    markerId = (sent as unknown as { id?: number }).id
    if (!markerId) return result
    result.write = true
  } catch {
    return result
  }
  try {
    await client.deleteMessages(channel as never, [markerId], { revoke: true })
    result.delete = true
  } catch {
    // The marker is abandoned only when the channel rejects deletes — which is
    // exactly what this probe is reporting.
  }
  return result
}

/**
 * Test a saved Telegram connection AND the configured storage channel
 * (spec §13): account auth, channel presence/access, read capability, write
 * capability, delete capability. A temporary marker message is used for the
 * write/delete probe and always removed — no permanent test files.
 */
export async function testTelegramConnection(config: ConnectionConfig): Promise<TelegramConnectionTest> {
  const checks: TelegramConnectionTest['checks'] = {
    account: false,
    channel: null,
    read: null,
    write: null,
    delete: null,
  }
  try {
    return await withTelegramClient(config, async (client) => {
      // 1. Account / auth check.
      await client.getMe()
      checks.account = true

      // 2. Storage channel configured + accessible.
      if (!config.channelId) {
        return {
          ok: false,
          status: 'storage_channel_required' as const,
          checks,
          details: 'No storage channel is configured. Create or select a private storage channel first.',
        }
      }
      const channel = await resolveConfiguredChannel(client, config.channelId)
      if (!isStorageChannelCandidate(channel)) {
        return {
          ok: false,
          status: 'storage_channel_invalid' as const,
          checks,
          details: 'The configured storage channel is not a usable private channel.',
        }
      }
      checks.channel = true

      // 3-5. Read / write / delete capability probe.
      const probe = await probeChannelCapabilities(client, channel)
      checks.read = probe.read
      checks.write = probe.write
      checks.delete = probe.delete
      if (!probe.read || !probe.write || !probe.delete) {
        const status: TelegramChannelStatus = !probe.read ? 'storage_channel_invalid' : 'storage_channel_read_only'
        const capability = !probe.read ? 'read' : !probe.write ? 'write' : 'delete'
        return {
          ok: false,
          status,
          checks,
          details: `The configured storage channel is not fully usable — ${capability} capability failed.`,
        }
      }

      return {
        ok: true,
        status: 'ready' as const,
        checks,
        details: `Connected to private storage channel "${channelTitleOf(channel)}". Read, write and delete are working.`,
      }
    })
  } catch (error) {
    const classified = classifyTelegramError(error)
    const status: TelegramChannelStatus =
      classified.code === 'TELEGRAM_SESSION_INVALID' ? 'authentication_required' : 'error'
    return { ok: false, status, checks, details: classified.message }
  }
}

/**
 * Upload a local document to the configured storage channel and return the
 * `telegram://<channel>/<message>` remote id. Fails with
 * `TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED` when no channel is configured —
 * never uploads anywhere else.
 *
 * `opts.caption` overrides the filename-derived caption. The 9Drive upload
 * path passes a `9drive:id=…` + `9drive:path=…` caption so the message can be
 * re-ingested by id. When omitted, the caption falls back to the filename
 * (legacy behaviour preserved for tests / manual callers).
 */
export async function uploadTelegramDocument(
  config: TelegramConfig,
  opts: { filePath: string; name: string; mimeType: string; sizeBytes: number; caption?: string; onProgress?: (pct: number) => void },
): Promise<string> {
  return withTelegramClient(config, async (client) => {
    const te = await loadTelegram()
    const channel = await resolveConfiguredChannel(client, config.channelId)
    // A configured-but-non-channel peer (user/chat/megagroup from corrupt
    // data) must never receive uploads — files only ever go to a broadcast
    // channel.
    if (!isStorageChannelCandidate(channel)) {
      throw new AppError('TELEGRAM_CHANNEL_UNAVAILABLE', 'The configured Telegram storage channel is not a private broadcast channel.', 410)
    }
    const caption = (opts.caption ?? opts.name).slice(0, 1024)
    const sent = await client.sendFile(channel as never, {
      file: opts.filePath as never,
      caption,
      forceDocument: true,
      attributes: [new te.Api.DocumentAttributeFilename({ fileName: opts.name }) as never],
      ...(opts.onProgress ? { progressCallback: opts.onProgress } : {}),
    } as never)
    const messageId = (sent as unknown as { id: number | string }).id
    const entityId = (channel as { id?: unknown }).id
    const resolvedChannelId = entityId ?? config.channelId
    if (!resolvedChannelId) {
      throw new AppError('TELEGRAM_CHANNEL_UNAVAILABLE', 'Telegram did not return a channel id.', 502)
    }
    if (config.channelId !== String(resolvedChannelId)) {
      await persistTelegramChannel(config.connectedAccountId, normalizeChannelId(resolvedChannelId), channelTitleOf(channel))
    }
    return buildTelegramRemoteId(normalizeChannelId(resolvedChannelId), messageId)
  })
}

/**
 * Delete Telegram documents referenced by remote ids. Returns a list of error
 * strings keyed by remote id (empty on full success), mirroring the Teledrive
 * adapter's per-remote error surface so callers can reconcile.
 */
export async function deleteTelegramDocuments(config: CredentialsSource, remoteIds: string[]) {
  const targets = remoteIds.filter((id) => id && id.startsWith(TELEGRAM_REMOTE_PREFIX))
  if (targets.length === 0) return []
  const errors: string[] = []
  await withTelegramClient(config, async (client) => {
    const groups = new Map<string, number[]>()
    for (const remoteId of targets) {
      const { channelId, messageId } = parseTelegramRemoteId(remoteId)
      const list = groups.get(channelId) ?? []
      list.push(messageId)
      groups.set(channelId, list)
    }
    for (const [channelId, messageIds] of groups) {
      try {
        const channel = await resolveConfiguredChannel(client, channelId)
        await client.deleteMessages(channel as never, messageIds, { revoke: true })
      } catch (error) {
        for (const messageId of messageIds) {
          errors.push(`${buildTelegramRemoteId(channelId, messageId)}: ${classifyTelegramError(error).message}`)
        }
      }
    }
  })
  return errors
}

/**
 * Open a Telegram document for byte streaming (batch download / zip export).
 * Returns the async iterable plus a `close()` that MUST be awaited when the
 * consumer is done (it disconnects the short-lived client).
 */
export async function openTelegramDocument(config: CredentialsSource, remoteId: string) {
  const client = await createTelegramClient(config)
  await client.connect()
  try {
    const { channelId, messageId } = parseTelegramRemoteId(remoteId)
    const channel = await resolveConfiguredChannel(client, channelId)
    const messages = await client.getMessages(channel as never, { ids: [messageId] })
    const message = messages[0]
    if (!message || !(message as { document?: unknown }).document) {
      throw new AppError('TELEGRAM_FILE_NOT_FOUND', 'The Telegram document could not be found.', 404)
    }
    return {
      remoteId,
      stream: client.iterDownload(message.media as never, { requestSize: 512 * 1024 }) as AsyncIterable<Buffer>,
      close: () => client.disconnect().catch(() => undefined),
    }
  } catch (error) {
    await client.disconnect().catch(() => undefined)
    throw error
  }
}

/** Stream a Telegram document to `res` as a full `200` response (no Range). */
export async function streamTelegramFile(file: FileWithAccount, _range: string | undefined, res: Response, options: StreamOptions = {}) {
  const config = await getTelegramConfig(file.connectedAccountId)
  const download = await openTelegramDocument(config, file.providerFileId)
  try {
    res.status(200)
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
    if (options.disposition) res.setHeader('Content-Disposition', `${options.disposition}; filename="${file.name.replaceAll('"', '')}"`)
    for await (const chunk of download.stream) {
      res.write(chunk)
    }
    res.end()
  } finally {
    await download.close()
  }
}

/**
 * Idempotently mark a Telegram account REAUTH_REQUIRED when its MTProto
 * session is revoked/expired (Telegram-only — the shared account model is also
 * used by Google/S3, which never reach this via this path). Never touches saved
 * preferences or the storage channel. Safe to call from concurrent failures:
 * the `updateMany` CAS admits exactly one transition. The auth wizard's
 * reconnect clears the markers.
 */
export async function markTelegramReauthRequired(accountId: string, reason?: string): Promise<void> {
  const affected = await prisma.connectedAccount.updateMany({
    where: { id: accountId, provider: 'telegram', status: { not: 'reauth_required' } },
    data: {
      status: 'reauth_required',
      reauthRequiredAt: new Date(),
      lastAuthErrorCode: 'TELEGRAM_SESSION_INVALID',
      lastError: reason ? reason.slice(0, 1000) : null,
    },
  })
  if (affected.count > 0) {
    console.info('[telegram-auth] reauth_required', JSON.stringify({ event: 'telegram.auth.reauth_required', connectedAccountId: accountId, provider: 'telegram', authStateTransition: 'connected->reauth_required' }))
  }
}

/**
 * List documents in the storage channel as `{ remoteId, name, size, mimeType }`
 * for recovery/indexing. Filename from the document attribute, with the
 * `telegram-document-<id>` fallback (Teledrive convention). Only the configured
 * storage channel is ever scanned (spec §10).
 */
export async function listTelegramDocuments(config: ConnectionConfig) {
  return withTelegramClient(config, async (client) => {
    const channel = await resolveConfiguredChannel(client, config.channelId)
    const channelId = normalizeChannelId((channel as { id?: unknown }).id)
    const documents: Array<{ remoteId: string; name: string; size: number; mimeType: string | null }> = []
    const messages = client.iterMessages(channel as never)
    for await (const message of messages) {
      const document = (message as { document?: { attributes?: Array<{ fileName?: string | null }>; size?: number; mimeType?: string | null } }).document
      if (!document) continue
      const attributes = document.attributes ?? []
      const name = attributes.find((a) => a?.fileName)?.fileName
      documents.push({
        remoteId: buildTelegramRemoteId(channelId, (message as { id: number }).id),
        name: name || `telegram-document-${(message as { id: number }).id}`,
        size: document.size ?? 0,
        mimeType: document.mimeType ?? null,
      })
    }
    return documents
  })
}
