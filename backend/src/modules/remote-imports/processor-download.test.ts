import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createTempPartFile: vi.fn(async () => 'temp.part'),
  appendStreamToTemp: vi.fn(() => ({
    write: vi.fn(() => true),
    end: (callback: (error?: Error | null) => void) => callback(null),
    destroy: vi.fn(),
    once: vi.fn(),
  })),
}))

vi.mock('./temp-storage.js', () => ({
  createTempPartFile: h.createTempPartFile,
  appendStreamToTemp: h.appendStreamToTemp,
  inspectTempStorage: vi.fn(async () => ({ freeBytes: 1_000_000n })),
}))

import { downloadSourceToTemp } from './processor-download.js'

describe('downloadSourceToTemp', () => {
  it('enforces the context byte cap before writing an oversized response', async () => {
    const context = {
      importId: 'import-1',
      maxBytes: 2n,
      sourceUrl: 'https://example.test/file',
      updateStage: vi.fn(async () => undefined),
      throttledProgressUpdater: vi.fn(() => vi.fn(async () => undefined)),
    }
    const fetcher = {
      fetch: vi.fn(async () => ({
        status: 200,
        headers: {},
        body: (async function* () { yield new Uint8Array([1, 2, 3]) })(),
      })),
    }

    await expect(downloadSourceToTemp(context as any, fetcher as any)).rejects.toMatchObject({ code: 'DOWNLOAD_TOO_LARGE' })
  })
})
