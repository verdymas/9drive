import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeTelegramClientPool, evictTelegramClient, getPooledTelegramClient, type PooledClient } from './telegram-client-pool.js'

function makeFakeClient() {
  const client: PooledClient & { disconnect: ReturnType<typeof vi.fn> } = {
    connected: false,
    connect: vi.fn(async () => {
      client.connected = true
    }),
    disconnect: vi.fn(async () => {
      client.connected = false
    }),
  }
  return client
}

beforeEach(async () => {
  await closeTelegramClientPool()
})

describe('telegram client pool', () => {
  it('reuses one client per key', async () => {
    const factory = vi.fn(async () => makeFakeClient())

    const a = await getPooledTelegramClient('k1', factory)
    const b = await getPooledTelegramClient('k1', factory)

    expect(factory).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(a.connected).toBe(true)
  })

  it('gives distinct keys distinct clients', async () => {
    const factory = vi.fn(async () => makeFakeClient())

    const a = await getPooledTelegramClient('k1', factory)
    const b = await getPooledTelegramClient('k2', factory)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
  })

  it('is single-flight under concurrent callers', async () => {
    const factory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return makeFakeClient()
    })

    const [a, b] = await Promise.all([getPooledTelegramClient('k1', factory), getPooledTelegramClient('k1', factory)])

    expect(factory).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(a.connected).toBe(true)
  })

  it('evicts a failed creation so the next caller retries', async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect failed'))
      .mockImplementation(async () => makeFakeClient())

    await expect(getPooledTelegramClient('k1', factory)).rejects.toThrow('connect failed')
    const client = await getPooledTelegramClient('k1', factory)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(client.connected).toBe(true)
  })

  it('evicts when connect() throws and retries on the next call', async () => {
    const client1 = makeFakeClient()
    client1.connect = vi.fn(async () => {
      throw new Error('bad connect')
    })
    const factory = vi.fn().mockResolvedValueOnce(client1).mockImplementation(async () => makeFakeClient())

    await expect(getPooledTelegramClient('k1', factory)).rejects.toThrow('bad connect')
    const client = await getPooledTelegramClient('k1', factory)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(client.connected).toBe(true)
  })

  it('replaces a pooled client that lost its connection', async () => {
    const factory = vi.fn(async () => makeFakeClient())

    const first = await getPooledTelegramClient('k1', factory)
    first.connected = false // simulated disconnect outside the pool
    const second = await getPooledTelegramClient('k1', factory)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(first).not.toBe(second)
    expect(second.connected).toBe(true)
  })

  it('evictTelegramClient disconnects and drops the entry', async () => {
    const factory = vi.fn(async () => makeFakeClient())

    const client = await getPooledTelegramClient('k1', factory)
    await evictTelegramClient('k1')

    expect(client.disconnect).toHaveBeenCalledTimes(1)
    const next = await getPooledTelegramClient('k1', factory)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(next).not.toBe(client)
  })

  it('closeTelegramClientPool disconnects all pooled clients', async () => {
    const factory = vi.fn(async () => makeFakeClient())

    const a = await getPooledTelegramClient('k1', factory)
    const b = await getPooledTelegramClient('k2', factory)
    await closeTelegramClientPool()

    expect(a.disconnect).toHaveBeenCalledTimes(1)
    expect(b.disconnect).toHaveBeenCalledTimes(1)

    // Pool is empty again — next get creates fresh clients.
    const c = await getPooledTelegramClient('k1', factory)
    expect(c).not.toBe(a)
    expect(factory).toHaveBeenCalledTimes(3)
  })
})
