import type { ConnectedAccount, File } from '@prisma/client'
import type { Response } from 'express'
import { streamGoogleFile } from './stream-google-file.js'
import { streamS3File } from '../s3/s3.service.js'
import { streamTelegramFile } from '../telegram/telegram.service.js'
import { telegramStreamGateway } from '../telegram/telegram-stream-gateway.js'
import { isTelegramStreamConfigured } from '../telegram/telegram-stream-auth.js'
import { writeProxyOpenError } from './file-delivery.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

export async function streamProviderFile(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  const abort = new AbortController()
  const abortOnClose = () => {
    if (!res.writableEnded) abort.abort()
  }
  res.once('close', abortOnClose)
  try {
    if (file.provider === 's3') return await streamS3File(file, range, res, options, abort.signal)
    if (file.provider === 'telegram') {
      // Prefer the streaming gateway when it's configured; fall back to
      // the legacy full-GET path so the REST API still works when the
      // service is offline (Phase 07 wires the WebDAV path; Phase 09
      // makes the service a compose dependency).
      if (isTelegramStreamConfigured()) {
        return await telegramStreamGateway.streamFile(file, range, res, options)
      }
      return await streamTelegramFile(file, range, res, options)
    }
    return await streamGoogleFile(file, range, res, options, abort.signal)
  } catch (error) {
    if (abort.signal.aborted) return
    writeProxyOpenError(res)
  } finally {
    res.off('close', abortOnClose)
  }
}
