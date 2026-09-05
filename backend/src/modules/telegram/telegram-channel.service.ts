import type { ConnectedAccount, TelegramStorageConfig } from '@prisma/client'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { decryptText } from '../../utils/crypto.js'
import {
  isStorageChannelCandidate,
  normalizeChannelId,
  probeChannelCapabilities,
  resolveConfiguredChannel,
  serializeTelegramAccount,
  telegramDisplayName,
  withTelegramClient,
} from './telegram.service.js'
import { syncTelegramUsage } from './telegram-usage.service.js'

type TelegramConfig = TelegramStorageConfig & { connectedAccount: ConnectedAccount }

/**
 * Storage-channel setup / change (spec §3, §4).
 *
 * The channel is configured EXPLICITLY after authentication: either 9Drive
 * creates a new private channel, or the user picks an existing private channel
 * the account can access. In both cases the channel is capability-probed
 * (read/write/delete) before it is persisted, and the probe result is enforced:
 * an unusable channel is rejected with a clear error, never silently replaced.
 *
 * Only broadcast private channels qualify — Saved Messages, personal chats and
 * groups are never storage targets (spec §5, §10).
 */

type ChannelCandidate = { channelId: string; title: string }

/** Channels in the account's dialogs that are usable storage candidates. */
export async function listTelegramStorageChannels(config: TelegramConfig): Promise<{ channels: ChannelCandidate[] }> {
  const channels: ChannelCandidate[] = []
  await withTelegramClient(config, async (client) => {
    const dialogs = client.iterDialogs({})
    for await (const dialog of dialogs) {
      const entity = (dialog as { entity?: unknown }).entity
      if (!isStorageChannelCandidate(entity)) continue
      const id = (entity as { id?: unknown }).id
      if (id === undefined) continue
      channels.push({
        channelId: normalizeChannelId(id),
        title: (entity as { title?: string }).title?.trim() || 'Untitled channel',
      })
    }
  })
  return { channels }
}

/**
 * Create a new private storage channel, capability-probe it, and persist it as
 * the account's storage destination.
 */
export async function createTelegramStorageChannel(
  userId: string,
  config: TelegramConfig,
  opts: { title?: string },
): Promise<{ account: unknown }> {
  const title = opts.title?.trim() || env.TELEGRAM_STORAGE_CHANNEL
  const result = await withTelegramClient(config, async (client) => {
    const created = await client.createChannel({
      title,
      about: `Private ${env.TELEGRAM_STORAGE_CHANNEL} storage channel`,
      megagroup: false,
    })
    if (!isStorageChannelCandidate(created)) {
      throw new AppError('TELEGRAM_CHANNEL_VALIDATION_FAILED', 'Storage channel validation failed — the created chat is not a private broadcast channel.', 400)
    }
    const channelId = normalizeChannelId((created as { id?: unknown }).id)
    const channelTitle = (created as { title?: string }).title?.trim() || title
    const probe = await probeChannelCapabilities(client, created)
    return { channelId, channelTitle, probe }
  })

  assertProbeOk(result.probe, result.channelTitle)
  const account = await persistChannelConfig(userId, config, {
    channelId: result.channelId,
    channelTitle: result.channelTitle,
  })
  await createAuditLog(userId, 'telegram.channel_create', 'connected_account', config.connectedAccount.id, {
    channelId: result.channelId,
  })
  return { account }
}

/**
 * Use an existing private channel as the storage destination. The exact
 * channel is resolved (never searched by filename/title), validated as a
 * broadcast channel, capability-probed, and persisted.
 */
export async function selectTelegramStorageChannel(
  userId: string,
  config: TelegramConfig,
  opts: { channelId: string; transfer?: boolean },
): Promise<{ account: unknown }> {
  const result = await withTelegramClient(config, async (client) => {
    const entity = await resolveConfiguredChannel(client, opts.channelId)
    if (!isStorageChannelCandidate(entity)) {
      throw new AppError('TELEGRAM_CHANNEL_VALIDATION_FAILED', 'Storage channel validation failed — the selected peer is not a private channel.', 400)
    }
    const probe = await probeChannelCapabilities(client, entity)
    return {
      channelId: normalizeChannelId((entity as { id?: unknown }).id),
      channelTitle: (entity as { title?: string }).title?.trim() || 'Untitled channel',
      probe,
    }
  })

  assertProbeOk(result.probe, result.channelTitle)
  let account: unknown
  try {
    account = await persistChannelConfig(userId, config, {
      channelId: result.channelId,
      channelTitle: result.channelTitle,
    })
  } catch (error) {
    // Opt-in takeover. The probe above already proved this account can read/
    // write/delete the channel; the unique constraint is the only thing left
    // in the way. Never implicit — explicit `transfer: true` from the client.
    if (!opts.transfer || (error as { code?: string }).code !== 'TELEGRAM_CHANNEL_IN_USE') throw error
    account = await transferChannelOwnership(userId, config, { channelId: result.channelId, channelTitle: result.channelTitle })
  }
  await createAuditLog(userId, opts.transfer ? 'telegram.channel_transfer' : 'telegram.channel_select', 'connected_account', config.connectedAccount.id, {
    channelId: result.channelId,
  })
  return { account }
}

function assertProbeOk(probe: { read: boolean; write: boolean; delete: boolean }, channelTitle: string) {
  if (!probe.read) {
    throw new AppError('TELEGRAM_CHANNEL_VALIDATION_FAILED', `Storage channel validation failed — cannot read "${channelTitle}".`, 400)
  }
  if (!probe.write || !probe.delete) {
    throw new AppError('TELEGRAM_CHANNEL_READ_ONLY', `Storage channel validation failed — "${channelTitle}" is not fully writable (write: ${probe.write}, delete: ${probe.delete}).`, 400)
  }
}

/**
 * Persist the chosen channel on the account: point the connected-account
 * identity at the channel, then update the storage config, then refresh usage.
 * A channel already bound to another of the user's accounts fails loudly.
 */
async function persistChannelConfig(
  userId: string,
  config: TelegramConfig,
  channel: { channelId: string; channelTitle: string },
) {
  const accountId = config.connectedAccount.id
  // Identity FIRST: this is the write that can trip the
  // (userId, provider, providerAccountId) unique constraint. Writing the
  // storage config first left a rejected selection with a config pointing at a
  // channel the account was never granted — and uploads read the config, not
  // the identity, so that account would silently keep writing into it.
  try {
    await prisma.connectedAccount.update({
      where: { id: accountId },
      data: {
        providerAccountId: channel.channelId,
        email: `telegram@${channel.channelId}`,
        displayName: telegramDisplayName(
          config.phoneEncrypted ? decryptText(config.phoneEncrypted) : null,
          channel.channelTitle,
        ),
        status: 'connected',
        reauthRequiredAt: null,
        lastAuthErrorCode: null,
        lastError: null,
      },
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw await channelInUseError(userId, channel.channelId)
    }
    throw error
  }
  await prisma.telegramStorageConfig.update({
    where: { connectedAccountId: accountId },
    data: { channelId: channel.channelId, channelTitle: channel.channelTitle },
  })
  await syncTelegramUsage(accountId).catch(() => undefined)
  return serializeTelegramAccount(userId, accountId)
}

/**
 * Name what holds the channel so a 409 is actionable. Disconnecting an account
 * is a soft status change — it keeps its claim on the channel (and its files),
 * so the fix is to reconnect that account rather than connect a new one.
 */
async function channelInUseError(userId: string, channelId: string): Promise<AppError> {
  const holder = await prisma.connectedAccount.findFirst({
    where: { userId, provider: 'telegram', providerAccountId: channelId },
    select: { status: true },
  })
  const hint =
    holder?.status === 'disconnected'
      ? ' A disconnected 9Drive account still holds it — reconnect that account instead of connecting a new one; its channel and files are preserved.'
      : ''
  return new AppError('TELEGRAM_CHANNEL_IN_USE', `This storage channel is already used by another 9Drive account.${hint}`, 409)
}


/**
 * Take an already-claimed channel away from another of the user's 9Drive
 * accounts and bind it to this one — files, folder locations, and sync cursor
 * all move with the channel. The source keeps its row but loses the channel
 * claim and is left in a "storage channel required" state.
 *
 * Single transaction: a half-applied transfer strands files on an account that
 * can no longer reach the channel, or vice versa. The MySQL unique index
 * forces a release-then-claim order; the target's folder locations and sync
 * state describe its previous channel and must be dropped before the source's
 * are moved over.
 */
export async function transferChannelOwnership(
  userId: string,
  config: TelegramConfig,
  channel: { channelId: string; channelTitle: string },
): Promise<unknown> {
  const toId = config.connectedAccount.id
  const holder = await prisma.connectedAccount.findFirst({
    where: { userId, provider: 'telegram', providerAccountId: channel.channelId },
    select: { id: true, telegramStorageConfig: { select: { phoneEncrypted: true } } },
  })
  if (!holder) {
    // The unique constraint is the source of truth; this should be impossible
    // (we were called from a P2002 catch). Fail loudly rather than pretend.
    throw new AppError('TELEGRAM_CHANNEL_IN_USE', 'This storage channel is already used by another 9Drive account.', 409)
  }
  if (holder.id === toId) {
    throw new AppError('TELEGRAM_CHANNEL_ALREADY_OWNED', 'This storage channel is already bound to this 9Drive account.', 409)
  }
  const fromId = holder.id
  const fromPhone = holder.telegramStorageConfig?.phoneEncrypted
    ? decryptText(holder.telegramStorageConfig.phoneEncrypted)
    : null
  const toPhone = config.phoneEncrypted ? decryptText(config.phoneEncrypted) : null

  await prisma.$transaction(async (tx) => {
    // Release FIRST: the @@unique([userId, provider, providerAccountId]) index
    // is checked per statement, so both rows cannot hold the channel id at
    // once. Uploads read the config, not the identity, so the source's config
    // must be cleared too — otherwise it would silently keep writing in.
    await tx.connectedAccount.update({
      where: { id: fromId },
      data: {
        providerAccountId: `pending:${fromId}`,
        email: 'telegram@pending',
        displayName: telegramDisplayName(fromPhone, null),
      },
    })
    await tx.telegramStorageConfig.updateMany({
      where: { connectedAccountId: fromId },
      data: { channelId: null, channelTitle: null },
    })
    // Claim. The same writes `persistChannelConfig` would make, on the new row.
    await tx.connectedAccount.update({
      where: { id: toId },
      data: {
        providerAccountId: channel.channelId,
        email: `telegram@${channel.channelId}`,
        displayName: telegramDisplayName(toPhone, channel.channelTitle),
        status: 'connected',
        reauthRequiredAt: null,
        lastAuthErrorCode: null,
        lastError: null,
      },
    })
    await tx.telegramStorageConfig.update({
      where: { connectedAccountId: toId },
      data: { channelId: channel.channelId, channelTitle: channel.channelTitle },
    })
    // Files follow the channel. `providerFileId` already carries the channel
    // id, so no rewrite — only the owning account changes.
    await tx.file.updateMany({
      where: { connectedAccountId: fromId },
      data: { connectedAccountId: toId },
    })
    // Folder locations map folders to physical ids IN A CHANNEL. The target's
    // own rows describe whatever channel it had before, so they are now wrong;
    // drop them wholesale. A bare updateMany would also trip
    // @@unique([folderId, connectedAccountId]) for any shared folder.
    await tx.folderStorageLocation.deleteMany({ where: { connectedAccountId: toId } })
    await tx.folderStorageLocation.updateMany({
      where: { connectedAccountId: fromId },
      data: { connectedAccountId: toId },
    })
    // `lastMessageId` is a per-channel cursor: inherit the source's, discard
    // the target's. Never max() them — they count messages in different channels.
    await tx.telegramSyncState.deleteMany({ where: { connectedAccountId: toId } })
    await tx.telegramSyncState.updateMany({
      where: { connectedAccountId: fromId },
      data: { connectedAccountId: toId },
    })
    // History (TelegramSyncRun / TelegramSyncIssue / SyncRun) is NOT reassigned
    // on purpose: the target should not be credited with runs it never made.
    // It cascades away only when the source row is purged.
  })

  // Recompute quota from the new File distribution. syncTelegramUsage derives
  // usedBytes + fileCount from File rows, so we don't have to touch StorageAccount.
  await Promise.all([
    syncTelegramUsage(fromId).catch(() => undefined),
    syncTelegramUsage(toId).catch(() => undefined),
  ])
  await createAuditLog(userId, 'telegram.channel_transfer_complete', 'connected_account', toId, {
    channelId: channel.channelId,
    fromAccountId: fromId,
    toAccountId: toId,
  })
  return serializeTelegramAccount(userId, toId)
}
