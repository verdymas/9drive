import type { ConnectedAccount, TelegramStorageConfig } from '@prisma/client'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import {
  isStorageChannelCandidate,
  normalizeChannelId,
  probeChannelCapabilities,
  resolveConfiguredChannel,
  serializeTelegramAccount,
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
  opts: { channelId: string },
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
  const account = await persistChannelConfig(userId, config, {
    channelId: result.channelId,
    channelTitle: result.channelTitle,
  })
  await createAuditLog(userId, 'telegram.channel_select', 'connected_account', config.connectedAccount.id, {
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
