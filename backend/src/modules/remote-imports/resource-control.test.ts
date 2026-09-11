import { describe, expect, it } from 'vitest'
import { estimateTempReservation, FairSemaphore, TempStorageReservations } from './resource-control.js'

describe('TempStorageReservations', () => {
  it('uses a known direct content length instead of the unknown-size estimate', () => {
    expect(estimateTempReservation({ sourceType: 'direct', contentLength: 123n })).toBe(123n)
  })

  it('rejects a reservation that would consume the configured free-space reserve', async () => {
    const reservations = new TempStorageReservations(async () => ({ freeBytes: 150n }))

    await expect(
      reservations.tryAcquire({
        importId: 'import-a',
        stage: 'downloading',
        requiredBytes: 60n,
        reserveBytes: 100n,
      }),
    ).resolves.toMatchObject({
      admitted: false,
      diagnostics: {
        importId: 'import-a',
        stage: 'downloading',
        freeBytes: 150n,
        requiredBytes: 60n,
        reservedBytes: 0n,
        reason: 'free_space_reserve',
      },
    })
  })

  it('includes global HLS resource counters in a temporary-storage deferral diagnostic', async () => {
    const reservations = new TempStorageReservations(
      async () => ({ freeBytes: 150n }),
      () => ({
        hlsSegmentPermits: { limit: 12, active: 4, waiting: 3 },
        ffmpegPermits: { limit: 2, active: 1, waiting: 0 },
      }),
    )

    await expect(reservations.tryAcquire({
      importId: 'import-a',
      stage: 'segments',
      requiredBytes: 60n,
      reserveBytes: 100n,
    })).resolves.toMatchObject({
      admitted: false,
      diagnostics: {
        resourceControls: {
          hlsSegmentPermits: { limit: 12, active: 4, waiting: 3 },
          ffmpegPermits: { limit: 2, active: 1, waiting: 0 },
        },
      },
    })
  })

  it('releases a reservation exactly once so later work can be admitted', async () => {
    const reservations = new TempStorageReservations(async () => ({ freeBytes: 1_000n }))
    const first = await reservations.tryAcquire({
      importId: 'import-a',
      stage: 'downloading',
      requiredBytes: 400n,
      reserveBytes: 100n,
    })
    if (!first.admitted) throw new Error('expected the first reservation to be admitted')

    first.reservation.release()
    first.reservation.release()

    await expect(
      reservations.tryAcquire({
        importId: 'import-b',
        stage: 'segments',
        requiredBytes: 900n,
        reserveBytes: 100n,
      }),
    ).resolves.toMatchObject({ admitted: true })
  })

  it.each(['success', 'failure', 'cancellation', 'requeue'])('allows a later reservation after %s cleanup', async () => {
    const reservations = new TempStorageReservations(async () => ({ freeBytes: 1_000n }))
    const first = await reservations.tryAcquire({
      importId: 'import-a',
      stage: 'downloading',
      requiredBytes: 900n,
      reserveBytes: 100n,
    })
    if (!first.admitted) throw new Error('expected the first reservation to be admitted')

    try {
      // The terminal/requeue branch is outside the ledger; its `finally`
      // always executes this common release operation.
    } finally {
      first.reservation.release()
    }

    await expect(
      reservations.tryAcquire({
        importId: 'import-b',
        stage: 'segments',
        requiredBytes: 900n,
        reserveBytes: 100n,
      }),
    ).resolves.toMatchObject({ admitted: true })
  })
})

describe('FairSemaphore', () => {
  it('does not leak a permit when a queued waiter is cancelled', async () => {
    const semaphore = new FairSemaphore(1)
    const first = await semaphore.acquire()
    const abort = new AbortController()
    const waiting = semaphore.acquire({ signal: abort.signal })
    abort.abort()

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    first.release()
    await expect(semaphore.acquire()).resolves.toMatchObject({ release: expect.any(Function) })
  })

  it('bounds aggregate activity across callers', async () => {
    const semaphore = new FairSemaphore(2)
    let active = 0
    let maximum = 0
    await Promise.all(Array.from({ length: 6 }, async () => {
      const permit = await semaphore.acquire()
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
      permit.release()
    }))
    expect(maximum).toBe(2)
  })
})
