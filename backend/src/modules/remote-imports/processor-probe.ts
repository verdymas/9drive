import { AppError } from '../../utils/app-error.js'
import type { RemoteImportProcessorContext } from './processor-context.js'

export type ProbeResult = {
  finalUrl: string
  contentLength: bigint | null
  sourceRangeSupported: boolean
}

export type ProbeFetcher = {
  fetch(input: any): Promise<any>
}

/** Probe a source with a one-byte range and enforce the configured size cap. */
export async function probeSource(
  context: Pick<RemoteImportProcessorContext, 'sourceUrl' | 'requestContext' | 'maxBytes'>,
  fetcher: ProbeFetcher,
): Promise<ProbeResult> {
  const response = await fetcher.fetch({
    method: 'GET',
    url: context.sourceUrl,
    headers: { Range: 'bytes=0-0' },
    range: 'bytes=0-0',
    requestContext: context.requestContext as any,
  })
  const contentRange = response.headers['content-range']
  const rangeMatch = /^bytes 0-0\/(\d+)$/.exec(contentRange ?? '')
  const length = rangeMatch?.[1] ?? response.headers['content-length']
  const sourceRangeSupported = response.status === 206 && rangeMatch != null

  // Drain one chunk to keep the probe cheap while allowing transports to
  // release their response resources cleanly.
  if (response.body) {
    const body = response.body as AsyncIterable<Uint8Array> | string
    if (typeof body !== 'string') {
      const reader = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      await reader.next().catch(() => undefined)
      await (reader as any).return?.().catch(() => undefined)
    }
  }

  const contentLength = length ? BigInt(length) : null
  if (contentLength != null && contentLength > context.maxBytes) {
    throw new AppError('DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.', 413)
  }

  return {
    finalUrl: response.finalUrl ?? context.sourceUrl,
    contentLength,
    sourceRangeSupported,
  }
}
