import { describe, expect, it } from 'vitest'
import { estimateTempReservation, TempStorageReservations } from './resource-control.js'

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
