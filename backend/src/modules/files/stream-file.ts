import type { ConnectedAccount, File } from '@prisma/client'
import type { Response } from 'express'
import { streamGoogleFile } from './stream-google-file.js'
import { streamS3File } from '../s3/s3.service.js'
import { streamTelegramFile } from '../telegram/telegram.service.js'
import { telegramStreamGateway } from '../telegram/telegram-stream-gateway.js'
import { isTelegramStreamConfigured } from '../telegram/telegram-stream-auth.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

export function streamProviderFile(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  if (file.provider === 's3') return streamS3File(file, range, res, options)
  if (file.provider === 'telegram') {
    // Prefer the streaming gateway when it's configured; fall back to
    // the legacy full-GET path so the REST API still works when the
    // service is offline (Phase 07 wires the WebDAV path; Phase 09
    // makes the service a compose dependency).
    if (isTelegramStreamConfigured()) {
      return telegramStreamGateway.streamFile(file, range, res, options)
    }
    return streamTelegramFile(file, range, res, options)
  }
  return streamGoogleFile(file, range, res, options)
}
