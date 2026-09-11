/**
 * The disk-free direct-import fast path is deliberately narrow. It must be
 * able to restart an acknowledged byte offset without trusting a source that
 * might ignore a Range request, and it never changes HLS/Telegram behavior.
 */
import { AppError } from '../../utils/app-error.js'
export type StreamThroughEligibilityInput = {
  sourceType: string | null | undefined
  sourceRangeSupported: boolean
  contentLength: bigint | null | undefined
  provider: string
}

export type StreamThroughEligibility =
  | { eligible: true }
  | {
      eligible: false
      reason: 'hls_source' | 'provider_unsupported' | 'source_range_unsupported' | 'source_size_unknown'
    }

export function getStreamThroughEligibility(input: StreamThroughEligibilityInput): StreamThroughEligibility {
  if (input.sourceType === 'hls_master' || input.sourceType === 'hls_media') {
    return { eligible: false, reason: 'hls_source' }
  }
  if (input.provider !== 'google_drive' && input.provider !== 's3') {
    return { eligible: false, reason: 'provider_unsupported' }
  }
  if (!input.sourceRangeSupported) {
    return { eligible: false, reason: 'source_range_unsupported' }
  }
  if (input.contentLength == null || input.contentLength <= 0n) {
    return { eligible: false, reason: 'source_size_unknown' }
  }
  return { eligible: true }
}

type RangeFetcher = {
  fetch(input: {
    method: 'GET'
    url: string
    headers: { Range: string }
    range: string
    requestContext?: unknown
  }): Promise<{
    status: number
    headers: Record<string, string | undefined>
    body: AsyncIterable<Uint8Array> | string
  }>
}

function rangeFailure() {
  return new AppError('STREAM_SOURCE_RANGE_INVALID', 'The remote source did not honor a required byte range.', 502)
}

/**
 * Fetch one bounded, restartable source slice. A 206 response and exact
 * Content-Range are required; an `Accept-Ranges` header alone is not proof
 * that a retry can safely resume.
 */
export async function readVerifiedRange(
  fetcher: RangeFetcher,
  sourceUrl: string,
  offset: bigint,
  length: bigint,
  totalBytes: bigint,
  requestContext?: unknown,
): Promise<Buffer> {
  if (offset < 0n || length <= 0n || offset + length > totalBytes) throw rangeFailure()
  const end = offset + length - 1n
  const range = `bytes=${offset}-${end}`
  const response = await fetcher.fetch({ method: 'GET', url: sourceUrl, headers: { Range: range }, range, requestContext })
  const expected = `bytes ${offset}-${end}/${totalBytes}`
  if (response.status !== 206 || response.headers['content-range'] !== expected) {
    const body = response.body
    if (typeof body !== 'string') await body[Symbol.asyncIterator]().return?.().catch(() => undefined)
    throw rangeFailure()
  }

  const chunks: Buffer[] = []
  let bytes = 0n
  const responseBody = response.body
  const body: AsyncIterable<Uint8Array> = typeof responseBody === 'string'
    ? (async function* () { yield Buffer.from(responseBody) })()
    : responseBody
  const iterator = body[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      bytes += BigInt(chunk.byteLength)
      if (bytes > length) throw rangeFailure()
      chunks.push(chunk)
    }
  } finally {
    await iterator.return?.().catch(() => undefined)
  }
  if (bytes !== length) throw rangeFailure()
  return Buffer.concat(chunks)
}
