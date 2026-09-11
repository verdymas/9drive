import { describe, expect, it } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import { getStreamThroughEligibility, readVerifiedRange } from './stream-through.js'

describe('getStreamThroughEligibility', () => {
  it('allows only bounded, range-supported ordinary Google and S3 sources', () => {
    expect(
      getStreamThroughEligibility({
        sourceType: null,
        sourceRangeSupported: true,
        contentLength: 100n,
        provider: 'google_drive',
      }),
    ).toMatchObject({ eligible: true })

    expect(
      getStreamThroughEligibility({
        sourceType: null,
        sourceRangeSupported: true,
        contentLength: 100n,
        provider: 's3',
      }),
    ).toMatchObject({ eligible: true })
  })

  it('keeps HLS, Telegram, unknown sizes, and range-unsafe sources on the spool path', () => {
    expect(getStreamThroughEligibility({ sourceType: 'hls_media', sourceRangeSupported: true, contentLength: 100n, provider: 'google_drive' }))
      .toMatchObject({ eligible: false, reason: 'hls_source' })
    expect(getStreamThroughEligibility({ sourceType: null, sourceRangeSupported: true, contentLength: 100n, provider: 'telegram' }))
      .toMatchObject({ eligible: false, reason: 'provider_unsupported' })
    expect(getStreamThroughEligibility({ sourceType: null, sourceRangeSupported: false, contentLength: 100n, provider: 's3' }))
      .toMatchObject({ eligible: false, reason: 'source_range_unsupported' })
    expect(getStreamThroughEligibility({ sourceType: null, sourceRangeSupported: true, contentLength: null, provider: 's3' }))
      .toMatchObject({ eligible: false, reason: 'source_size_unknown' })
  })
})

describe('readVerifiedRange', () => {
  it('accepts only a matching 206 response and returns exactly the requested bytes', async () => {
    const fetcher = {
      fetch: async () => ({
        status: 206,
        headers: { 'content-range': 'bytes 5-8/20' },
        body: (async function* () {
          yield new Uint8Array([1, 2])
          yield new Uint8Array([3, 4])
        })(),
      }),
    }

    await expect(readVerifiedRange(fetcher, 'https://example.test/file', 5n, 4n, 20n)).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('rejects a source that advertises Range but ignores the requested range', async () => {
    const fetcher = {
      fetch: async () => ({
        status: 200,
        headers: { 'accept-ranges': 'bytes' },
        body: (async function* () { yield new Uint8Array([1, 2, 3, 4]) })(),
      }),
    }

    await expect(readVerifiedRange(fetcher, 'https://example.test/file', 5n, 4n, 20n)).rejects.toMatchObject<AppError>({ code: 'STREAM_SOURCE_RANGE_INVALID' })
  })
})
