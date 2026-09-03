import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelegramClient } from 'teleproto'

const h = vi.hoisted(() => {
  const prismaMock = {
    file: {
      findFirst: vi.fn(),
    },
  }
  const auditMock = { createAuditLog: vi.fn(async () => undefined) }
  // The caption service calls `withTelegramClient` to build a short-lived
  // client. Tests inject their own fake by stubbing the service module.
  const withTelegramClientMock = vi.fn()
  return { prismaMock, auditMock, withTelegramClientMock }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: h.auditMock.createAuditLog }))
vi.mock('./telegram.service.js', async () => {
  const actual = await vi.importActual<typeof import('./telegram.service.js')>('./telegram.service.js')
  return { ...actual, withTelegramClient: h.withTelegramClientMock }
})

import { buildInitialCaption, updateTelegramDocumentCaption } from './telegram-caption.service.js'
import { parseTelegramRemoteId } from './telegram.service.js'

function fakeClient(opts: { caption: string | null; throwOnEdit?: unknown }): TelegramClient {
  return {
    async connect() {},
    async disconnect() {},
    async getInputEntity() { return {} as never },
    async getEntity(_candidate: string) { return { id: 4458806678, title: 'storage', megagroup: false, broadcast: true } as never },
    async getMessages(_entity: unknown, { ids }: { ids: number[] }) {
      return [{ id: ids[0], message: opts.caption } as never]
    },
    async editMessage(_entity: unknown, args: { message: number; text: string }) {
      if (opts.throwOnEdit) throw opts.throwOnEdit
      return { id: args.message } as never
    },
  } as unknown as TelegramClient
}

const config = {
  id: 'cfg-1',
  userId: 'user-1',
  connectedAccountId: 'acc-1',
  name: 'Telegram Drive',
  apiIdEncrypted: 'enc',
  apiHashEncrypted: 'enc',
  sessionEncrypted: 'enc',
  channelId: '4458806678',
  channelTitle: 'storage',
  createdAt: new Date(),
  updatedAt: new Date(),
  connectedAccount: {
    id: 'acc-1',
    userId: 'user-1',
    providerConfigId: null,
    provider: 'telegram',
    providerAccountId: '4458806678',
    email: 'tg@4458806678',
    displayName: null,
    avatarUrl: null,
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    scopes: [],
    status: 'connected',
    autoAllocationEnabled: true,
    lastError: null,
    reauthRequiredAt: null,
    lastAuthErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
} as unknown as Parameters<typeof updateTelegramDocumentCaption>[2]

beforeEach(() => {
  vi.clearAllMocks()
  h.prismaMock.file.findFirst.mockResolvedValue({ providerFileId: 'telegram://4458806678/42' })
  h.withTelegramClientMock.mockImplementation(async (_config: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ caption: 'stale' })))
})

describe('updateTelegramDocumentCaption', () => {
  it('no-ops when the existing caption matches the encoded caption', async () => {
    const nextCaption = buildInitialCaption('file-1', 'Projects/A/docs.md')!
    h.withTelegramClientMock.mockImplementationOnce(async (_config: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ caption: nextCaption })))
    const result = await updateTelegramDocumentCaption(
      'user-1',
      { id: 'file-1', name: 'docs.md', telegramStableId: 'file-1' },
      config,
      'Projects/A/docs.md',
    )
    expect(result.changed).toBe(false)
    expect(result.previousCaption).toBe(nextCaption)
    expect(result.nextCaption).toBe(nextCaption)
    expect(parseTelegramRemoteId(`telegram://${result.channelId}/${result.messageId}`).channelId).toBe('4458806678')
  })

  it('returns no-op when the file has no stable id (legacy row)', async () => {
    const result = await updateTelegramDocumentCaption(
      'user-1',
      { id: 'file-1', name: 'docs.md', telegramStableId: null as unknown as string },
      config,
      'Projects/A/docs.md',
    )
    expect(result.changed).toBe(false)
  })

  it('returns no-op when the file has a stable id but no Telegram document yet', async () => {
    h.prismaMock.file.findFirst.mockResolvedValueOnce({ providerFileId: null })
    const result = await updateTelegramDocumentCaption(
      'user-1',
      { id: 'file-1', name: 'docs.md', telegramStableId: 'file-1' },
      config,
      'Projects/A/docs.md',
    )
    expect(result.changed).toBe(false)
  })

  it('classifies editMessage failures and surfaces TELEGRAM_NETWORK', async () => {
    h.withTelegramClientMock.mockImplementationOnce(async (_config: unknown, fn: (client: TelegramClient) => Promise<unknown>) => fn(fakeClient({ caption: 'stale', throwOnEdit: { code: 503, message: 'ECONNRESET socket hang up' } })))
    await expect(
      updateTelegramDocumentCaption(
        'user-1',
        { id: 'file-1', name: 'docs.md', telegramStableId: 'file-1' },
        config,
        'Projects/A/docs.md',
      ),
    ).rejects.toMatchObject({ code: 'TELEGRAM_NETWORK' })
  })
})

describe('buildInitialCaption', () => {
  it('produces a parser-compatible caption', () => {
    const caption = buildInitialCaption('file-1', 'Projects/A/docs.md')
    expect(caption).not.toBeNull()
    expect(caption!.startsWith('9drive:id=file-1')).toBe(true)
    expect(caption!.includes('9drive:path=Projects/A/docs.md')).toBe(true)
  })
  it('omits the path line when the path is null', () => {
    const caption = buildInitialCaption('file-1', null)
    expect(caption).not.toBeNull()
    expect(caption!.startsWith('9drive:id=file-1')).toBe(true)
    expect(caption!.includes('9drive:path=')).toBe(false)
  })
  it('returns null for malformed stable ids', () => {
    expect(buildInitialCaption('has spaces', 'A/B.md')).toBeNull()
  })
})