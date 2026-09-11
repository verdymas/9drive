import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config/env.js', () => ({
  env: {
    TELEGRAM_SYNC_CAPTION_CONCURRENCY: 2,
    TELEGRAM_SYNC_FLOOD_WAIT_RETRIES: 1,
  },
}))
vi.mock('./telegram.service.js', () => ({
  classifyTelegramError: (error: unknown) => error,
  parseTelegramRemoteId: (remoteId: string) => {
    const match = /telegram:\/\/([^/]+)\/(\d+)/.exec(remoteId)
    return { channelId: match?.[1] ?? '', messageId: Number(match?.[2] ?? 0) }
  },
}))

import { extractFloodWaitSeconds, fetchPageWithRetries } from './telegram-sync-telegram.js'

describe('Telegram sync network boundary', () => {
  it('extracts FloodWait seconds from structured and encoded errors', () => {
    expect(extractFloodWaitSeconds({ seconds: '12' })).toBe(12)
    expect(extractFloodWaitSeconds({ message: 'FLOOD_WAIT_7' })).toBe(7)
    expect(extractFloodWaitSeconds({ message: 'unrelated' })).toBeNull()
  })

  it('retries a page once for a FloodWait and returns only document messages', async () => {
    let attempts = 0
    const client = {
      iterMessages: vi.fn(() => {
        attempts += 1
        if (attempts === 1) throw { code: 'TELEGRAM_FLOOD_WAIT', seconds: 0 }
        return (async function* () {
          yield { id: 4, document: { size: 9, mimeType: 'text/plain', attributes: [{ fileName: 'note.txt' }] } }
          yield { id: 5, message: 'not a document' }
        })()
      }),
    }

    await expect(fetchPageWithRetries(client as any, {}, { minId: 3, limit: 10 }, 1)).resolves.toEqual([
      { messageId: 4, name: 'note.txt', size: 9, mimeType: 'text/plain', caption: null },
    ])
    expect(client.iterMessages).toHaveBeenCalledTimes(2)
  })
})
