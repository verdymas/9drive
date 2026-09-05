import { beforeEach, describe, expect, it, vi } from 'vitest'

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
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      file: { updateMany: vi.fn(async () => ({ count: 0 })) },
      folderStorageLocation: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      telegramSyncState: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      $transaction: vi.fn(async (fn) => fn({})),
    },
  }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prisma }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn(async () => undefined) }))
vi.mock('../../utils/crypto.js', () => ({ decryptText: (v: string) => v.replace('ENC_', ''), encryptText: (v: string) => 'ENC_' + v }))
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

import { selectTelegramStorageChannel, transferChannelOwnership } from './telegram-channel.service.js'
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



describe('transferChannelOwnership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.prisma.connectedAccount.update.mockImplementation(async () => { h.calls.push('account.update'); throw h.P2002 })
    h.prisma.connectedAccount.findFirst.mockImplementation(async () => ({ status: h.holderStatus.value }))
    h.prisma.telegramStorageConfig.update.mockImplementation(async () => { h.calls.push('config.update'); return {} })
    h.prisma.telegramStorageConfig.updateMany.mockResolvedValue({ count: 1 })
    h.prisma.file.updateMany.mockResolvedValue({ count: 3 })
    h.prisma.folderStorageLocation.findMany.mockResolvedValue([])
    h.prisma.folderStorageLocation.deleteMany.mockResolvedValue({ count: 0 })
    h.prisma.folderStorageLocation.updateMany.mockResolvedValue({ count: 0 })
    h.prisma.telegramSyncState.deleteMany.mockResolvedValue({ count: 0 })
    h.prisma.telegramSyncState.updateMany.mockResolvedValue({ count: 0 })
    h.prisma.$transaction.mockImplementation(async (fn) => fn({}))
  })

  it('moves files, folder locations, and sync cursor inside one transaction', async () => {
    // Holder lookup (first findFirst) returns a different account.
    h.prisma.connectedAccount.findFirst.mockResolvedValueOnce({ id: 'acc-old', telegramStorageConfig: { phoneEncrypted: 'ENC_FROM' } })
    // Run the tx fn ourselves so we can assert call order inside the transaction.
    h.prisma.$transaction.mockImplementationOnce(async (fn) => {
      const txCalls: string[] = []
      const tx = {
        connectedAccount: { update: vi.fn(async () => { txCalls.push('acct.update') }) },
        telegramStorageConfig: { update: vi.fn(async () => { txCalls.push('cfg.update') }), updateMany: vi.fn(async () => { txCalls.push('cfg.updateMany') }) },
        file: { updateMany: vi.fn(async () => { txCalls.push('file.updateMany') }) },
        folderStorageLocation: {
          deleteMany: vi.fn(async () => { txCalls.push('loc.deleteMany(target)') }),
          updateMany: vi.fn(async () => { txCalls.push('loc.updateMany(source)') }),
        },
        telegramSyncState: {
          deleteMany: vi.fn(async () => { txCalls.push('state.deleteMany(target)') }),
          updateMany: vi.fn(async () => { txCalls.push('state.updateMany(source)') }),
        },
      }
      await fn(tx)
      // Release is first (the source's connectedAccount.update), then source
      // config cleared, then claim (target's connectedAccount.update), then
      // file move, then locations drop+move, then state.
      // The order in the service: release acct → clear source cfg → claim
      // acct → write target cfg → move files → drop+move locations → drop+move state.
      expect(txCalls[0]).toBe('acct.update')
      expect(txCalls[1]).toBe('cfg.updateMany')
      expect(txCalls[2]).toBe('acct.update')
      expect(txCalls[3]).toBe('cfg.update')
      expect(txCalls).toContain('file.updateMany')
      expect(txCalls.indexOf('loc.deleteMany(target)')).toBeLessThan(txCalls.indexOf('loc.updateMany(source)'))
      expect(txCalls.indexOf('state.deleteMany(target)')).toBeLessThan(txCalls.indexOf('state.updateMany(source)'))
      return undefined
    })

    const transferConfig = { connectedAccount: { id: 'acc-new' }, phoneEncrypted: 'ENC_TO' } as never
    await transferChannelOwnership('user-1', transferConfig, { channelId: '-1001', channelTitle: 'Movies' })
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('refuses to transfer to itself (caller already holds the channel)', async () => {
    h.prisma.connectedAccount.findFirst.mockResolvedValueOnce({ id: 'acc-new', telegramStorageConfig: { phoneEncrypted: null } })
    const transferConfig = { connectedAccount: { id: 'acc-new' }, phoneEncrypted: 'ENC_TO' } as never
    const err = await transferChannelOwnership('user-1', transferConfig, { channelId: '-1001', channelTitle: 'Movies' }).catch((e) => e)
    expect((err as { code: string }).code).toBe('TELEGRAM_CHANNEL_ALREADY_OWNED')
    expect(h.prisma.$transaction).not.toHaveBeenCalled()
  })
})
