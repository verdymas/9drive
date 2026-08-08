import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './map-with-concurrency.js'

describe('mapWithConcurrency', () => {
  it('maps all items and preserves order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10)
    expect(out).toEqual([10, 20, 30, 40, 50])
  })

  it('never runs more than `concurrency` tasks at once', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
    })
    expect(peak).toBe(3)
  })

  it('handles concurrency larger than the item count', async () => {
    const out = await mapWithConcurrency([1, 2], 10, async (n) => n + 1)
    expect(out).toEqual([2, 3])
  })

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 2, async () => 1)).toEqual([])
  })

  it('propagates the first rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})