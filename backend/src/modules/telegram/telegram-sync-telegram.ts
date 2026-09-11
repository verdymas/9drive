import type { TelegramClient } from 'teleproto'
import { env } from '../../config/env.js'
import { classifyTelegramError, parseTelegramRemoteId } from './telegram.service.js'
import type { FileByProviderFileId, RawTelegramDocument, TelegramDocument } from './telegram-sync-types.js'

/** Fetch captions for only the orphan documents missing page-level captions. */
export async function fetchMissingPageCaptions(
  client: TelegramClient,
  channel: unknown,
  documents: TelegramDocument[],
  fileByProviderFileId: FileByProviderFileId,
): Promise<Map<string, string | null>> {
  const captions = new Map<string, string | null>()
  const needingFetch = documents.filter(
    (document) => !fileByProviderFileId.has(document.remoteId) && (document.caption === null || document.caption === undefined),
  )
  if (needingFetch.length === 0) return captions

  const concurrency = env.TELEGRAM_SYNC_CAPTION_CONCURRENCY
  for (let i = 0; i < needingFetch.length; i += concurrency) {
    const chunk = needingFetch.slice(i, i + concurrency)
    await Promise.all(chunk.map(async (document) => {
      const caption = await fetchCaptionForRemoteId(client, channel, document.remoteId)
      captions.set(document.remoteId, caption)
    }))
  }
  return captions
}

/** Best-effort caption fetch; a failed lookup falls back to recovery ingest. */
export async function fetchCaptionForRemoteId(
  client: TelegramClient,
  channel: unknown,
  remoteId: string,
): Promise<string | null> {
  try {
    const { messageId } = parseTelegramRemoteId(remoteId)
    const messages = await client.getMessages(channel as never, { ids: [messageId] })
    const message = messages[0] as { message?: string } | undefined
    return message?.message ?? null
  } catch {
    return null
  }
}

/** Fetch a page with FloodWait-aware retries and bounded document output. */
export async function fetchPageWithRetries(
  client: TelegramClient,
  channel: unknown,
  opts: { minId: number; limit: number },
  maxRetries: number,
): Promise<RawTelegramDocument[]> {
  let attempt = 0
  for (;;) {
    try {
      const out: RawTelegramDocument[] = []
      for await (const message of (client as unknown as {
        iterMessages: (entity: unknown, options: { minId?: number; limit?: number; reverse?: boolean }) => AsyncIterable<unknown>
      }).iterMessages(channel, { minId: opts.minId, limit: opts.limit, reverse: true })) {
        const document = coerceTelegramDocument(message)
        if (!document) continue
        out.push(document)
        if (out.length >= opts.limit) break
      }
      return out
    } catch (error) {
      const classified = classifyTelegramError(error)
      if (classified.code !== 'TELEGRAM_FLOOD_WAIT' || attempt >= maxRetries) throw classified
      const seconds = extractFloodWaitSeconds(error) ?? 5
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, Math.min(seconds * 1000, 60_000)))
    }
  }
}

export function coerceTelegramDocument(message: unknown): RawTelegramDocument | null {
  const m = message as {
    id?: number | string
    document?: { attributes?: Array<{ fileName?: string | null }>; size?: number; mimeType?: string | null }
    message?: string
  }
  if (!m || typeof m !== 'object' || !m.document) return null
  if (typeof m.id !== 'number' && typeof m.id !== 'string') return null
  const id = typeof m.id === 'string' ? Number(m.id) : m.id
  if (!Number.isInteger(id) || id <= 0) return null
  const attributes = m.document.attributes ?? []
  const name = attributes.find((attribute) => attribute?.fileName)?.fileName
  return {
    messageId: id,
    name: name || `telegram-document-${id}`,
    size: m.document.size ?? 0,
    mimeType: m.document.mimeType ?? null,
    caption: typeof m.message === 'string' ? m.message : null,
  }
}

export function extractFloodWaitSeconds(error: unknown): number | null {
  const raw = error as { seconds?: number | string; message?: string; errorMessage?: string }
  if (typeof raw.seconds === 'number') return raw.seconds
  if (typeof raw.seconds === 'string' && /^\d+$/.test(raw.seconds)) return Number(raw.seconds)
  const text = String(raw.message ?? raw.errorMessage ?? '')
  const match = /FLOOD_WAIT[_ ]?(\d+)/i.exec(text)
  return match ? Number(match[1]) : null
}
