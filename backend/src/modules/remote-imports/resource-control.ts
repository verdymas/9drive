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
  resourceControls: HlsResourceDiagnostics
}

/** Snapshot included with capacity deferrals so operators can correlate a
 * constrained temp volume with concurrent HLS network/conversion activity. */
export type HlsResourceDiagnostics = {
  hlsSegmentPermits: PermitDiagnostics
  ffmpegPermits: PermitDiagnostics
}

export type PermitDiagnostics = {
  limit: number
  active: number
  waiting: number
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

  constructor(
    private readonly inspect: () => Promise<{ freeBytes: bigint }> = inspectTempStorage,
    private readonly resourceDiagnostics: () => HlsResourceDiagnostics = getHlsResourceDiagnostics,
  ) {}

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
          resourceControls: this.resourceDiagnostics(),
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

export type SemaphorePermit = { release(): void }

/** FIFO permit queue with abortable waiters and idempotent releases. */
export class FairSemaphore {
  private active = 0
  private readonly waiters: Array<{
    resolve: (permit: SemaphorePermit) => void
    reject: (error: Error) => void
    signal?: AbortSignal
    abort?: () => void
  }> = []

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be a positive integer.')
  }

  acquire(options: { signal?: AbortSignal } = {}): Promise<SemaphorePermit> {
    if (options.signal?.aborted) return Promise.reject(this.abortError())
    return new Promise<SemaphorePermit>((resolve, reject) => {
      const waiter = { resolve, reject, signal: options.signal } as (typeof this.waiters)[number]
      const start = () => {
        this.active += 1
        waiter.signal?.removeEventListener('abort', waiter.abort!)
        let released = false
        resolve({ release: () => {
          if (released) return
          released = true
          this.active -= 1
          this.drain()
        } })
      }
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(this.abortError())
      }
      if (this.active < this.limit && this.waiters.length === 0) {
        start()
        return
      }
      options.signal?.addEventListener('abort', waiter.abort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private drain() {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (waiter.signal?.aborted) {
        waiter.signal.removeEventListener('abort', waiter.abort!)
        waiter.reject(this.abortError())
        continue
      }
      this.active += 1
      waiter.signal?.removeEventListener('abort', waiter.abort!)
      let released = false
      waiter.resolve({ release: () => {
        if (released) return
        released = true
        this.active -= 1
        this.drain()
      } })
    }
  }

  private abortError() {
    const error = new Error('The operation was cancelled while waiting for a resource permit.')
    error.name = 'AbortError'
    return error
  }

  diagnostics(): PermitDiagnostics {
    return { limit: this.limit, active: this.active, waiting: this.waiters.length }
  }
}

export const hlsSegmentPermits = new FairSemaphore(env.REMOTE_IMPORT_HLS_GLOBAL_SEGMENT_CONCURRENCY)
export const ffmpegPermits = new FairSemaphore(env.REMOTE_IMPORT_HLS_FFMPEG_CONCURRENCY)

export function getHlsResourceDiagnostics(): HlsResourceDiagnostics {
  return {
    hlsSegmentPermits: hlsSegmentPermits.diagnostics(),
    ffmpegPermits: ffmpegPermits.diagnostics(),
  }
}
