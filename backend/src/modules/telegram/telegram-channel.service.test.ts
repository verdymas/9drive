import { describe, expect, it, vi } from 'vitest'

// A channel already claimed by another of the user's Telegram accounts must be
// rejected — and rejected WITHOUT leaving this account's storage config pointing
// at it, since uploads read the config, not the account identity.

const h = vi.hoisted(() => {
  const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
  return {
    P2002,
    holderStatus: { value: 'disconnected' as string },
    calls: [] as string[],
    prisma: {
      connectedAccount: {
        update: vi.fn(async () => {
          h.calls.push('account.update')
          throw h.P2002
        }),
        findFirst: vi.fn(async () => ({ status: h.holderStatus.value })),
      },
      telegramStorageConfig: {
        update: vi.fn(async () => {
          h.calls.push('config.update')
          return {}
        }),
      },
    },
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prisma }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn(async () => undefined) }))
vi.mock('./telegram-usage.service.js', () => ({ syncTelegramUsage: vi.fn(async () => undefined) }))
vi.mock('./telegram.service.js', async () => {
  const actual = await vi.importActual<typeof import('./telegram.service.js')>('./telegram.service.js')
  return {
    ...actual,
    serializeTelegramAccount: vi.fn(async () => ({})),
    // The channel resolves and probes clean; only persistence conflicts.
    withTelegramClient: vi.fn(async (_config: unknown, fn: (client: unknown) => unknown) => fn({})),
    resolveConfiguredChannel: vi.fn(async () => ({ id: 4458806678, title: 'storage', broadcast: true, megagroup: false })),
    probeChannelCapabilities: vi.fn(async () => ({ read: true, write: true, delete: true })),
  }
})

import { selectTelegramStorageChannel } from './telegram-channel.service.js'
import { AppError } from '../../utils/app-error.js'

const config = { connectedAccount: { id: 'acc-new' } } as never

describe('selectTelegramStorageChannel — channel already claimed', () => {
  it('rejects with an actionable 409 and never writes the storage config', async () => {
    h.calls.length = 0
    const error = await selectTelegramStorageChannel('user-1', config, { channelId: '4458806678' }).catch((e) => e)

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('TELEGRAM_CHANNEL_IN_USE')
    expect((error as AppError).status).toBe(409)
    // Names the disconnected holder so the fix (reconnect it) is discoverable.
    expect((error as AppError).message).toContain('reconnect that account')
    // The identity write is attempted first; the config is never touched.
    expect(h.calls).toEqual(['account.update'])
  })

  it('omits the reconnect hint when the holder is still connected', async () => {
    h.calls.length = 0
    h.holderStatus.value = 'connected'
    const error = await selectTelegramStorageChannel('user-1', config, { channelId: '4458806678' }).catch((e) => e)

    expect((error as AppError).code).toBe('TELEGRAM_CHANNEL_IN_USE')
    expect((error as AppError).message).not.toContain('reconnect that account')
    expect(h.calls).toEqual(['account.update'])
  })
})
