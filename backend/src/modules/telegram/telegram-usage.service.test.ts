import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncTelegramUsage } from './telegram-usage.service.js'

const h = vi.hoisted(() => {
  const upsert = vi.fn(async ({ create, update }: { create: any; update: any }) => ({ ...create, ...update }))
  const prismaMock = {
    file: {
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0n }, _count: 0 })),
    },
    storageAccount: { upsert },
  }
  return { prismaMock, upsert }
})

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('syncTelegramUsage', () => {
  it('writes usedBytes + fileCount from active files and keeps quota null (indexed-only)', async () => {
    ;(h.prismaMock.file.aggregate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      _sum: { sizeBytes: 12_345n },
      _count: 7,
    })

    await syncTelegramUsage('acc-tg')

    expect(h.prismaMock.file.aggregate).toHaveBeenCalledWith({
      where: { connectedAccountId: 'acc-tg', status: 'active' },
      _sum: { sizeBytes: true },
      _count: true,
    })
    const [args] = h.upsert.mock.calls[0] as [{ where: { connectedAccountId: string }; create: any; update: any }]
    expect(args.create).toMatchObject({
      connectedAccountId: 'acc-tg',
      usedBytes: 12_345n,
      fileCount: 7,
      totalBytes: null,
      availableBytes: null,
    })
    expect(args.update).toMatchObject({ usedBytes: 12_345n, fileCount: 7 })
  })

  it('writes zero usage when the account has no active files', async () => {
    ;(h.prismaMock.file.aggregate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      _sum: { sizeBytes: null },
      _count: 0,
    })

    await syncTelegramUsage('acc-empty')

    const [args] = h.upsert.mock.calls[0] as [{ where: { connectedAccountId: string }; create: any; update: any }]
    expect(args.create.usedBytes).toBe(0n)
    expect(args.create.fileCount).toBe(0)
  })
})
