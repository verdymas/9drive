import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startTelegramAuth } from './telegram-auth.service.js'

// The fresh-connect wizard requires apiId + apiHash (no stored account). This
// test only exercises the validation path — the client is never built, so no
// teleproto/network dependency is needed.
const h = vi.hoisted(() => ({
  prismaMock: {
    telegramStorageConfig: { findFirst: vi.fn(async () => null) },
  },
}))

vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('startTelegramAuth — fresh-connect validation', () => {
  it('requires apiId and apiHash when no accountId is given', async () => {
    await expect(
      startTelegramAuth({ userId: 'user-1', phone: '+15550000000' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    await expect(
      startTelegramAuth({ userId: 'user-1', phone: '+15550000000', apiId: 12345 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a non-positive apiId', async () => {
    await expect(
      startTelegramAuth({ userId: 'user-1', phone: '+15550000000', apiId: -1, apiHash: 'hash' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a missing phone', async () => {
    await expect(
      startTelegramAuth({ userId: 'user-1', phone: '  ', apiId: 12345, apiHash: 'hash' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
