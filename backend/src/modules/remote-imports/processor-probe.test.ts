import { describe, expect, it, vi } from 'vitest'

import { AppError } from '../../utils/app-error.js'
import { probeSource } from './processor-probe.js'

describe('Remote Import probe phase', () => {
  it('returns the final URL, declared length, and exact-range capability', async () => {
    const context = {
      sourceUrl: 'https://source.test/file.bin',
      requestContext: undefined,
      maxBytes: 100n,
      updateStage: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    }
    const fetcher = {
      fetch: vi.fn().mockResolvedValue({
        status: 206,
        finalUrl: 'https://cdn.test/file.bin',
        headers: { 'content-range': 'bytes 0-0/42' },
        body: (async function* () { yield new Uint8Array([0]) })(),
      }),
    }

    await expect(probeSource(context, fetcher)).resolves.toEqual({
      finalUrl: 'https://cdn.test/file.bin',
      contentLength: 42n,
      sourceRangeSupported: true,
    })
    expect(fetcher.fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: context.sourceUrl,
      range: 'bytes=0-0',
    }))
  })

  it('rejects a declared size above the context maximum', async () => {
    const context = {
      sourceUrl: 'https://source.test/file.bin',
      requestContext: undefined,
      maxBytes: 10n,
      updateStage: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    }
    const fetcher = {
      fetch: vi.fn().mockResolvedValue({
        status: 206,
        headers: { 'content-range': 'bytes 0-0/11' },
        body: (async function* () { yield new Uint8Array([0]) })(),
      }),
    }

    await expect(probeSource(context, fetcher)).rejects.toMatchObject<AppError>({ code: 'DOWNLOAD_TOO_LARGE' })
  })
})
