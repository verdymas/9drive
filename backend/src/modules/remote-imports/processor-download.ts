import { AppError } from '../../utils/app-error.js'
import { hopHeaderResolver } from './request-context.js'
import { createTempPartFile, appendStreamToTemp } from './temp-storage.js'
import { followRemoteUrl } from './url-downloader.js'
import { STAGES, type RemoteImportProcessorContext } from './processor-context.js'
import type { SecureRemoteFetcher } from './secure-fetcher.js'

export type DownloadedSource = {
  finalUrl: string
  tempPartPath: string
  contentLength: bigint | null
  supportsRange: boolean
}

/** Fetch and stream a remote URL into a session-scoped temp part file. */
export async function downloadSourceToTemp(
  context: RemoteImportProcessorContext,
  fetcher?: SecureRemoteFetcher | null,
  startUrl = context.sourceUrl,
): Promise<DownloadedSource> {
  const partPath = await createTempPartFile(context.importId)
  let supportsRange = false
  let contentLength: bigint | null = null
  let finalUrl = startUrl
  let totalBytes = 0n

  if (fetcher) {
    const response = await fetcher.fetch({ method: 'GET', url: startUrl, requestContext: context.requestContext as any } as any)
    const rawLength = response.headers['content-length']
    if (rawLength) contentLength = BigInt(rawLength)
    supportsRange = response.headers['accept-ranges'] === 'bytes' || response.status === 206
    if (response.status >= 400) throw new AppError('DOWNLOAD_HTTP_ERROR', `Remote server responded ${response.status}.`, 502)
    finalUrl = (response as any).finalUrl ?? startUrl
    const fileStream = appendStreamToTemp(partPath)
    const writeProgress = context.throttledProgressUpdater(STAGES.DOWNLOADING)
    try {
      const iterable = typeof response.body === 'string'
        ? (async function* () { yield Buffer.from(response.body as string) })()
        : response.body as AsyncIterable<Uint8Array>
      for await (const chunk of iterable) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        totalBytes += BigInt(buf.byteLength)
        if (totalBytes > context.maxBytes) {
          fileStream.destroy()
          throw new AppError('DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.', 413)
        }
        if (!fileStream.write(buf)) await new Promise<void>((resolve) => fileStream.once('drain', resolve))
        await writeProgress({ downloadedBytes: totalBytes.toString() })
      }
      await context.updateStage(STAGES.DOWNLOADING, { downloadedBytes: totalBytes.toString() })
      await new Promise<void>((resolve, reject) => fileStream.end((error: Error | null) => (error ? reject(error) : resolve())))
    } catch (error) {
      fileStream.destroy()
      throw error
    }
    await context.updateStage(STAGES.VERIFYING, { downloadedBytes: totalBytes.toString() })
    return { finalUrl, tempPartPath: partPath, contentLength, supportsRange }
  }

  await followRemoteUrl(startUrl, {
    getHopHeaders: hopHeaderResolver(startUrl, context.requestContext),
    onResponse: async (response) => {
      const rawLength = response.headers['content-length']
      if (rawLength) contentLength = BigInt(rawLength)
      supportsRange = response.headers['accept-ranges'] === 'bytes' || response.statusCode === 206
      if (response.statusCode >= 400) throw new AppError('DOWNLOAD_HTTP_ERROR', `Remote server responded ${response.statusCode}.`, 502)
      if (typeof (response.body as { on?: unknown }).on === 'function') {
        (response.body as unknown as { on: (event: 'error', listener: () => void) => void }).on('error', () => undefined)
      }
      const fileStream = appendStreamToTemp(partPath)
      const writeProgress = context.throttledProgressUpdater(STAGES.DOWNLOADING)
      try {
        for await (const chunk of response.body) {
          totalBytes += BigInt(chunk.byteLength)
          if (totalBytes > context.maxBytes) {
            fileStream.destroy()
            throw new AppError('DOWNLOAD_TOO_LARGE', 'The remote file exceeds the maximum allowed size.', 413)
          }
          if (!fileStream.write(chunk)) await new Promise<void>((resolve) => fileStream.once('drain', resolve))
          await writeProgress({ downloadedBytes: totalBytes.toString() })
        }
        await context.updateStage(STAGES.DOWNLOADING, { downloadedBytes: totalBytes.toString() })
        await new Promise<void>((resolve, reject) => fileStream.end((error: Error | null) => (error ? reject(error) : resolve())))
      } catch (error) {
        fileStream.destroy()
        throw error
      }
      return { finalUrl, contentLength, supportsRange }
    },
  })
  await context.updateStage(STAGES.VERIFYING, { downloadedBytes: totalBytes.toString() })
  return { finalUrl, tempPartPath: partPath, contentLength, supportsRange }
}
