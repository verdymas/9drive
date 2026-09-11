import { env } from '../../config/env.js'
import { inspectTempStorage } from './temp-storage.js'

export type TempStorageStage = 'downloading' | 'segments' | 'remuxing' | 'uploading'

export type TempStorageDiagnostics = {
  importId: string
  stage: TempStorageStage
  freeBytes: bigint
  reservedBytes: bigint
  requiredBytes: bigint
  reason: 'free_space_reserve'
}

export type TempReservationInput = {
  importId: string
  stage: TempStorageStage
  requiredBytes: bigint
  reserveBytes: bigint
}

export type TempReservation = {
  release(): void
}

export type TempReservationResult =
  | { admitted: true; reservation: TempReservation }
  | { admitted: false; diagnostics: TempStorageDiagnostics }

/**
 * Worker-process reservation ledger. `statfs` tells us what the filesystem
 * has free; the ledger closes the race between concurrent jobs in this worker
 * before any of them materialize data into the shared temp directory.
 */
export class TempStorageReservations {
  private reservedBytes = 0n

  constructor(private readonly inspect: () => Promise<{ freeBytes: bigint }> = inspectTempStorage) {}

  async tryAcquire(input: TempReservationInput): Promise<TempReservationResult> {
    const { freeBytes } = await this.inspect()
    const requiredBytes = input.requiredBytes > 0n ? input.requiredBytes : 0n
    const availableAfterExistingReservations = freeBytes - this.reservedBytes

    if (availableAfterExistingReservations - requiredBytes < input.reserveBytes) {
      return {
        admitted: false,
        diagnostics: {
          importId: input.importId,
          stage: input.stage,
          freeBytes,
          reservedBytes: this.reservedBytes,
          requiredBytes,
          reason: 'free_space_reserve',
        },
      }
    }

    this.reservedBytes += requiredBytes
    let released = false
    return {
      admitted: true,
      reservation: {
        release: () => {
          if (released) return
          released = true
          this.reservedBytes -= requiredBytes
        },
      },
    }
  }

  activeReservationBytes(): bigint {
    return this.reservedBytes
  }
}

export function estimateTempReservation(input: { sourceType: string | null | undefined; contentLength: bigint | null | undefined }): bigint {
  if (input.sourceType === 'hls_master' || input.sourceType === 'hls_media') {
    return BigInt(env.REMOTE_IMPORT_TEMP_HLS_RESERVATION_BYTES)
  }
  if (input.contentLength != null && input.contentLength > 0n) return input.contentLength
  return BigInt(env.REMOTE_IMPORT_TEMP_UNKNOWN_RESERVATION_BYTES)
}

export const tempStorageReservations = new TempStorageReservations()
